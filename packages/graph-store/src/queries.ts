import type { GraphDb } from "./db.js";
import type {
  ClassHierarchy,
  ComponentBinding,
  ContextPack,
  DiRegistration,
  FileDependencies,
  GraphStats,
  ImpactAnalysisResult,
  ReferenceHit,
  RouteMapping,
  SymbolSummary,
  SymbolWithDepth,
} from "./types.js";

interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  signature: string;
  docSummary: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  startCol: number | null;
  endCol: number | null;
  modifiers: string;
  external: number;
}

function toSymbolSummary(row: SymbolRow): SymbolSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    docSummary: row.docSummary,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    startCol: row.startCol,
    endCol: row.endCol,
    modifiers: JSON.parse(row.modifiers) as string[],
    external: row.external === 1,
  };
}

const SYMBOL_COLUMNS =
  "id, name, kind, signature, docSummary, filePath, startLine, endLine, startCol, endCol, modifiers, external";

export function getSymbolById(db: GraphDb, symbolId: string): SymbolSummary | undefined {
  const row = db
    .prepare(`SELECT ${SYMBOL_COLUMNS} FROM Symbol WHERE id = ?`)
    .get(symbolId) as SymbolRow | undefined;
  return row ? toSymbolSummary(row) : undefined;
}

export function getDefinitionAtLocation(
  db: GraphDb,
  filePath: string,
  line: number,
): SymbolSummary | undefined {
  const row = db
    .prepare(
      `SELECT ${SYMBOL_COLUMNS} FROM Symbol
       WHERE filePath = ? AND startLine <= ? AND endLine >= ?
       ORDER BY (endLine - startLine) ASC
       LIMIT 1`,
    )
    .get(filePath, line, line) as SymbolRow | undefined;
  return row ? toSymbolSummary(row) : undefined;
}

export interface FileOutlineResult {
  symbols: SymbolSummary[];
  truncated: boolean;
}

/**
 * A generated file (an NSwag API client, in one real case) can declare thousands of symbols —
 * unbounded, this produced a 55,000+ character response even after compact mode. Capped at
 * `limit` (default 200) with a `truncated` flag, same convention as impactAnalysis/contextPack.
 */
export function getFileOutline(
  db: GraphDb,
  filePath: string,
  { limit = 200, offset = 0 }: PageOptions = {},
): FileOutlineResult {
  const rows = db
    .prepare(`SELECT ${SYMBOL_COLUMNS} FROM Symbol WHERE filePath = ? ORDER BY startLine ASC LIMIT ? OFFSET ?`)
    .all(filePath, limit, offset) as SymbolRow[];
  const { n: totalCount } = db.prepare("SELECT COUNT(*) as n FROM Symbol WHERE filePath = ?").get(filePath) as {
    n: number;
  };
  return { symbols: rows.map(toSymbolSummary), truncated: offset + rows.length < totalCount };
}

export interface SearchSymbolOptions {
  query: string;
  kind?: string;
  language?: string;
  limit?: number;
  /** "any" (default): matches name, signature, and docSummary together — the existing behavior,
   * kept as default since real usage relies on it (e.g. finding a symbol by a word in its doc
   * comment, not just its name). "name": scopes the match to the symbol's own name only, via
   * FTS5's column-filter syntax — much more precise when the caller wants "things named X" and
   * not "anything that merely mentions X in its signature/docs" (a generic search over all three
   * columns matches any symbol whose signature happens to reference a same-named parameter/return
   * type, which is a different, broader question). */
  scope?: "name" | "any";
}

function isFtsSyntaxError(err: unknown): boolean {
  return err instanceof Error && /fts5: syntax error/i.test(err.message);
}

/** Quotes a raw query as an FTS5 phrase, escaping embedded double quotes by doubling them (FTS5's
 * own phrase-escaping rule) — this makes every character inside literal, so it's always valid
 * syntax regardless of what the query contains. */
function toFtsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

