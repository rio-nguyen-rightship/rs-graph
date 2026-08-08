import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest  # noqa: E402
from main import run  # noqa: E402

FIXTURE_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "fixtures", "sample-python-api")
)


@pytest.fixture(scope="module")
def records():
    collected = []
    run(FIXTURE_ROOT, FIXTURE_ROOT, lambda record: collected.append(record))
    return collected


def find_symbol(records, id):
    matches = [r for r in records if r["record"] == "symbol" and r["id"] == id]
    assert len(matches) == 1, f"expected exactly one symbol with id {id}, found {len(matches)}"
    return matches[0]


def has_edge(records, edge_type, from_id, to_id):
    return any(
        r["record"] == "edge" and r["edgeType"] == edge_type and r["from"] == from_id and r["to"] == to_id
        for r in records
    )


def test_emits_file_records_for_every_py_file(records):
    paths = [r["path"] for r in records if r["record"] == "file"]
    assert "app.py" in paths
    assert "domain/greeter.py" in paths
    assert "api/controller.py" in paths


def test_greeter_extends_igreeter(records):
    symbol = find_symbol(records, "python:domain/greeter.py#Greeter")
    assert symbol["kind"] == "Class"
    assert has_edge(records, "EXTENDS", "python:domain/greeter.py#Greeter", "python:domain/greeter.py#IGreeter")


def test_igreeter_has_doc_summary_from_docstring(records):
    symbol = find_symbol(records, "python:domain/greeter.py#IGreeter")
    assert symbol["docSummary"] == "Greets a named visitor."


def test_same_class_self_call_resolves(records):
    assert has_edge(
        records,
        "CALLS",
        "python:domain/greeter.py#Greeter.greet",
        "python:domain/greeter.py#Greeter.build_message",
    )


def test_constructor_injected_cross_class_call_resolves(records):
    # GreetingController.get calls self.greeter.greet(...); self.greeter's type comes from the
    # __init__ parameter annotation `greeter: IGreeter` — the Python analogue of the
    # constructor-injection resolution the C#/TS indexers do.
    assert has_edge(
        records,
        "CALLS",
        "python:api/controller.py#GreetingController.get",
        "python:domain/greeter.py#IGreeter.greet",
    )


def test_dunder_init_is_public_not_protected(records):
    symbol = find_symbol(records, "python:api/controller.py#GreetingController.__init__")
    assert symbol["modifiers"] == ["public"]


def test_flask_route_maps_to_handler(records):
    routes = [r for r in records if r["record"] == "symbol" and r["kind"] == "Route"]
    assert len(routes) == 1
    assert routes[0]["name"] == "GET /api/greeting/<name>"
    assert has_edge(records, "ROUTES_TO", routes[0]["id"], "python:app.py#get_greeting")


def test_import_edges_resolve_to_owned_files(records):
    assert has_edge(records, "IMPORTS", "app.py", "domain/greeter.py")
    assert has_edge(records, "IMPORTS", "app.py", "api/controller.py")


def test_idempotent_ids_across_runs(records):
    second_run = []
    run(FIXTURE_ROOT, FIXTURE_ROOT, lambda record: second_run.append(record))
    first_ids = sorted(r["id"] for r in records if r["record"] == "symbol")
    second_ids = sorted(r["id"] for r in second_run if r["record"] == "symbol")
    assert first_ids == second_ids
