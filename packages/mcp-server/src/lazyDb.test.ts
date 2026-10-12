import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeGraphDb, ingestGraphRecords, openGraphDb } from "@rs-graph/graph-store";
import { createLazyDbGetter } from "./lazyDb.js";
import { createServer } from "./server.js";

describe("createLazyDbGetter", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-lazy-db-test-"));
    dbPath = path.join(tmpDir, "repo", ".rs-graph", "graph.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws a clear error and creates nothing while the repo isn't indexed", () => {
    const getDb = createLazyDbGetter(dbPath);
    expect(() => getDb()).toThrow(/hasn't been indexed yet/);
    expect(fs.existsSync(path.join(tmpDir, "repo"))).toBe(false);
  });

  it("reports in-progress indexing while the file exists but has no schema yet, then recovers", () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "");
    const getDb = createLazyDbGetter(dbPath);
    expect(() => getDb()).toThrow(/still in progress/);

    fs.rmSync(dbPath);
    closeGraphDb(openGraphDb({ dbPath }));
    expect(getDb()).toBeDefined();
    getDb.close();
  });

  it("lets a server started before indexing answer tool calls once the graph appears", async () => {
    const getDb = createLazyDbGetter(dbPath);
    const server = createServer(getDb);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const before = await client.callTool({ name: "graph_stats", arguments: {} });
    expect(before.isError).toBe(true);
    expect(JSON.stringify(before.content)).toMatch(/hasn't been indexed yet/);

    const db = openGraphDb({ dbPath });
    ingestGraphRecords(db, [
      { record: "file", path: "src/Foo.ts", language: "typescript", contentHash: "h1", sizeBytes: 10 },
    ]);
    closeGraphDb(db);

    const after = await client.callTool({ name: "graph_stats", arguments: {} });
    expect(after.isError).toBeFalsy();
    getDb.close();
  });
});
