import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeGraphDb, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { buildCrossRepoIndex, createLiveCrossRepoIndex, lookupCrossRepo } from "./resolveWorkspace.js";
import { isExistingDirectory, loadWorkspaceConfig, repoDbPath, type WorkspaceRepoConfig } from "./workspaceConfig.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-workspace-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRepo(name: string): WorkspaceRepoConfig {
  return { name, path: path.join(tmpRoot, name) };
}

/** Seeds a repo's .rs-graph/graph.db directly via SQL, bypassing any real indexer — this package
 * only ever reads Symbol/Edge rows, so a hand-built db exercises the same scan/join logic without
 * needing a slow real .NET/Python/TS build. */
function seedDb(repo: WorkspaceRepoConfig, seed: (db: GraphDb) => void): void {
  const db = openGraphDb({ dbPath: repoDbPath(repo) });
  try {
    db.prepare(`INSERT INTO File (path, language, contentHash, sizeBytes) VALUES ('f.cs', 'csharp', 'h', 1)`).run();
    seed(db);
  } finally {
    closeGraphDb(db);
  }
}

function insertSymbol(db: GraphDb, id: string, name: string, kind: string): void {
  db.prepare(
    `INSERT INTO Symbol (id, name, kind, signature, filePath, startLine, endLine, modifiers, external)
     VALUES (?, ?, ?, ?, 'f.cs', 1, 1, '[]', 0)`,
  ).run(id, name, kind, name);
}

function insertEdge(db: GraphDb, fromId: string, toId: string, edgeType: string): void {
  db.prepare(`INSERT INTO Edge (fromId, toId, edgeType, line, col) VALUES (?, ?, ?, NULL, NULL)`).run(
    fromId,
    toId,
    edgeType,
  );
}

describe("loadWorkspaceConfig", () => {
  it("resolves relative repo paths against the config file's own directory", () => {
    fs.mkdirSync(path.join(tmpRoot, "sibling-repo"));
    fs.writeFileSync(
      path.join(tmpRoot, "workspace.json"),
      JSON.stringify({ repos: [{ name: "sibling", path: "./sibling-repo" }] }),
    );

    const config = loadWorkspaceConfig(path.join(tmpRoot, "workspace.json"));
    expect(config.repos).toEqual([{ name: "sibling", path: path.join(tmpRoot, "sibling-repo") }]);
  });

  it("throws a clear error when repos is missing or not an array", () => {
    fs.writeFileSync(path.join(tmpRoot, "bad.json"), JSON.stringify({ notRepos: [] }));
    expect(() => loadWorkspaceConfig(path.join(tmpRoot, "bad.json"))).toThrow(/expected a top-level "repos" array/);
  });
});

describe("isExistingDirectory", () => {
  it("is true for a path that already exists as a directory", () => {
    const repoPath = path.join(tmpRoot, "real-repo");
    fs.mkdirSync(repoPath, { recursive: true });
    expect(isExistingDirectory(repoPath)).toBe(true);
  });

  it("is false for a path that doesn't exist yet — the signal a workspace.json path mistake left behind", () => {
    // Mirrors the real-world regression: a workspace.json repo path resolved against the wrong
    // base directory, landing on a path that had never existed. openGraphDb would have silently
    // `mkdir -p`'d it into existence just to hold a nearly-empty .rs-graph/graph.db — this check
    // catches the mistake first.
    expect(isExistingDirectory(path.join(tmpRoot, "never-existed"))).toBe(false);
  });

  it("is false for a path that exists but is a file, not a directory", () => {
    const filePath = path.join(tmpRoot, "some-file.txt");
    fs.writeFileSync(filePath, "not a repo");
    expect(isExistingDirectory(filePath)).toBe(false);
  });
});

