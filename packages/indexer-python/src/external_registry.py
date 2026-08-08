"""Mirrors core-schema's ExternalSymbolRegistry (TS side) — see that file for the full
rationale. Reimplemented natively here since indexer-python can't import TS code; kept
behaviorally identical (group by a caller-provided key, hash-based contentHash so an
idempotent re-index only rewrites a pseudo-file's stub rows when its symbol set changes).
"""

import hashlib

from models import edge_record, file_record, symbol_record


class ExternalSymbolRegistry:
    def __init__(self, language, pseudo_file_for):
        self.language = language
        self.pseudo_file_for = pseudo_file_for
        self._ids_by_pseudo_file = {}
        self._records_by_id = {}

    def get_or_register(self, id, name, kind, signature, group_key):
        if id in self._records_by_id:
            return id

        pseudo_file = self.pseudo_file_for(group_key)
        self._ids_by_pseudo_file.setdefault(pseudo_file, set()).add(id)
        self._records_by_id[id] = symbol_record(
            id, name, kind, signature, pseudo_file, 0, 0, external=True
        )
        return id

    def flush(self):
        records = []
        for pseudo_file, ids in self._ids_by_pseudo_file.items():
            sorted_ids = sorted(ids)
            content_hash = hashlib.sha256("\n".join(sorted_ids).encode("utf-8")).hexdigest()
            records.append(file_record(pseudo_file, self.language, content_hash, 0))
            for id in sorted_ids:
                records.append(self._records_by_id[id])
                records.append(edge_record("DEFINES", pseudo_file, id))
        return records
