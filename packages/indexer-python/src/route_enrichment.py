"""Flask/FastAPI decorator-based route extraction, plus a Django urlpatterns heuristic."""

import ast

from models import edge_record, route_record

HTTP_VERBS = {"get", "post", "put", "delete", "patch"}


class RouteEnricher:
    def __init__(self, writer, registry):
        self.writer = writer
        self.registry = registry

    def process(self, ctx):
        self._process_decorators(ctx)
        self._process_django_urlpatterns(ctx)

    def _process_decorators(self, ctx):
        for node in ast.walk(ctx.tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                match = self._match_route_decorator(dec)
                if match is None:
                    continue
                verb, path_arg = match
                handler_id = self.registry.functions_by_file.get(ctx.rel_path, {}).get(node.name)
                if handler_id is None:
                    continue
                self._emit_route(verb, path_arg, handler_id, node, ctx)

    def _match_route_decorator(self, dec):
        """Matches `@<anything>.get/post/put/delete/patch("/path")` (Flask 2.x+ and FastAPI
        shorthand) and `@<anything>.route("/path", methods=[...])` (classic Flask)."""
        if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
            return None
        path_arg = None
        if dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
            path_arg = dec.args[0].value
        if path_arg is None:
            return None

        attr = dec.func.attr
        if attr in HTTP_VERBS:
            return attr.upper(), path_arg
        if attr == "route":
            for kw in dec.keywords:
                if kw.arg == "methods" and isinstance(kw.value, ast.List):
                    methods = [el.value for el in kw.value.elts if isinstance(el, ast.Constant)]
                    if methods:
                        return str(methods[0]).upper(), path_arg
            return "GET", path_arg
        return None

    def _emit_route(self, verb, path_arg, handler_id, node, ctx):
        route_id = f"python:route:{handler_id}"
        self.writer(
            route_record(
                route_id,
                f"{verb} {path_arg}",
                f'@...{verb.lower()}("{path_arg}")',
                ctx.rel_path,
                node.lineno,
                node.lineno,
            )
        )
        self.writer(edge_record("DEFINES", ctx.rel_path, route_id))
        self.writer(edge_record("ROUTES_TO", route_id, handler_id))

    def _process_django_urlpatterns(self, ctx):
        for node in ctx.tree.body:
            if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
                continue
            target = node.targets[0]
            if not (isinstance(target, ast.Name) and target.id == "urlpatterns"):
                continue
            if not isinstance(node.value, ast.List):
                continue
            for element in node.value.elts:
                self._process_django_path_call(element, ctx)

    def _resolve_view_handler_id(self, view_arg, ctx):
        if isinstance(view_arg, ast.Name):
            handler_id = self.registry.functions_by_file.get(ctx.rel_path, {}).get(view_arg.id)
            if handler_id:
                return handler_id
            binding = ctx.imports.get(view_arg.id)
            if binding and binding.kind == "symbol":
                return self.registry.functions_by_file.get(binding.rel_path, {}).get(binding.original_name)
        elif isinstance(view_arg, ast.Attribute) and isinstance(view_arg.value, ast.Name):
            binding = ctx.imports.get(view_arg.value.id)
            if binding and binding.kind == "module":
                return self.registry.functions_by_file.get(binding.rel_path, {}).get(view_arg.attr)
        return None

    def _process_django_path_call(self, element, ctx):
        if not isinstance(element, ast.Call) or not isinstance(element.func, ast.Name):
            return
        if element.func.id not in ("path", "re_path"):
            return
        if len(element.args) < 2:
            return

        route_arg = element.args[0]
        if not (isinstance(route_arg, ast.Constant) and isinstance(route_arg.value, str)):
            return

        handler_id = self._resolve_view_handler_id(element.args[1], ctx)
        if handler_id is None:
            return

        route_id = f"python:route:{handler_id}"
        self.writer(
            route_record(
                route_id,
                f"ROUTE {route_arg.value}",
                ast.unparse(element),
                ctx.rel_path,
                element.lineno,
                element.lineno,
            )
        )
        self.writer(edge_record("DEFINES", ctx.rel_path, route_id))
        self.writer(edge_record("ROUTES_TO", route_id, handler_id))
