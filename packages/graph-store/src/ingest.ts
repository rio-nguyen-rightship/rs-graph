import type { GraphDb } from "./db.js";
import {
  redactSecrets,
  redactSecretsIfPresent,
  type ComponentNode,
  type FileNode,
  type GraphEdgeRecord,
  type GraphRecord,
  type SymbolNode,
} from "@rs-graph/core-schema";

export interface IngestResult {
  filesChanged: number;
  filesUnchanged: number;
  symbolsWritten: number;
  edgesWritten: number;
}

function edgeLine(edge: GraphEdgeRecord): number | null {
  return "line" in edge ? edge.line : null;
}

function edgeCol(edge: GraphEdgeRecord): number | null {
  return "col" in edge ? (edge.col ?? null) : null;
}

/**
 * Ingests one full batch of NDJSON records from a single indexer run (see core-schema's
 * GraphRecord union). Idempotent: a file whose contentHash matches what's already stored is
 * left untouched — its symbols/edges are not rewritten. A new/changed file has its
 * previously-stored symbols/components/edges replaced with the fresh batch.
 *
 * Cross-file edges are only (re)written when the edge's *source* file is being (re)processed —
 * the target side doesn't need to already exist (unresolved/external targets are expected,
 * see SymbolNode.external), and an edge sourced from an unchanged file is assumed to already
 * be correctly present from a prior run.
 */
