"""
Core Python graph walker. `ast` gives syntax only, not a type checker's semantic model, so
unlike indexer-dotnet (Roslyn) / indexer-typescript (TS Compiler API), CALLS resolution here is
a name/import-based heuristic rather than fully resolved — see the four cases handled in
`_resolve_call` below. This is a deliberate, documented trade-off (see docs/architecture.md).

Two passes over the whole set of owned files:
  1. `_collect` builds a GlobalRegistry of every class/function/method id, plus per-class
     "self.attr -> attribute's declared type" maps (for resolving constructor-injection-style
     cross-class calls) — order-independent, so no dependency ordering is needed the way
     indexer-dotnet needs a topological project sort.
  2. `_emit` walks each file again, now able to resolve calls against the whole project's
     registry, and writes symbol/edge records.
"""

import ast
import hashlib

from import_resolver import collect_import_bindings
from models import edge_record, file_record, symbol_record
from symbol_utils import (
    build_owned_id,
    get_annotation_type_name,
    get_decorator_names,
    get_doc_summary,
    get_function_kind,
    get_modifiers,
    render_class_signature,
    render_function_signature,
)


class GlobalRegistry:
    def __init__(self):
        self.classes_by_file = {}  # rel_path -> {class_name: class_id}
        self.functions_by_file = {}  # rel_path -> {func_name: func_id}
        self.methods_by_class_id = {}  # class_id -> {method_name: method_id}
        self.self_attr_types_by_class_id = {}  # class_id -> {attr_name: target_class_id}


class FileContext:
    def __init__(self, rel_path, tree, imports, source_bytes):
        self.rel_path = rel_path
        self.tree = tree
        self.imports = imports
        self.source_bytes = source_bytes


