"""NDJSON wire records mirroring packages/core-schema/src/{nodes,edges}.ts.

Plain dict builders rather than dataclasses: the only thing that matters here is producing
JSON with exactly the field names the TS side expects (json.dumps handles the rest).
"""


def file_record(path, language, content_hash, size_bytes):
    return {
        "record": "file",
        "path": path,
        "language": language,
        "contentHash": content_hash,
        "sizeBytes": size_bytes,
    }


def symbol_record(
    id,
    name,
    kind,
    signature,
    file_path,
    start_line,
    end_line,
    *,
    doc_summary=None,
    start_col=None,
    end_col=None,
    modifiers=None,
    external=False,
):
    return {
        "record": "symbol",
        "id": id,
        "name": name,
        "kind": kind,
        "signature": signature,
        "docSummary": doc_summary,
        "filePath": file_path,
        "startLine": start_line,
        "endLine": end_line,
        "startCol": start_col,
        "endCol": end_col,
        "modifiers": modifiers or [],
        "external": external,
    }


def route_record(id, name, signature, file_path, start_line, end_line):
    return symbol_record(id, name, "Route", signature, file_path, start_line, end_line)


def edge_record(edge_type, from_id, to_id, *, line=None, col=None):
    return {"record": "edge", "edgeType": edge_type, "from": from_id, "to": to_id, "line": line, "col": col}
