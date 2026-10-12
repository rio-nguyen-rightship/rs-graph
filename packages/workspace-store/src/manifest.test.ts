import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeGraphDb, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { buildManifestForRepo } from "./manifest.js";
import { buildCrossRepoIndex } from "./resolveWorkspace.js";
import { repoDbPath, type WorkspaceRepoConfig } from "./workspaceConfig.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-manifest-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeRepo(name: string): WorkspaceRepoConfig {
  return { name, path: path.join(tmpRoot, name) };
}

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

describe("buildManifestForRepo", () => {
  it("lists a route this repo defines, with its cross-repo caller", () => {
    const producer = makeRepo("producer");
    const consumer = makeRepo("consumer");
    seedDb(producer, (db) =>
      insertSymbol(db, "csharp:route:GET:api/v1/vessel/{id}", "GET api/v1/vessel/{id}", "Route"),
    );
    seedDb(consumer, (db) =>
      insertEdge(db, "csharp:global::Consumer.Client.Get(int)", "xrepo:route:api/v1/vessel/{id}", "INVOKES_ROUTE"),
    );

    const index = buildCrossRepoIndex([producer, consumer]);
    const { markdown, json } = buildManifestForRepo(index, "producer", "workspace.json");

    expect(json.routesDefined).toEqual([
      {
        key: "xrepo:route:api/v1/vessel/{id}",
        name: "GET api/v1/vessel/{id}",
        counterparts: [{ repo: "consumer", symbolId: "csharp:global::Consumer.Client.Get(int)", role: "INVOKES_ROUTE" }],
      },
    ]);
    expect(json.routesCalled).toEqual([]);
    expect(markdown).toContain("## Routes this repo defines");
    expect(markdown).toContain("GET api/v1/vessel/{id}");
    expect(markdown).toContain("consumer");
  });

  it("lists a route this repo calls into another repo, with its known producer", () => {
    const producer = makeRepo("producer");
    const consumer = makeRepo("consumer");
    seedDb(producer, (db) =>
      insertSymbol(db, "csharp:route:GET:api/v1/vessel/{id}", "GET api/v1/vessel/{id}", "Route"),
    );
    seedDb(consumer, (db) =>
      insertEdge(db, "csharp:global::Consumer.Client.Get(int)", "xrepo:route:api/v1/vessel/{id}", "INVOKES_ROUTE"),
    );

    const index = buildCrossRepoIndex([producer, consumer]);
    const { markdown, json } = buildManifestForRepo(index, "consumer", "workspace.json");

    expect(json.routesDefined).toEqual([]);
    expect(json.routesCalled).toEqual([
      {
        key: "xrepo:route:api/v1/vessel/{id}",
        name: "GET api/v1/vessel/{id}",
        counterparts: [{ repo: "producer", symbolId: "csharp:route:GET:api/v1/vessel/{id}", role: "producer" }],
      },
    ]);
    expect(markdown).toContain("## Routes this repo calls in other repos");
  });

  it("splits a message into published vs. consumed buckets based on this repo's own edge, not ownership", () => {
    // Both sides own a real Symbol row for the same MessageContract id (unlike Route, where only
    // the producer does) — so which bucket a repo lands in must come from its own PUBLISHES/
    // CONSUMES edge, not from whether it owns a row for the key at all.
    const publisher = makeRepo("publisher");
    const consumer = makeRepo("consumer");
    const key = "xrepo:message:OrderCreatedMessage";

    seedDb(publisher, (db) => {
      insertSymbol(db, key, "OrderCreatedMessage", "MessageContract");
      insertEdge(db, "csharp:global::Publisher.OrderService.Create()", key, "PUBLISHES");
    });
    seedDb(consumer, (db) => {
      insertSymbol(db, key, "OrderCreatedMessage", "MessageContract");
      insertEdge(db, "csharp:global::Consumer.OrderHandler", key, "CONSUMES");
    });

    const index = buildCrossRepoIndex([publisher, consumer]);

    const publisherManifest = buildManifestForRepo(index, "publisher", "workspace.json").json;
    expect(publisherManifest.messagesPublished).toEqual([
      {
        key,
        name: "OrderCreatedMessage",
        counterparts: [{ repo: "consumer", symbolId: "csharp:global::Consumer.OrderHandler", role: "consumer" }],
      },
    ]);
    expect(publisherManifest.messagesConsumed).toEqual([]);

    const consumerManifest = buildManifestForRepo(index, "consumer", "workspace.json").json;
    expect(consumerManifest.messagesConsumed).toEqual([
      {
        key,
        name: "OrderCreatedMessage",
        counterparts: [{ repo: "publisher", symbolId: "csharp:global::Publisher.OrderService.Create()", role: "publisher" }],
      },
    ]);
    expect(consumerManifest.messagesPublished).toEqual([]);
  });

  it("renders a stable, human-readable markdown header naming the generation source", () => {
    const repo = makeRepo("empty");
    seedDb(repo, () => {});
    const index = buildCrossRepoIndex([repo]);

    const { markdown } = buildManifestForRepo(index, "empty", "C:/workspace.json");

    expect(markdown).toContain("# Cross-repo integration surface: empty");
    expect(markdown).toContain("rs-graph generate-manifest C:/workspace.json");
    expect(markdown).toContain("_(none)_");
  });
});