def _method_defs(class_node):
    return [n for n in class_node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


def _infer_self_attr_types(class_node, class_id, rel_path, imports, registry):
    """Scans __init__ for `self.attr = <param>` / `self.attr: Type = ...` so a later call like
    `self.attr.method()` elsewhere in the class can be resolved — the Python analogue of the
    constructor-injection edges the C#/TS indexers extract from typed constructor parameters."""
    init = next((m for m in _method_defs(class_node) if m.name == "__init__"), None)
    if init is None:
        return

    param_types = {}
    for arg in init.args.args:
        if arg.annotation is not None:
            type_name = get_annotation_type_name(arg.annotation)
            if type_name:
                param_types[arg.arg] = type_name

    attr_types = {}
    for stmt in ast.walk(init):
        target_name = None
        type_name = None
        if isinstance(stmt, ast.AnnAssign) and _is_self_attr(stmt.target):
            target_name = stmt.target.attr
            type_name = get_annotation_type_name(stmt.annotation)
        elif isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and _is_self_attr(stmt.targets[0]):
            target_name = stmt.targets[0].attr
            value = stmt.value
            if isinstance(value, ast.Name) and value.id in param_types:
                type_name = param_types[value.id]
            elif isinstance(value, ast.Call):
                type_name = get_annotation_type_name(value.func)

        if target_name and type_name:
            resolved_id = _resolve_type_name_to_class_id(type_name, rel_path, imports, registry)
            if resolved_id:
                attr_types[target_name] = resolved_id

    if attr_types:
        registry.self_attr_types_by_class_id[class_id] = attr_types


def _is_self_attr(node):
    return isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self"


def _resolve_type_name_to_class_id(type_name, rel_path, imports, registry):
    if type_name in registry.classes_by_file.get(rel_path, {}):
        return registry.classes_by_file[rel_path][type_name]
    binding = imports.get(type_name)
    if binding and binding.kind == "symbol":
        return registry.classes_by_file.get(binding.rel_path, {}).get(binding.original_name)
    return None


def collect(file_contexts, repo_root):
    registry = GlobalRegistry()
    for ctx in file_contexts:
        classes = {}
        functions = {}
        for node in ctx.tree.body:
            if isinstance(node, ast.ClassDef):
                class_id = build_owned_id(ctx.rel_path, node.name)
                classes[node.name] = class_id
                registry.methods_by_class_id[class_id] = {
                    m.name: build_owned_id(ctx.rel_path, f"{node.name}.{m.name}") for m in _method_defs(node)
                }
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions[node.name] = build_owned_id(ctx.rel_path, node.name)
        registry.classes_by_file[ctx.rel_path] = classes
        registry.functions_by_file[ctx.rel_path] = functions

    for ctx in file_contexts:
        for node in ctx.tree.body:
            if isinstance(node, ast.ClassDef):
                class_id = registry.classes_by_file[ctx.rel_path][node.name]
                _infer_self_attr_types(node, class_id, ctx.rel_path, ctx.imports, registry)

    return registry


def _resolve_call(call, rel_path, current_class_id, imports, registry):
    """Four resolvable shapes, in order of how much context they need; anything else (e.g. a
    call through a variable of unknown/uninferred type) is left unresolved rather than guessed."""
    func = call.func

    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id == "self":
        if current_class_id:
            methods = registry.methods_by_class_id.get(current_class_id, {})
            if func.attr in methods:
                return methods[func.attr]
        return None

    if (
        isinstance(func, ast.Attribute)
        and isinstance(func.value, ast.Attribute)
        and isinstance(func.value.value, ast.Name)
        and func.value.value.id == "self"
    ):
        if current_class_id:
            attr_types = registry.self_attr_types_by_class_id.get(current_class_id, {})
            target_class_id = attr_types.get(func.value.attr)
            if target_class_id:
                return registry.methods_by_class_id.get(target_class_id, {}).get(func.attr)
        return None

    if isinstance(func, ast.Name):
        same_file_fn = registry.functions_by_file.get(rel_path, {}).get(func.id)
        if same_file_fn:
            return same_file_fn
        binding = imports.get(func.id)
        if binding and binding.kind == "symbol":
            return registry.functions_by_file.get(binding.rel_path, {}).get(binding.original_name)
        return None

    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        binding = imports.get(func.value.id)
        if binding and binding.kind == "module":
            return registry.functions_by_file.get(binding.rel_path, {}).get(func.attr)
        return None

    return None


class PythonGraphBuilder:
    def __init__(self, repo_root, writer, external_symbols, registry):
        self.repo_root = repo_root
        self.writer = writer
        self.external_symbols = external_symbols
        self.registry = registry

    def process(self, ctx):
        self._emit_file_record(ctx)
        for node in ctx.tree.body:
            if isinstance(node, ast.ClassDef):
                self._emit_class(node, ctx)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self._emit_function(node, ctx, class_id=None)
        self._emit_import_edges(ctx)

    def _emit_file_record(self, ctx):
        content_hash = hashlib.sha256(ctx.source_bytes).hexdigest()
        self.writer(file_record(ctx.rel_path, "python", content_hash, len(ctx.source_bytes)))

    def _emit_class(self, node, ctx):
        class_id = self.registry.classes_by_file[ctx.rel_path][node.name]
        self.writer(
            symbol_record(
                class_id,
                node.name,
                "Class",
                render_class_signature(node),
                ctx.rel_path,
                node.lineno,
                node.end_lineno,
                doc_summary=get_doc_summary(node),
                start_col=node.col_offset + 1,
                end_col=(node.end_col_offset or 0) + 1,
                modifiers=get_modifiers(node, node.name),
            )
        )
        self.writer(edge_record("DEFINES", ctx.rel_path, class_id))

        for base in node.bases:
            base_name = base.id if isinstance(base, ast.Name) else getattr(base, "attr", None)
            if not base_name:
                continue
            base_id = self._resolve_class_reference(base_name, ctx)
            if base_id:
                self.writer(edge_record("EXTENDS", class_id, base_id))

        for method in _method_defs(node):
            self._emit_function(method, ctx, class_id=class_id)

    def _resolve_class_reference(self, type_name, ctx):
        local = ctx.imports.get(type_name)
        if type_name in self.registry.classes_by_file.get(ctx.rel_path, {}):
            return self.registry.classes_by_file[ctx.rel_path][type_name]
        if local and local.kind == "symbol":
            resolved = self.registry.classes_by_file.get(local.rel_path, {}).get(local.original_name)
            if resolved:
                return resolved
        # Not one of our own classes (e.g. a stdlib/third-party base like `Exception`) — a
        # readable external stub rather than a dangling edge target.
        group_key = local.rel_path if local else "builtins"
        return self.external_symbols.get_or_register(
            id=f"python:external:{group_key}#{type_name}",
            name=type_name,
            kind="Class",
            signature=type_name,
            group_key=group_key,
        )

    def _emit_function(self, node, ctx, class_id):
        is_method = class_id is not None
        qualified_name = f"{self._class_name_of(class_id, ctx)}.{node.name}" if is_method else node.name
        fn_id = build_owned_id(ctx.rel_path, qualified_name)

        self.writer(
            symbol_record(
                fn_id,
                node.name,
                get_function_kind(node, is_method),
                render_function_signature(node),
                ctx.rel_path,
                node.lineno,
                node.end_lineno,
                doc_summary=get_doc_summary(node),
                start_col=node.col_offset + 1,
                end_col=(node.end_col_offset or 0) + 1,
                modifiers=get_modifiers(node, node.name),
            )
        )
        self.writer(edge_record("DEFINES", ctx.rel_path, fn_id))

        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            target_id = _resolve_call(call, ctx.rel_path, class_id, ctx.imports, self.registry)
            if target_id:
                self.writer(edge_record("CALLS", fn_id, target_id, line=call.lineno, col=call.col_offset + 1))

    def _class_name_of(self, class_id, ctx):
        for name, cid in self.registry.classes_by_file.get(ctx.rel_path, {}).items():
            if cid == class_id:
                return name
        return "?"

    def _emit_import_edges(self, ctx):
        seen = set()
        for binding in ctx.imports.values():
            if binding.rel_path in seen:
                continue
            seen.add(binding.rel_path)
            self.writer(edge_record("IMPORTS", ctx.rel_path, binding.rel_path))
