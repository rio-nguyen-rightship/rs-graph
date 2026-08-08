import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GraphRecord } from "@rs-graph/core-schema";
import { ingestGraphRecords, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { createServer } from "./server.js";

const FIXTURE: GraphRecord[] = [
  { record: "file", path: "src/Foo.ts", language: "typescript", contentHash: "h1", sizeBytes: 10 },
  { record: "file", path: "src/Bar.ts", language: "typescript", contentHash: "h2", sizeBytes: 10 },
  {
    record: "symbol",
    id: "Foo",
    name: "Foo",
    kind: "Class",
    signature: "class Foo",
    filePath: "src/Foo.ts",
    startLine: 1,
    endLine: 5,
    modifiers: [],
    external: false,
  },
  {
    record: "symbol",
    id: "Foo.doStuff",
    name: "doStuff",
    kind: "Method",
    signature: "doStuff(): void",
    docSummary: "Does the stuff.",
    filePath: "src/Foo.ts",
    startLine: 2,
    endLine: 4,
    modifiers: [],
    external: false,
  },
  {
    record: "symbol",
    id: "Bar",
    name: "Bar",
    kind: "Class",
    signature: "class Bar extends Foo",
    filePath: "src/Bar.ts",
    startLine: 1,
    endLine: 8,
    modifiers: [],
    external: false,
  },
  {
    record: "symbol",
    id: "Bar.callIt",
    name: "callIt",
    kind: "Method",
    signature: "callIt(): void",
    filePath: "src/Bar.ts",
    startLine: 2,
    endLine: 4,
    modifiers: [],
    external: false,
  },
  { record: "edge", edgeType: "DEFINES", from: "src/Foo.ts", to: "Foo" },
  { record: "edge", edgeType: "DEFINES", from: "src/Foo.ts", to: "Foo.doStuff" },
  { record: "edge", edgeType: "DEFINES", from: "src/Bar.ts", to: "Bar" },
  { record: "edge", edgeType: "DEFINES", from: "src/Bar.ts", to: "Bar.callIt" },
  { record: "edge", edgeType: "EXTENDS", from: "Bar", to: "Foo" },
  { record: "edge", edgeType: "CALLS", from: "Bar.callIt", to: "Foo.doStuff", line: 3 },
];

describe("mcp-server tools (via a real MCP Client<->Server pair)", () => {
  let db: GraphDb;
  let client: Client;

  beforeEach(async () => {
    db = openGraphDb({ dbPath: ":memory:" });
    ingestGraphRecords(db, FIXTURE);

    const server = createServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]!.text);
  }

  it("lists all registered tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "graph_stats",
        "graph_search_symbol",
        "graph_get_file_outline",
        "graph_get_definition",
        "graph_get_references",
        "graph_get_callers",
        "graph_get_callees",
        "graph_get_class_hierarchy",
        "graph_get_dependencies",
        "graph_impact_analysis",
        "graph_get_route_map",
        "graph_get_di_graph",
        "graph_get_component_tree",
        "graph_context_pack",
      ]),
    );
  });

  it("graph_stats reports repo-wide counts", async () => {
    const stats = await callTool("graph_stats");
    expect(stats).toEqual({ totalFiles: 2, totalSymbols: 4, byKind: { Class: 2, Method: 2 }, byLanguage: { typescript: 2 } });
  });

  it("graph_search_symbol finds a symbol by name", async () => {
    const results = await callTool("graph_search_symbol", { query: "doStuff" });
    expect(results.map((r: { id: string }) => r.id)).toContain("Foo.doStuff");
  });

  it("graph_get_file_outline lists a file's symbols in order", async () => {
    const outline = await callTool("graph_get_file_outline", { path: "src/Bar.ts" });
    expect(outline.map((s: { name: string }) => s.name)).toEqual(["Bar", "callIt"]);
  });

  it("graph_get_definition resolves by symbolId", async () => {
    const def = await callTool("graph_get_definition", { symbolId: "Foo.doStuff" });
    expect(def.docSummary).toBe("Does the stuff.");
  });

  it("graph_get_definition resolves by filePath+line", async () => {
    const def = await callTool("graph_get_definition", { filePath: "src/Foo.ts", line: 3 });
    expect(def.id).toBe("Foo.doStuff");
  });

  it("graph_get_definition errors when given neither symbolId nor filePath+line", async () => {
    const result = await client.callTool({ name: "graph_get_definition", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("graph_get_callers / graph_get_callees traverse the call graph", async () => {
    const callers = await callTool("graph_get_callers", { symbolId: "Foo.doStuff" });
    expect(callers.map((r: { symbol: { id: string } }) => r.symbol.id)).toEqual(["Bar.callIt"]);

    const callees = await callTool("graph_get_callees", { symbolId: "Bar.callIt" });
    expect(callees.map((r: { symbol: { id: string } }) => r.symbol.id)).toEqual(["Foo.doStuff"]);
  });

  it("graph_get_class_hierarchy walks EXTENDS", async () => {
    const hierarchy = await callTool("graph_get_class_hierarchy", { symbolId: "Bar" });
    expect(hierarchy.ancestors.map((a: { id: string }) => a.id)).toEqual(["Foo"]);
  });

  it("graph_impact_analysis finds transitive dependents, wrapped with a truncated flag", async () => {
    const impactedViaExtends = await callTool("graph_impact_analysis", { symbolId: "Foo", depth: 3 });
    expect(impactedViaExtends.symbols.map((s: { id: string }) => s.id)).toEqual(["Bar"]);
    expect(impactedViaExtends.truncated).toBe(false);

    const impactedViaCall = await callTool("graph_impact_analysis", { symbolId: "Foo.doStuff", depth: 3 });
    expect(impactedViaCall.symbols.map((s: { id: string }) => s.id)).toEqual(["Bar.callIt"]);

    const capped = await callTool("graph_impact_analysis", { symbolId: "Foo", depth: 3, maxResults: 1 });
    expect(capped.symbols).toHaveLength(1);
    expect(capped.truncated).toBe(false); // only 1 result exists total, so capping at 1 isn't truncating anything
  });

  it("graph_context_pack returns a bounded subgraph around a seed", async () => {
    const pack = await callTool("graph_context_pack", { seedSymbolIds: ["Bar.callIt"], hops: 1 });
    expect(pack.symbols.map((s: { id: string }) => s.id).sort()).toEqual(["Bar.callIt", "Foo.doStuff"]);
  });
});