/** Applies FTS5's column-filter syntax ("name:query") when scoped to just the name column;
 * passes the query through unchanged for the default "any"/unscoped case. */
function scopedFtsQuery(query: string, scope: "name" | "any" | undefined): string {
  return scope === "name" ? `name:${query}` : query;
}

export function searchSymbol(db: GraphDb, opts: SearchSymbolOptions): SymbolSummary[] {
  const limit = opts.limit ?? 20;
  const clauses: string[] = ["SymbolFts MATCH @query"];
  const params: Record<string, unknown> = { query: scopedFtsQuery(opts.query, opts.scope), limit };
  if (opts.kind) {
    clauses.push("s.kind = @kind");
    params.kind = opts.kind;
  }
  if (opts.language) {
    clauses.push("f.language = @language");
    params.language = opts.language;
  }
  const stmt = db.prepare(
    `SELECT s.${SYMBOL_COLUMNS.replaceAll(", ", ", s.")} FROM SymbolFts
     JOIN Symbol s ON s.id = SymbolFts.id
     JOIN File f ON f.path = s.filePath
     WHERE ${clauses.join(" AND ")}
     ORDER BY rank
     LIMIT @limit`,
  );

  let rows: SymbolRow[];
  try {
    rows = stmt.all(params) as SymbolRow[];
  } catch (err) {
    if (!isFtsSyntaxError(err)) throw err;
    // The query isn't valid FTS5 query syntax — most commonly because it's a real symbol
    // name/signature fragment that happens to contain FTS5 operator characters (a generic type
    // like "DbSet<Foo>", a qualified name with "::" or "-", etc.). Retry it as a literal phrase
    // rather than surfacing a raw SQLite syntax error for what looks, to the caller, like an
    // ordinary search term.
    rows = stmt.all({ ...params, query: scopedFtsQuery(toFtsPhrase(opts.query), opts.scope) }) as SymbolRow[];
  }
  return rows.map(toSymbolSummary);
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

/**
 * Symbols reached by walking IMPLEMENTS/OVERRIDES edges *from* symbolId — i.e. the
 * interface/base methods this symbol provides an implementation or override for. Real code
 * overwhelmingly calls through an interface-typed reference (`private readonly IFoo _foo`),
 * so the semantic model resolves those call sites to the *interface* method, never the
 * concrete implementation directly — without expanding the search to include these
 * polymorphic ancestors, getCallers/getReferences on a concrete method would silently return
 * empty even when it's heavily called.
 */
function getPolymorphicAncestorIds(db: GraphDb, symbolId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT toId FROM Edge WHERE fromId = ? AND edgeType IN ('IMPLEMENTS', 'OVERRIDES')
         UNION
         SELECT e.toId FROM Edge e JOIN ancestors a ON e.fromId = a.id
         WHERE e.edgeType IN ('IMPLEMENTS', 'OVERRIDES')
       )
       SELECT id FROM ancestors`,
    )
    .all(symbolId) as { id: string }[];
  return rows.map((r) => r.id);
}

function referencesByEdgeTypes(
  db: GraphDb,
  symbolId: string,
  edgeTypes: string[],
  direction: "callers" | "callees",
  { limit = 50, offset = 0 }: PageOptions = {},
): ReferenceHit[] {
  const edgePlaceholders = edgeTypes.map(() => "?").join(",");
  const [selectSide, matchSide] = direction === "callers" ? ["fromId", "toId"] : ["toId", "fromId"];

  // Only the "callers" side needs the polymorphic expansion — a symbol's own outgoing calls
  // (its callees) are already resolved to their own correct targets regardless of whether this
  // symbol itself is reached via an interface.
  const targetIds = direction === "callers" ? [symbolId, ...getPolymorphicAncestorIds(db, symbolId)] : [symbolId];
  const targetPlaceholders = targetIds.map(() => "?").join(",");
  const whereClause = `e.${matchSide} IN (${targetPlaceholders}) AND e.edgeType IN (${edgePlaceholders})`;

  // One row per *symbol*, not per call site — a caller with 5 call sites to the same target
  // used to repeat its full signature/doc/etc. 5 times. GROUP BY s.id is safe here without
  // wrapping every other selected column in an aggregate: they're all functionally dependent on
  // s.id (same symbol row), so SQLite's relaxed GROUP BY can't pick inconsistent values for them.
  const symbolRows = db
    .prepare(
      `SELECT s.${SYMBOL_COLUMNS.replaceAll(", ", ", s.")}
       FROM Edge e JOIN Symbol s ON s.id = e.${selectSide}
       WHERE ${whereClause}
       GROUP BY s.id
       ORDER BY s.filePath, s.startLine
       LIMIT ? OFFSET ?`,
    )
    .all(...targetIds, ...edgeTypes, limit, offset) as SymbolRow[];
  if (symbolRows.length === 0) return [];

  // Pagination applies to the unique-symbol list above; this second query only needs to fetch
  // occurrences for exactly the symbols that made the page, not re-run pagination itself.
  const pageIds = symbolRows.map((row) => row.id);
  const pagePlaceholders = pageIds.map(() => "?").join(",");
  const occurrenceRows = db
    .prepare(
      `SELECT s.id as symbolId, e.line as line, e.col as col
       FROM Edge e JOIN Symbol s ON s.id = e.${selectSide}
       WHERE s.id IN (${pagePlaceholders}) AND ${whereClause}
       ORDER BY e.line`,
    )
    .all(...pageIds, ...targetIds, ...edgeTypes) as {
    symbolId: string;
    line: number | null;
    col: number | null;
  }[];

  const occurrencesBySymbolId = new Map<string, Array<{ line: number | null; col: number | null }>>();
  for (const row of occurrenceRows) {
    const list = occurrencesBySymbolId.get(row.symbolId) ?? [];
    list.push({ line: row.line, col: row.col });
    occurrencesBySymbolId.set(row.symbolId, list);
  }

  return symbolRows.map((row) => ({
    symbol: toSymbolSummary(row),
    occurrences: occurrencesBySymbolId.get(row.id) ?? [],
  }));
}

export function getReferences(db: GraphDb, symbolId: string, opts?: PageOptions): ReferenceHit[] {
  return referencesByEdgeTypes(db, symbolId, ["CALLS", "REFERENCES"], "callers", opts);
}

export function getCallers(db: GraphDb, symbolId: string, opts?: PageOptions): ReferenceHit[] {
  return referencesByEdgeTypes(db, symbolId, ["CALLS"], "callers", opts);
}

export function getCallees(db: GraphDb, symbolId: string, opts?: PageOptions): ReferenceHit[] {
  return referencesByEdgeTypes(db, symbolId, ["CALLS"], "callees", opts);
}

export function getClassHierarchy(db: GraphDb, symbolId: string): ClassHierarchy {
  const ancestorRows = db
    .prepare(
      `WITH RECURSIVE ancestors(id, depth) AS (
         SELECT toId, 1 FROM Edge WHERE fromId = ? AND edgeType IN ('EXTENDS', 'IMPLEMENTS')
         UNION
         SELECT e.toId, a.depth + 1 FROM Edge e JOIN ancestors a ON e.fromId = a.id
         WHERE e.edgeType IN ('EXTENDS', 'IMPLEMENTS')
       )
       SELECT s.${SYMBOL_COLUMNS.replaceAll(", ", ", s.")}, MIN(a.depth) as depth
       FROM ancestors a JOIN Symbol s ON s.id = a.id
       GROUP BY s.id ORDER BY depth`,
    )
    .all(symbolId) as (SymbolRow & { depth: number })[];

  const descendantRows = db
    .prepare(
      `WITH RECURSIVE descendants(id, depth) AS (
         SELECT fromId, 1 FROM Edge WHERE toId = ? AND edgeType IN ('EXTENDS', 'IMPLEMENTS')
         UNION
         SELECT e.fromId, d.depth + 1 FROM Edge e JOIN descendants d ON e.toId = d.id
         WHERE e.edgeType IN ('EXTENDS', 'IMPLEMENTS')
       )
       SELECT s.${SYMBOL_COLUMNS.replaceAll(", ", ", s.")}, MIN(d.depth) as depth
       FROM descendants d JOIN Symbol s ON s.id = d.id
       GROUP BY s.id ORDER BY depth`,
    )
    .all(symbolId) as (SymbolRow & { depth: number })[];

  const toWithDepth = (row: SymbolRow & { depth: number }): SymbolWithDepth => ({
    ...toSymbolSummary(row),
    depth: row.depth,
  });

  return {
    ancestors: ancestorRows.map(toWithDepth),
    descendants: descendantRows.map(toWithDepth),
  };
}

export function getDependencies(db: GraphDb, filePath: string): FileDependencies {
  const imports = (
    db.prepare("SELECT toId FROM Edge WHERE fromId = ? AND edgeType = 'IMPORTS'").all(filePath) as {
      toId: string;
    }[]
  ).map((r) => r.toId);
  const importedBy = (
    db.prepare("SELECT fromId FROM Edge WHERE toId = ? AND edgeType = 'IMPORTS'").all(filePath) as {
      fromId: string;
    }[]
  ).map((r) => r.fromId);
  return { imports, importedBy };
}

const IMPACT_EDGE_TYPES = ["CALLS", "REFERENCES", "EXTENDS", "IMPLEMENTS", "OVERRIDES", "INJECTS"];

/**
 * Unlike every other traversal query here (searchSymbol limits to 20, contextPack caps at
 * 200 with a `truncated` flag), this had no result cap at all — on a well-connected
 * codebase, a widely-used interface or base class can transitively reach hundreds or
 * thousands of symbols within 3 hops across six edge types, blowing up a single tool call
 * far past what reading the equivalent files directly would have cost. maxResults bounds the
 * response the same way contextPack does; `truncated` tells the caller there's more so they
 * can narrow the query (smaller depth, or a more specific symbol) instead of assuming
 * completeness.
 */
export function impactAnalysis(db: GraphDb, symbolId: string, depth = 3, maxResults = 100): ImpactAnalysisResult {
  const edgeTypeList = IMPACT_EDGE_TYPES.map((t) => `'${t}'`).join(",");
  const cte = `
    WITH RECURSIVE impact(id, depth) AS (
      SELECT fromId, 1 FROM Edge WHERE toId = ? AND edgeType IN (${edgeTypeList})
      UNION
      SELECT e.fromId, i.depth + 1 FROM Edge e JOIN impact i ON e.toId = i.id
      WHERE e.edgeType IN (${edgeTypeList}) AND i.depth < ?
    )`;

  const rows = db
    .prepare(
      `${cte}
       SELECT s.${SYMBOL_COLUMNS.replaceAll(", ", ", s.")}, MIN(impact.depth) as depth
       FROM impact JOIN Symbol s ON s.id = impact.id
       GROUP BY s.id ORDER BY depth
       LIMIT ?`,
    )
    .all(symbolId, depth, maxResults) as (SymbolRow & { depth: number })[];

  const { n: totalCount } = db.prepare(`${cte} SELECT COUNT(DISTINCT id) as n FROM impact`).get(symbolId, depth) as {
    n: number;
  };

  return {
    symbols: rows.map((row) => ({ ...toSymbolSummary(row), depth: row.depth })),
    truncated: totalCount > rows.length,
  };
}

export interface RouteMapResult {
  routes: RouteMapping[];
  truncated: boolean;
}

/** Previously unbounded — a real app's route count is usually modest, but "usually" isn't a
 * safety guarantee (see getComponentTree's comment for the case that proved it). Same
 * limit/offset/truncated convention as everywhere else now. */
export function getRouteMap(db: GraphDb, { limit = 200, offset = 0 }: PageOptions = {}): RouteMapResult {
  const { n: totalCount } = db.prepare("SELECT COUNT(*) as n FROM Symbol WHERE kind = 'Route'").get() as {
    n: number;
  };
  const rows = db
    .prepare(
      `SELECT r.${SYMBOL_COLUMNS.replaceAll(", ", ", r.")}, e.toId as handlerId
       FROM Symbol r LEFT JOIN Edge e ON e.fromId = r.id AND e.edgeType = 'ROUTES_TO'
       WHERE r.kind = 'Route'
       ORDER BY r.filePath, r.startLine
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as (SymbolRow & { handlerId: string | null })[];
  return {
    routes: rows.map((row) => ({
      route: toSymbolSummary(row),
      handler: row.handlerId ? (getSymbolById(db, row.handlerId) ?? null) : null,
    })),
    truncated: offset + rows.length < totalCount,
  };
}

