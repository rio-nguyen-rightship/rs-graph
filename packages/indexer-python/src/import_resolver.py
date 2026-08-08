"""Resolves Python import statements to repo-relative paths, using plain filesystem checks
against the repo root as the assumed top-level package root — a pragmatic heuristic (real
Python import resolution can involve namespace packages and sys.path tricks) that matches the
common convention of indexing from a project's root or a single `src`-like root.
"""

import ast
import os


def _to_rel_path(abs_path, repo_root):
    return os.path.relpath(abs_path, repo_root).replace("\\", "/")


def _resolve_module_dir(candidate_dir):
    if os.path.isfile(candidate_dir + ".py"):
        return candidate_dir + ".py"
    init_file = os.path.join(candidate_dir, "__init__.py")
    if os.path.isfile(init_file):
        return init_file
    return None


def resolve_absolute_module(module_dotted, repo_root):
    if not module_dotted:
        return None
    resolved = _resolve_module_dir(os.path.join(repo_root, *module_dotted.split(".")))
    return _to_rel_path(resolved, repo_root) if resolved else None


def resolve_relative_module(level, module_dotted, current_file_rel_path, repo_root):
    base_dir = os.path.dirname(os.path.join(repo_root, current_file_rel_path))
    for _ in range(level - 1):
        base_dir = os.path.dirname(base_dir)
    candidate_dir = os.path.join(base_dir, *module_dotted.split(".")) if module_dotted else base_dir
    resolved = _resolve_module_dir(candidate_dir)
    return _to_rel_path(resolved, repo_root) if resolved else None


class ImportBinding:
    """A local name bound by an import statement.

    kind="module": the local name refers to a whole module (e.g. `import foo as f`, then
    `f.bar()` calls `bar` inside that module).
    kind="symbol": the local name refers to one name imported from a module (e.g.
    `from foo import Bar`), so `Bar` might be a class or function defined in that module.
    """

    def __init__(self, kind, rel_path, original_name=None):
        self.kind = kind
        self.rel_path = rel_path
        self.original_name = original_name


def collect_import_bindings(tree, rel_path, repo_root):
    bindings = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                local_name = alias.asname or alias.name.split(".")[0]
                resolved = resolve_absolute_module(alias.name, repo_root)
                if resolved:
                    bindings[local_name] = ImportBinding("module", resolved)
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                resolved_module = resolve_relative_module(node.level, node.module, rel_path, repo_root)
            else:
                resolved_module = resolve_absolute_module(node.module, repo_root)
            if not resolved_module:
                continue
            for alias in node.names:
                local_name = alias.asname or alias.name
                bindings[local_name] = ImportBinding("symbol", resolved_module, alias.name)
    return bindings
