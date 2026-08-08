"""Shared helpers for turning a Python ast node into our wire format: a stable id, a
one-line signature, the docstring summary, modifiers, and our SymbolKind string."""

import ast


def build_owned_id(rel_path, qualified_name):
    return f"python:{rel_path}#{qualified_name}"


def get_doc_summary(node):
    doc = ast.get_docstring(node)
    if not doc:
        return None
    for line in doc.splitlines():
        line = line.strip()
        if line:
            return line
    return None


def get_decorator_names(node):
    names = []
    for dec in getattr(node, "decorator_list", []):
        target = dec.func if isinstance(dec, ast.Call) else dec
        if isinstance(target, ast.Attribute):
            names.append(target.attr)
        elif isinstance(target, ast.Name):
            names.append(target.id)
    return names


def get_modifiers(node, name):
    if name.startswith("__") and name.endswith("__"):
        modifiers = ["public"]  # dunder methods (__init__, __str__, ...) are part of the public protocol
    elif name.startswith("__"):
        modifiers = ["private"]
    elif name.startswith("_"):
        modifiers = ["protected"]
    else:
        modifiers = ["public"]

    decorators = get_decorator_names(node)
    if "staticmethod" in decorators:
        modifiers.append("static")
    if "classmethod" in decorators:
        modifiers.append("classmethod")
    if isinstance(node, ast.AsyncFunctionDef):
        modifiers.append("async")
    return modifiers


def _unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return "?"


def render_function_signature(node):
    args = node.args
    parts = []
    defaults_offset = len(args.args) - len(args.defaults)
    for i, arg in enumerate(args.args):
        text = arg.arg
        if arg.annotation is not None:
            text += f": {_unparse(arg.annotation)}"
        default_index = i - defaults_offset
        if default_index >= 0:
            text += f" = {_unparse(args.defaults[default_index])}"
        parts.append(text)

    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    signature = f"{prefix} {node.name}({', '.join(parts)})"
    if node.returns is not None:
        signature += f" -> {_unparse(node.returns)}"
    return signature


def render_class_signature(node):
    bases = [_unparse(base) for base in node.bases]
    return f"class {node.name}({', '.join(bases)})" if bases else f"class {node.name}"


def get_function_kind(node, is_method):
    if not is_method:
        return "Function"
    return "Property" if "property" in get_decorator_names(node) else "Method"


def get_annotation_type_name(annotation):
    """Best-effort extraction of a simple type name from a parameter/attribute annotation —
    e.g. `IGreeter` from `greeter: IGreeter`, or `IGreeter` from `Optional[IGreeter]`."""
    if isinstance(annotation, ast.Name):
        return annotation.id
    if isinstance(annotation, ast.Attribute):
        return annotation.attr
    if isinstance(annotation, ast.Subscript):
        return get_annotation_type_name(annotation.value)
    return None
