/**
 * SQLite DDL for the unified graph schema (see nodes.ts / edges.ts for the TS side).
 * graph-store runs these once against a fresh `.rs-graph/graph.db`.
 *
 * `Edge` is a single generic table for every edge type rather than one table per type:
 * fromId/toId reference whichever of File.path / Symbol.id / Component.id applies for that
 * edgeType (see edges.ts) — SQLite has no polymorphic FK, so referential integrity across
 * that boundary is enforced by graph-store, not the schema. Graph traversal (callers/callees,
 * hierarchy, N-hop impact analysis) is done via recursive CTEs over this table, one query
 * shape per MCP tool — see graph-store's query helpers.
 */

export const TABLE_DDL: readonly string[] = [
  `CREATE TABLE File (
    path TEXT PRIMARY KEY,
    language TEXT NOT NULL,
    contentHash TEXT NOT NULL,
    sizeBytes INTEGER NOT NULL
  )`,
  `CREATE TABLE Symbol (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    signature TEXT NOT NULL,
    docSummary TEXT,
    filePath TEXT NOT NULL,
    startLine INTEGER NOT NULL,
    endLine INTEGER NOT NULL,
    startCol INTEGER,
    endCol INTEGER,
    modifiers TEXT NOT NULL,
    external INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (filePath) REFERENCES File(path) ON DELETE CASCADE
  )`,
  `CREATE TABLE Component (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    selector TEXT,
    framework TEXT NOT NULL,
    templatePath TEXT,
    FOREIGN KEY (id) REFERENCES Symbol(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE Edge (
    fromId TEXT NOT NULL,
    toId TEXT NOT NULL,
    edgeType TEXT NOT NULL,
    line INTEGER,
    col INTEGER
  )`,
];

export const INDEX_DDL: readonly string[] = [
  `CREATE INDEX idx_symbol_kind ON Symbol(kind)`,
  `CREATE INDEX idx_symbol_filePath ON Symbol(filePath)`,
  `CREATE INDEX idx_symbol_name ON Symbol(name)`,
  `CREATE INDEX idx_edge_from ON Edge(fromId, edgeType)`,
  `CREATE INDEX idx_edge_to ON Edge(toId, edgeType)`,
  `CREATE UNIQUE INDEX idx_edge_unique ON Edge(fromId, toId, edgeType, line, col)`,
];

/** FTS5 virtual table backing graph_search_symbol. Kept as a standalone table (not a
 * content= linked view) and written alongside Symbol so incremental re-index (delete+insert
 * within one transaction) can't leave the two out of sync. */
export const FTS_DDL: readonly string[] = [
  `CREATE VIRTUAL TABLE SymbolFts USING fts5(
    id UNINDEXED,
    name,
    signature,
    docSummary
  )`,
];

/** Run in order: tables before indexes/FTS. */
export const ALL_DDL: readonly string[] = [...TABLE_DDL, ...INDEX_DDL, ...FTS_DDL];
