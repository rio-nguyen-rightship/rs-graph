#!/usr/bin/env python
"""CLI entry point: discover .py files, parse (static analysis only — never invokes pip/a
build), and emit NDJSON matching core-schema's GraphRecord shape to stdout."""

import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from external_registry import ExternalSymbolRegistry  # noqa: E402
from graph_builder import FileContext, PythonGraphBuilder, collect  # noqa: E402
from import_resolver import collect_import_bindings  # noqa: E402
from route_enrichment import RouteEnricher  # noqa: E402

IGNORED_DIR_NAMES = {
    "node_modules",
    "bin",
    "obj",
    "dist",
    ".git",
    ".rs-graph",
    "__pycache__",
    "venv",
    ".venv",
    "site-packages",
    ".mypy_cache",
    ".pytest_cache",
}


def discover_py_files(target_path):
    if os.path.isfile(target_path):
        return [os.path.abspath(target_path)]

    results = []
    for root, dirs, files in os.walk(target_path):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIR_NAMES and not d.startswith(".")]
        for f in files:
            if f.endswith(".py"):
                results.append(os.path.abspath(os.path.join(root, f)))
    return results


def to_rel_path(abs_path, repo_root):
    return os.path.relpath(abs_path, repo_root).replace("\\", "/")


def build_file_contexts(py_files, repo_root):
    file_contexts = []
    for abs_path in py_files:
        rel_path = to_rel_path(abs_path, repo_root)
        with open(abs_path, "rb") as f:
            source_bytes = f.read()
        try:
            tree = ast.parse(source_bytes, filename=rel_path)
        except SyntaxError as e:
            print(f"warn: could not parse {rel_path}: {e}", file=sys.stderr)
            continue
        imports = collect_import_bindings(tree, rel_path, repo_root)
        file_contexts.append(FileContext(rel_path, tree, imports, source_bytes))
    return file_contexts


def run(target_path, repo_root, writer):
    py_files = discover_py_files(target_path)
    if not py_files:
        print(f"No .py files found under {target_path}", file=sys.stderr)
        return

    file_contexts = build_file_contexts(py_files, repo_root)
    registry = collect(file_contexts, repo_root)

    external_symbols = ExternalSymbolRegistry("python", lambda group_key: f"external:{group_key}")
    builder = PythonGraphBuilder(repo_root, writer, external_symbols, registry)
    route_enricher = RouteEnricher(writer, registry)

    for ctx in file_contexts:
        builder.process(ctx)
        route_enricher.process(ctx)

    for record in external_symbols.flush():
        writer(record)


def main():
    if len(sys.argv) < 2:
        print("usage: main.py <path-to-directory-or-.py-file> [repoRoot]", file=sys.stderr)
        sys.exit(1)

    target_path = os.path.abspath(sys.argv[1])
    repo_root = (
        os.path.abspath(sys.argv[2])
        if len(sys.argv) > 2
        else (target_path if os.path.isdir(target_path) else os.path.dirname(target_path))
    )

    def writer(record):
        print(json.dumps(record))

    run(target_path, repo_root, writer)


if __name__ == "__main__":
    main()
