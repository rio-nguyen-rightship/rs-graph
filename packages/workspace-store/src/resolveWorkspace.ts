import * as fs from "node:fs";
import { closeGraphDb, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { repoDbPath, type WorkspaceRepoConfig } from "./workspaceConfig.js";

export interface CrossRepoOwner {
  repo: string;
  symbolId: string;
  name: string;
  kind: string;
}

export interface CrossRepoReference {
  repo: string;
  fromSymbolId: string;
  edgeType: string;
}

export interface CrossRepoIndex {
  /** Real Route/MessageContract/HubEvent symbols across every repo, keyed by their normalized
   * cross-repo join key (a Route's real id is verb-prefixed — csharp:route:GET:{template} — and
   * gets reformatted to xrepo:route:{template} here so it lands in the same key space as the
   * edges below; MessageContract/HubEvent ids already *are* the join key verbatim). */
  ownersByKey: Map<string, CrossRepoOwner[]>;
  /** INVOKES_ROUTE/PUBLISHES/CONSUMES edges across every repo, keyed by their (already
   * normalized) target. */
  referencesByKey: Map<string, CrossRepoReference[]>;
  /** Configured repos skipped because they haven't been indexed yet (no .rs-graph/graph.db) —
   * surfaced so a caller can say why a repo contributed nothing, instead of it silently looking
   * empty or unrelated. */
  skippedRepos: string[];
}

const CROSS_REPO_SYMBOL_KINDS = ["Route", "MessageContract", "HubEvent"];
const CROSS_REPO_EDGE_TYPES = ["INVOKES_ROUTE", "PUBLISHES", "CONSUMES"];

/** `csharp:route:GET:api/greeting/{name}` -> `xrepo:route:api/greeting/{name}` — see
 * indexer-dotnet's RouteUtils for how a Route symbol's own id is built. It always carries a
 * verb; an INVOKES_ROUTE edge's target never does (a `[RouteUrl]` attribute only ever carries
 * the path), so both sides have to be compared in the verb-less form. */
function routeSymbolIdToKey(symbolId: string): string | undefined {
  const match = /^csharp:route:[A-Z]+:(.+)$/.exec(symbolId);
  return match ? `xrepo:route:${match[1]}` : undefined;
}

/** MessageContract/HubEvent ids are already the join key verbatim (`xrepo:message:...` /
 * `xrepo:signal:...`) — only Route needs reshaping. */
function ownerKeyFor(kind: string, symbolId: string): string | undefined {
  return kind === "Route" ? routeSymbolIdToKey(symbolId) : symbolId;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function scanRepo(
  db: GraphDb,
  repoName: string,
  ownersByKey: Map<string, CrossRepoOwner[]>,
  referencesByKey: Map<string, CrossRepoReference[]>,
): void {
  const symbolPlaceholders = CROSS_REPO_SYMBOL_KINDS.map(() => "?").join(",");
  const symbols = db
    .prepare(`SELECT id, name, kind FROM Symbol WHERE kind IN (${symbolPlaceholders})`)
    .all(...CROSS_REPO_SYMBOL_KINDS) as Array<{ id: string; name: string; kind: string }>;
  for (const s of symbols) {
    const key = ownerKeyFor(s.kind, s.id);
    if (!key) continue;
    pushTo(ownersByKey, key, { repo: repoName, symbolId: s.id, name: s.name, kind: s.kind });
  }

  const edgePlaceholders = CROSS_REPO_EDGE_TYPES.map(() => "?").join(",");
  const edges = db
    .prepare(`SELECT fromId, toId, edgeType FROM Edge WHERE edgeType IN (${edgePlaceholders})`)
    .all(...CROSS_REPO_EDGE_TYPES) as Array<{ fromId: string; toId: string; edgeType: string }>;
  for (const e of edges) {
    pushTo(referencesByKey, e.toId, { repo: repoName, fromSymbolId: e.fromId, edgeType: e.edgeType });
  }
}

/**
 * Scans every configured repo's already-indexed graph.db for cross-repo-facing symbols/edges
 * and builds an in-memory join index — a plain map, not a persisted SQLite db (`ATTACH DATABASE`
 * has real rough edges with better-sqlite3 — no bound parameters for the path, a default
 * 10-attached-db ceiling, unqualified table names resolving against whichever db is "main" — and
 * every existing single-repo query function already works unmodified against each repo's own
 * already-open db, so there's nothing to gain from attaching them together). Repos with no
 * .rs-graph/graph.db yet are skipped, not errored — see CrossRepoIndex.skippedRepos.
 */
export function buildCrossRepoIndex(repos: WorkspaceRepoConfig[]): CrossRepoIndex {
  const ownersByKey = new Map<string, CrossRepoOwner[]>();
  const referencesByKey = new Map<string, CrossRepoReference[]>();
  const skippedRepos: string[] = [];

  for (const repo of repos) {
    const dbPath = repoDbPath(repo);
    if (!fs.existsSync(dbPath)) {
      skippedRepos.push(repo.name);
      continue;
    }

    // One repo's graph being unreadable (an index run still creating it, a locked or corrupt
    // file) must not take down lookups for every other repo — treat it as not-yet-indexed.
    let db: GraphDb | undefined;
    try {
      db = openGraphDb({ dbPath, mustExist: true });
      const hasSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Symbol'").get();
      if (!hasSchema) {
        skippedRepos.push(repo.name);
        continue;
      }
      scanRepo(db, repo.name, ownersByKey, referencesByKey);
    } catch (err) {
      console.error(`rs-graph: skipping ${repo.name} — couldn't read ${dbPath}: ${err instanceof Error ? err.message : err}`);
      skippedRepos.push(repo.name);
    } finally {
      if (db) closeGraphDb(db);
    }
  }

  return { ownersByKey, referencesByKey, skippedRepos };
}

/** Newest write to a repo's graph, or -1 when it has none. Includes the WAL file: while any
 * connection (e.g. that repo's own long-lived `rs-graph serve`) stays open, a writer's commits
 * sit in graph.db-wal and graph.db's own mtime doesn't move until the next checkpoint. */
function currentDbMtimes(repos: WorkspaceRepoConfig[]): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const repo of repos) {
    const dbPath = repoDbPath(repo);
    const newest = [dbPath, `${dbPath}-wal`].reduce(
      (latest, file) => (fs.existsSync(file) ? Math.max(latest, fs.statSync(file).mtimeMs) : latest),
      -1,
    );
    mtimes.set(repo.name, newest);
  }
  return mtimes;
}

function mtimesEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, mtime] of a) {
    if (b.get(name) !== mtime) return false;
  }
  return true;
}

/**
 * Wraps buildCrossRepoIndex with lazy, per-call freshness checking, so a long-lived
 * `serve-workspace` process doesn't need a restart to see a repo re-indexed by `watch-workspace`
 * or a git hook while it's running. Cheap when nothing changed (one `statSync` per repo); only
 * pays for a full rebuild when some repo's graph.db mtime actually moved (including a repo that
 * just got indexed for the first time, via the -1 sentinel for "no db yet").
 */
export function createLiveCrossRepoIndex(repos: WorkspaceRepoConfig[]): () => CrossRepoIndex {
  let index = buildCrossRepoIndex(repos);
  let lastMtimes = currentDbMtimes(repos);

  return () => {
    const nowMtimes = currentDbMtimes(repos);
    if (!mtimesEqual(lastMtimes, nowMtimes)) {
      index = buildCrossRepoIndex(repos);
      lastMtimes = nowMtimes;
    }
    return index;
  };
}

export interface CrossRepoLookupResult {
  key: string;
  owners: CrossRepoOwner[];
  references: CrossRepoReference[];
}

/** Looks up everything the workspace index knows about one Route/MessageContract/HubEvent
 * symbol, given its id *as it appears in its own repo's db* (a real, verb-prefixed Route id, or
 * an already-normalized MessageContract/HubEvent id) — normalizes internally so callers (the MCP
 * workspace tools) don't need to know the Route-specific id-reshaping rule above. */
export function lookupCrossRepo(index: CrossRepoIndex, kind: string, localSymbolId: string): CrossRepoLookupResult {
  const key = ownerKeyFor(kind, localSymbolId) ?? localSymbolId;
  return {
    key,
    owners: index.ownersByKey.get(key) ?? [],
    references: index.referencesByKey.get(key) ?? [],
  };
}