export function ingestGraphRecords(db: GraphDb, records: Iterable<GraphRecord>): IngestResult {
  const files: FileNode[] = [];
  const rawSymbols: SymbolNode[] = [];
  const components: ComponentNode[] = [];
  const edges: GraphEdgeRecord[] = [];

  for (const record of records) {
    switch (record.record) {
      case "file":
        files.push(record);
        break;
      case "symbol":
        rawSymbols.push(record);
        break;
      case "component":
        components.push(record);
        break;
      case "edge":
        edges.push(record);
        break;
    }
  }

  // The same fully-qualified id can appear twice in one indexer's output: once as an owned,
  // source-backed declaration (from the project that actually defines it) and once as an
  // external stub (from a sibling project in the *same* solution that only sees the type
  // through a compiled reference rather than linked source — e.g. a project referencing a
  // NuGet-packaged copy of another in-solution project). Keep the owned declaration; a stub
  // for a symbol we already have full information on is exactly the case external stubs exist
  // to avoid, and inserting both violates Symbol.id's PRIMARY KEY constraint.
  const symbolById = new Map<string, SymbolNode>();
  for (const symbol of rawSymbols) {
    const existing = symbolById.get(symbol.id);
    if (!existing || (existing.external && !symbol.external)) {
      symbolById.set(symbol.id, symbol);
    }
  }
  const symbols = [...symbolById.values()];

  const filePathSet = new Set(files.map((f) => f.path));
  const symbolIdToFilePath = new Map<string, string>();
  for (const symbol of symbols) symbolIdToFilePath.set(symbol.id, symbol.filePath);

  const existingHashStmt = db.prepare("SELECT contentHash FROM File WHERE path = ?");
  const changedFiles = new Set<string>();
  let filesUnchanged = 0;
  for (const file of files) {
    const existing = existingHashStmt.get(file.path) as { contentHash: string } | undefined;
    if (existing && existing.contentHash === file.contentHash) {
      filesUnchanged++;
    } else {
      changedFiles.add(file.path);
    }
  }

  const symbolIdsByFileStmt = db.prepare("SELECT id FROM Symbol WHERE filePath = ?");
  const deleteEdgesFromStmt = db.prepare("DELETE FROM Edge WHERE fromId = ?");
  const deleteFtsStmt = db.prepare("DELETE FROM SymbolFts WHERE id = ?");
  const deleteSymbolStmt = db.prepare("DELETE FROM Symbol WHERE id = ?");

  const upsertFileStmt = db.prepare(
    `INSERT INTO File (path, language, contentHash, sizeBytes) VALUES (@path, @language, @contentHash, @sizeBytes)
     ON CONFLICT(path) DO UPDATE SET language = @language, contentHash = @contentHash, sizeBytes = @sizeBytes`,
  );
  const insertSymbolStmt = db.prepare(
    `INSERT INTO Symbol (id, name, kind, signature, docSummary, filePath, startLine, endLine, startCol, endCol, modifiers, external)
     VALUES (@id, @name, @kind, @signature, @docSummary, @filePath, @startLine, @endLine, @startCol, @endCol, @modifiers, @external)`,
  );
  const insertFtsStmt = db.prepare(
    `INSERT INTO SymbolFts (id, name, signature, docSummary) VALUES (@id, @name, @signature, @docSummary)`,
  );
  const insertComponentStmt = db.prepare(
    `INSERT INTO Component (id, name, selector, framework, templatePath) VALUES (@id, @name, @selector, @framework, @templatePath)`,
  );
  const insertEdgeStmt = db.prepare(
    `INSERT OR IGNORE INTO Edge (fromId, toId, edgeType, line, col) VALUES (@fromId, @toId, @edgeType, @line, @col)`,
  );

  let symbolsWritten = 0;
  let edgesWritten = 0;

  const run = db.transaction(() => {
    // 1. Clear out stale rows for changed/new files.
    for (const filePath of changedFiles) {
      const staleSymbolIds = (symbolIdsByFileStmt.all(filePath) as { id: string }[]).map((r) => r.id);
      for (const id of staleSymbolIds) {
        deleteEdgesFromStmt.run(id);
        deleteFtsStmt.run(id);
        deleteSymbolStmt.run(id);
      }
      deleteEdgesFromStmt.run(filePath); // DEFINES/IMPORTS sourced directly from the file
    }

    // 2. Upsert File rows (all of them, including unchanged — cheap, keeps metadata current).
    for (const file of files) {
      upsertFileStmt.run(file);
    }

    // 3. Insert fresh symbols/components/FTS rows, only for changed/new files. Signatures and
    // doc summaries are free-form text lifted from source (default parameter values, decorator
    // arguments, DI registration call text) — redact likely secrets before they're persisted or
    // made full-text searchable (see redactSecrets.ts).
    for (const symbol of symbols) {
      if (!changedFiles.has(symbol.filePath)) continue;
      const signature = redactSecrets(symbol.signature);
      const docSummary = redactSecretsIfPresent(symbol.docSummary) ?? null;
      insertSymbolStmt.run({
        ...symbol,
        signature,
        docSummary,
        startCol: symbol.startCol ?? null,
        endCol: symbol.endCol ?? null,
        modifiers: JSON.stringify(symbol.modifiers),
        external: symbol.external ? 1 : 0,
      });
      insertFtsStmt.run({
        id: symbol.id,
        name: symbol.name,
        signature,
        docSummary: docSummary ?? "",
      });
      symbolsWritten++;
    }
    for (const component of components) {
      const ownerFile = symbolIdToFilePath.get(component.id);
      if (!ownerFile || !changedFiles.has(ownerFile)) continue;
      insertComponentStmt.run({
        ...component,
        selector: component.selector ?? null,
        templatePath: component.templatePath ?? null,
      });
    }

    // 4. Insert edges whose *source* file was (re)processed.
    for (const edge of edges) {
      const ownerFile = filePathSet.has(edge.from) ? edge.from : symbolIdToFilePath.get(edge.from);
      if (!ownerFile || !changedFiles.has(ownerFile)) continue;
      insertEdgeStmt.run({
        fromId: edge.from,
        toId: edge.to,
        edgeType: edge.edgeType,
        line: edgeLine(edge),
        col: edgeCol(edge),
      });
      edgesWritten++;
    }
  });

  run();

  return {
    filesChanged: changedFiles.size,
    filesUnchanged,
    symbolsWritten,
    edgesWritten,
  };
}