describe("createLiveCrossRepoIndex", () => {
  it("picks up a repo re-indexed after the getter was created, without needing a new call site", () => {
    // Mirrors the real gap: a long-lived `serve-workspace` process whose repos get re-indexed by
    // `watch-workspace` or a git hook while it's still running — the getter must reflect that on
    // its next call, not just at the moment it was constructed.
    const repo = makeRepo("live-repo");
    seedDb(repo, () => {});
    const getIndex = createLiveCrossRepoIndex([repo]);

    expect(lookupCrossRepo(getIndex(), "Route", "csharp:route:GET:api/greeting").owners).toEqual([]);

    // Simulates a re-index writing more rows into the same already-existing db (not re-seeding
    // via seedDb, which would re-insert the same File row and violate its own PRIMARY KEY).
    const db = openGraphDb({ dbPath: repoDbPath(repo) });
    insertSymbol(db, "csharp:route:GET:api/greeting", "GET api/greeting", "Route");
    closeGraphDb(db);

    const result = lookupCrossRepo(getIndex(), "Route", "csharp:route:GET:api/greeting");
    expect(result.owners).toEqual([
      { repo: "live-repo", symbolId: "csharp:route:GET:api/greeting", name: "GET api/greeting", kind: "Route" },
    ]);
  });

  it("picks up a repo indexed for the first time after the getter was created", () => {
    const repo = makeRepo("not-yet-indexed");
    fs.mkdirSync(repo.path, { recursive: true });
    const getIndex = createLiveCrossRepoIndex([repo]);
    expect(getIndex().skippedRepos).toEqual(["not-yet-indexed"]);

    seedDb(repo, () => {});

    expect(getIndex().skippedRepos).toEqual([]);
  });

  it("does not rebuild when nothing changed", () => {
    const repo = makeRepo("stable-repo");
    seedDb(repo, (db) => insertSymbol(db, "csharp:route:GET:api/stable", "GET api/stable", "Route"));
    const getIndex = createLiveCrossRepoIndex([repo]);

    const first = getIndex();
    const second = getIndex();
    expect(second).toBe(first); // same object identity — no rebuild happened
  });
});

describe("buildCrossRepoIndex + lookupCrossRepo", () => {
  it("reports a repo with no .rs-graph/graph.db as skipped, not an error", () => {
    const repo = makeRepo("never-indexed");
    fs.mkdirSync(repo.path, { recursive: true });

    const index = buildCrossRepoIndex([repo]);
    expect(index.skippedRepos).toEqual(["never-indexed"]);
  });

  it("joins a Route's real verb-prefixed id against a verb-less INVOKES_ROUTE edge from another repo", () => {
    const producer = makeRepo("producer");
    const consumer = makeRepo("consumer");

    seedDb(producer, (db) => {
      insertSymbol(db, "csharp:route:GET:api/greeting/{name}", "GET api/greeting/{name}", "Route");
    });
    seedDb(consumer, (db) => {
      insertEdge(db, "csharp:global::Consumer.Client.Greet(string)", "xrepo:route:api/greeting/{name}", "INVOKES_ROUTE");
    });

    const index = buildCrossRepoIndex([producer, consumer]);
    const result = lookupCrossRepo(index, "Route", "csharp:route:GET:api/greeting/{name}");

    expect(result.key).toBe("xrepo:route:api/greeting/{name}");
    expect(result.owners).toEqual([
      { repo: "producer", symbolId: "csharp:route:GET:api/greeting/{name}", name: "GET api/greeting/{name}", kind: "Route" },
    ]);
    expect(result.references).toEqual([
      { repo: "consumer", fromSymbolId: "csharp:global::Consumer.Client.Greet(string)", edgeType: "INVOKES_ROUTE" },
    ]);
  });

  it("joins a MessageContract by its id directly, no reshaping, across publisher and consumer repos", () => {
    const publisherRepo = makeRepo("publisher");
    const consumerRepo = makeRepo("consumer");
    const key = "xrepo:message:OrderCreatedMessage";

    seedDb(publisherRepo, (db) => {
      insertSymbol(db, key, "OrderCreatedMessage", "MessageContract");
      insertEdge(db, "csharp:global::Publisher.OrderService.Create()", key, "PUBLISHES");
    });
    seedDb(consumerRepo, (db) => {
      insertSymbol(db, key, "OrderCreatedMessage", "MessageContract");
      insertEdge(db, "csharp:global::Consumer.OrderHandler", key, "CONSUMES");
    });

    const index = buildCrossRepoIndex([publisherRepo, consumerRepo]);
    const result = lookupCrossRepo(index, "MessageContract", key);

    expect(result.key).toBe(key);
    expect(result.owners.map((o) => o.repo).sort()).toEqual(["consumer", "publisher"]);
    expect(result.references).toEqual(
      expect.arrayContaining([
        { repo: "publisher", fromSymbolId: "csharp:global::Publisher.OrderService.Create()", edgeType: "PUBLISHES" },
        { repo: "consumer", fromSymbolId: "csharp:global::Consumer.OrderHandler", edgeType: "CONSUMES" },
      ]),
    );
  });

  it("returns empty owners/references for a key nothing references, rather than throwing", () => {
    const repo = makeRepo("empty");
    seedDb(repo, () => {});

    const index = buildCrossRepoIndex([repo]);
    const result = lookupCrossRepo(index, "HubEvent", "xrepo:signal:nothingUsesThis");

    expect(result).toEqual({ key: "xrepo:signal:nothingUsesThis", owners: [], references: [] });
  });
});
