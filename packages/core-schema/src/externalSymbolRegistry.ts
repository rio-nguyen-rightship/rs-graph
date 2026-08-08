import { createHash } from "node:crypto";
import type { Language, SymbolKind, SymbolNode } from "./nodes.js";
import type { GraphRecord } from "./ndjson.js";

export interface ExternalSymbolDescriptor {
  id: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  /** Optional grouping key for `pseudoFileFor` (e.g. a package/assembly name) — passed straight
   * through rather than needing to be reverse-parsed out of `id` later. */
  groupKey?: string;
}

/**
 * Tracks symbols referenced from outside the set of files an indexer is walking (unresolved
 * or externally-resolved package/BCL/stdlib types) so every edge target has a corresponding
 * Symbol row with a readable name (see SymbolNode.external).
 *
 * Each distinct "external group" (e.g. one per referenced package/assembly, as decided by the
 * caller's `pseudoFileFor`) gets one synthetic pseudo-File whose contentHash is a hash of the
 * *set* of external symbol ids seen this run — so graph-store's idempotent, contentHash-keyed
 * ingest naturally refreshes that pseudo-file's stub rows exactly when the set of known
 * external symbols for that group changes, and leaves it alone (a cheap no-op) otherwise.
 */
export class ExternalSymbolRegistry {
  private readonly idsByPseudoFile = new Map<string, Set<string>>();
  private readonly recordsById = new Map<string, SymbolNode>();

  constructor(
    private readonly language: Language,
    private readonly pseudoFileFor: (descriptor: ExternalSymbolDescriptor) => string,
  ) {}

  getOrRegister(descriptor: ExternalSymbolDescriptor): string {
    if (this.recordsById.has(descriptor.id)) return descriptor.id;

    const pseudoFile = this.pseudoFileFor(descriptor);
    let ids = this.idsByPseudoFile.get(pseudoFile);
    if (!ids) {
      ids = new Set();
      this.idsByPseudoFile.set(pseudoFile, ids);
    }
    ids.add(descriptor.id);

    this.recordsById.set(descriptor.id, {
      record: "symbol",
      id: descriptor.id,
      name: descriptor.name,
      kind: descriptor.kind,
      signature: descriptor.signature,
      filePath: pseudoFile,
      startLine: 0,
      endLine: 0,
      modifiers: [],
      external: true,
    });

    return descriptor.id;
  }

  /** Yields the FileRecord/SymbolRecord/DEFINES-edge records for every group registered so
   * far. Call once, after the main walk, before finishing the NDJSON stream. */
  *flush(): Generator<GraphRecord> {
    for (const [pseudoFile, ids] of this.idsByPseudoFile) {
      const sortedIds = [...ids].sort();
      const contentHash = createHash("sha256").update(sortedIds.join("\n")).digest("hex");

      yield {
        record: "file",
        path: pseudoFile,
        language: this.language,
        contentHash,
        sizeBytes: 0,
      };

      for (const id of sortedIds) {
        const symbolRecord = this.recordsById.get(id);
        if (!symbolRecord) continue;
        yield symbolRecord;
        yield { record: "edge", edgeType: "DEFINES", from: pseudoFile, to: id };
      }
    }
  }
}