export interface DiGraphResult {
  registrations: DiRegistration[];
  truncated: boolean;
}

export function getDiGraph(db: GraphDb, { limit = 200, offset = 0 }: PageOptions = {}): DiGraphResult {
  const { n: totalCount } = db.prepare("SELECT COUNT(*) as n FROM Symbol WHERE kind = 'DIRegistration'").get() as {
    n: number;
  };
  const rows = db
    .prepare(
      `SELECT d.${SYMBOL_COLUMNS.replaceAll(", ", ", d.")}, e.toId as targetId
       FROM Symbol d LEFT JOIN Edge e ON e.fromId = d.id AND e.edgeType = 'REGISTERS'
       WHERE d.kind = 'DIRegistration'
       ORDER BY d.filePath, d.startLine
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as (SymbolRow & { targetId: string | null })[];
  return {
    registrations: rows.map((row) => ({
      registration: toSymbolSummary(row),
      target: row.targetId ? (getSymbolById(db, row.targetId) ?? null) : null,
    })),
    truncated: offset + rows.length < totalCount,
  };
}

export interface ComponentTreeResult {
  components: ComponentBinding[];
  truncated: boolean;
}

/**
 * Previously unbounded on two axes at once — component count AND each component's full-detail
 * boundSymbols list — which produced an actual 5,091,624-character response against a real
 * Angular app with hundreds of components. Paginates over components (limit/offset/truncated,
 * same as everywhere else); each component's own boundSymbols isn't separately paginated (a
 * second pagination dimension nested inside the first) but does shrink a lot under the caller's
 * `detail` choice at the mcp-server layer, same as every other list tool.
 */
export interface ComponentTreeOptions extends PageOptions {
  /** Fetch exactly one component's binding info by id, bypassing the outer list's limit/offset
   * entirely — the precise, cheap way to ask "what does this one component bind to" instead of
   * paging through every component in the repo to find it. Still subject to maxBoundSymbols. */
  componentId?: string;
  /** Caps each component's own boundSymbols list (default 15). Component *count* isn't the only
   * thing that can make this response huge — a single template-heavy component (a big form, in
   * practice) can bind to far more members than a typical one, so this bounds the worst case per
   * row, not just the number of rows. */
  maxBoundSymbols?: number;
}

/**
 * Real-world data point behind the defaults here: against an actual Angular app, limit=500
 * produced a 1,750,937-character response — about 3,500 characters per component even in
 * compact mode, almost entirely from unbounded per-component boundSymbols lists. `pageArgs`'s
 * generic max(500) (fine for lighter list tools) was itself unsafe for this one specifically, so
 * this tool now has its own, much smaller bounds on both axes: how many components, and how much
 * each one can carry.
 */
export function getComponentTree(
  db: GraphDb,
  { limit = 15, offset = 0, componentId, maxBoundSymbols = 15 }: ComponentTreeOptions = {},
): ComponentTreeResult {
  type ComponentRow = { id: string; name: string; selector: string | null; framework: string; templatePath: string | null };

  let componentRows: ComponentRow[];
  let totalCount: number;
  if (componentId) {
    componentRows = db
      .prepare("SELECT id, name, selector, framework, templatePath FROM Component WHERE id = ?")
      .all(componentId) as ComponentRow[];
    totalCount = componentRows.length;
  } else {
    totalCount = (db.prepare("SELECT COUNT(*) as n FROM Component").get() as { n: number }).n;
    componentRows = db
      .prepare("SELECT id, name, selector, framework, templatePath FROM Component ORDER BY name LIMIT ? OFFSET ?")
      .all(limit, offset) as ComponentRow[];
  }

  const boundCountStmt = db.prepare(
    "SELECT COUNT(*) as n FROM Edge WHERE fromId = ? AND edgeType = 'BINDS_TEMPLATE'",
  );
  const boundStmt = db.prepare(
    `SELECT s.${SYMBOL_COLUMNS.replaceAll(", ", ", s.")} FROM Edge e
     JOIN Symbol s ON s.id = e.toId
     WHERE e.fromId = ? AND e.edgeType = 'BINDS_TEMPLATE'
     LIMIT ?`,
  );

  return {
    components: componentRows.map((component) => {
      const totalBound = (boundCountStmt.get(component.id) as { n: number }).n;
      const boundRows = boundStmt.all(component.id, maxBoundSymbols) as SymbolRow[];
      return {
        component,
        boundSymbols: boundRows.map(toSymbolSummary),
        boundSymbolsTruncated: totalBound > boundRows.length,
      };
    }),
    truncated: componentId ? false : offset + componentRows.length < totalCount,
  };
}

export function getStats(db: GraphDb): GraphStats {
  const totalFiles = (db.prepare("SELECT COUNT(*) as n FROM File").get() as { n: number }).n;
  const totalSymbols = (db.prepare("SELECT COUNT(*) as n FROM Symbol").get() as { n: number }).n;
  const byKindRows = db.prepare("SELECT kind, COUNT(*) as n FROM Symbol GROUP BY kind").all() as {
    kind: string;
    n: number;
  }[];
  const byLanguageRows = db
    .prepare("SELECT language, COUNT(*) as n FROM File GROUP BY language")
    .all() as { language: string; n: number }[];
  return {
    totalFiles,
    totalSymbols,
    byKind: Object.fromEntries(byKindRows.map((r) => [r.kind, r.n])),
    byLanguage: Object.fromEntries(byLanguageRows.map((r) => [r.language, r.n])),
  };
}

/** Dedup'd minimal subgraph around the given seed symbols, out to `hops` hops in either
 * direction across every edge type. Meant to back graph_context_pack — a single call an
 * agent can make instead of reading N files' worth of source. */
export function contextPack(
  db: GraphDb,
  seedSymbolIds: string[],
  hops = 1,
  maxSymbols = 200,
): ContextPack {
  const neighborStmt = db.prepare(
    `SELECT toId as id, fromId as src, toId as dst, edgeType FROM Edge WHERE fromId = ?
     UNION ALL
     SELECT fromId as id, fromId as src, toId as dst, edgeType FROM Edge WHERE toId = ?`,
  );

  const visited = new Set<string>(seedSymbolIds);
  const edgeSet = new Map<string, { from: string; to: string; edgeType: string }>();
  let frontier = [...seedSymbolIds];
  let truncated = false;

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const rows = neighborStmt.all(id, id) as {
        id: string;
        src: string;
        dst: string;
        edgeType: string;
      }[];
      for (const row of rows) {
        edgeSet.set(`${row.src}|${row.dst}|${row.edgeType}`, {
          from: row.src,
          to: row.dst,
          edgeType: row.edgeType,
        });
        if (!visited.has(row.id)) {
          if (visited.size >= maxSymbols) {
            truncated = true;
            continue;
          }
          visited.add(row.id);
          nextFrontier.push(row.id);
        }
      }
    }
    frontier = nextFrontier;
  }

  const symbols: SymbolSummary[] = [];
  for (const id of visited) {
    const summary = getSymbolById(db, id);
    if (summary) symbols.push(summary);
  }

  return { symbols, edges: [...edgeSet.values()], truncated };
}
