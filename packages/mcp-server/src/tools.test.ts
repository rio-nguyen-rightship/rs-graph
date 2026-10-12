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
  // A second call site from the same caller — Bar.callIt calls Foo.doStuff from two lines.
  // Backs the dedup regression test below (one hit with two occurrences, not two hits).
  { record: "edge", edgeType: "CALLS", from: "Bar.callIt", to: "Foo.doStuff", line: 4 },
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
    const outline = await callTool("graph_get_file_outline", { filePath: "src/Bar.ts" });
    expect(outline.symbols.map((s: { name: string }) => s.name)).toEqual(["Bar", "callIt"]);
    expect(outline.truncated).toBe(false);
  });

  it("graph_get_file_outline caps at limit and reports truncated", async () => {
    const outline = await callTool("graph_get_file_outline", { filePath: "src/Bar.ts", limit: 1 });
    expect(outline.symbols).toHaveLength(1);
    expect(outline.truncated).toBe(true);
  });

  it("graph_get_file_outline defaults to compact, omitting signature unless detail: 'full' is passed", async () => {
    const compact = await callTool("graph_get_file_outline", { filePath: "src/Foo.ts" });
    const doStuffCompact = compact.symbols.find((s: { id: string }) => s.id === "Foo.doStuff");
    expect(doStuffCompact.signature).toBeUndefined();

    const full = await callTool("graph_get_file_outline", { filePath: "src/Foo.ts", detail: "full" });
    const doStuffFull = full.symbols.find((s: { id: string }) => s.id === "Foo.doStuff");
    expect(doStuffFull.signature).toBe("doStuff(): void");
    expect(doStuffFull.docSummary).toBe("Does the stuff.");
  });

  it("graph_get_route_map/di_graph/component_tree are paginated and compact by default", async () => {
    // Ingested into its own extra file/records rather than added to the shared FIXTURE, so this
    // doesn't perturb other tests' exact-count assertions (graph_stats, context_pack, etc.) —
    // the real regression this guards is an actual multi-megabyte response from an unbounded
    // component tree in a real Angular app; see queries.ts's getComponentTree for the full story.
    const extra: GraphRecord[] = [
      // A same-language ingest batch always represents the indexer's complete rescan of that
      // language, so unchanged FIXTURE files must be re-listed here too — otherwise ingest.ts
      // treats them as deleted from disk (see ingest.ts's deletedFiles handling).
      { record: "file", path: "src/Foo.ts", language: "typescript", contentHash: "h1", sizeBytes: 10 },
      { record: "file", path: "src/Bar.ts", language: "typescript", contentHash: "h2", sizeBytes: 10 },
      { record: "file", path: "src/Extra.ts", language: "typescript", contentHash: "hextra", sizeBytes: 10 },
      {
        record: "symbol",
        id: "Route.GetBar",
        name: "GET /bar",
        kind: "Route",
        signature: "GET /bar",
        filePath: "src/Extra.ts",
        startLine: 1,
        endLine: 1,
        modifiers: [],
        external: false,
      },
      {
        record: "symbol",
        id: "DIReg.1",
        name: "Foo -> FooImpl",
        kind: "DIRegistration",
        signature: "services.AddScoped<Foo, FooImpl>()",
        filePath: "src/Extra.ts",
        startLine: 2,
        endLine: 2,
        modifiers: [],
        external: false,
      },
      {
        // A component's owning symbol must be declared in the *same* ingest batch —
        // ingest.ts's component insertion resolves the owner file via this batch's own
        // symbolIdToFilePath map, not the database at large (see ingest.ts). Reusing "Bar" from
        // the earlier, separate FIXTURE ingest would silently skip the component insert.
        record: "symbol",
        id: "ExtraComponent",
        name: "ExtraComponent",
        kind: "Class",
        signature: "class ExtraComponent",
        filePath: "src/Extra.ts",
        startLine: 3,
        endLine: 6,
        modifiers: [],
        external: false,
      },
      { record: "edge", edgeType: "DEFINES", from: "src/Extra.ts", to: "Route.GetBar" },
      { record: "edge", edgeType: "DEFINES", from: "src/Extra.ts", to: "DIReg.1" },
      { record: "edge", edgeType: "DEFINES", from: "src/Extra.ts", to: "ExtraComponent" },
      { record: "edge", edgeType: "ROUTES_TO", from: "Route.GetBar", to: "Bar.callIt" },
      { record: "edge", edgeType: "REGISTERS", from: "DIReg.1", to: "Foo" },
      { record: "component", id: "ExtraComponent", name: "ExtraComponent", selector: "app-extra", framework: "angular" },
      { record: "edge", edgeType: "BINDS_TEMPLATE", from: "ExtraComponent", to: "Bar.callIt" },
    ];
    await ingestGraphRecords(db, extra);

    const routeMapCompact = await callTool("graph_get_route_map", {});
    expect(routeMapCompact.truncated).toBe(false);
    const routeCompact = routeMapCompact.routes.find((r: { route: { id: string } }) => r.route.id === "Route.GetBar");
    expect(routeCompact.route.signature).toBeUndefined();
    expect(routeCompact.handler.id).toBe("Bar.callIt");
    const routeMapFull = await callTool("graph_get_route_map", { detail: "full" });
    const routeFull = routeMapFull.routes.find((r: { route: { id: string } }) => r.route.id === "Route.GetBar");
    expect(routeFull.route.signature).toBe("GET /bar");

    const diGraph = await callTool("graph_get_di_graph", {});
    expect(diGraph.truncated).toBe(false);
    const registration = diGraph.registrations.find((r: { registration: { id: string } }) => r.registration.id === "DIReg.1");
    expect(registration.registration.signature).toBeUndefined();
    expect(registration.target.id).toBe("Foo");

    const componentTree = await callTool("graph_get_component_tree", {});
    expect(componentTree.truncated).toBe(false);
    const extraComponent = componentTree.components.find((c: { component: { id: string } }) => c.component.id === "ExtraComponent");
    expect(extraComponent.boundSymbols.map((s: { id: string }) => s.id)).toEqual(["Bar.callIt"]);
    expect(extraComponent.boundSymbols[0].signature).toBeUndefined();
  });

  it("graph_get_component_tree: componentId fetches one component directly, and maxBoundSymbols caps its boundSymbols with its own truncated flag", async () => {
    // Real-world regression: against an actual app, limit: 500 (well within the old schema's own
    // stated max) still produced a 1,750,937-character response — almost entirely from unbounded
    // per-component boundSymbols. componentId sidesteps the list/pagination question entirely for
    // the common case of wanting one specific component's bindings.
    const extra: GraphRecord[] = [
      { record: "file", path: "src/Foo.ts", language: "typescript", contentHash: "h1", sizeBytes: 10 },
      { record: "file", path: "src/Bar.ts", language: "typescript", contentHash: "h2", sizeBytes: 10 },
      { record: "file", path: "src/Big.ts", language: "typescript", contentHash: "hbig", sizeBytes: 10 },
      { record: "symbol", id: "BigComponent", name: "BigComponent", kind: "Class", signature: "class BigComponent", filePath: "src/Big.ts", startLine: 1, endLine: 20, modifiers: [], external: false },
      { record: "symbol", id: "BigComponent.a", name: "a", kind: "Property", signature: "a", filePath: "src/Big.ts", startLine: 2, endLine: 2, modifiers: [], external: false },
      { record: "symbol", id: "BigComponent.b", name: "b", kind: "Property", signature: "b", filePath: "src/Big.ts", startLine: 3, endLine: 3, modifiers: [], external: false },
      { record: "symbol", id: "BigComponent.c", name: "c", kind: "Property", signature: "c", filePath: "src/Big.ts", startLine: 4, endLine: 4, modifiers: [], external: false },
      { record: "edge", edgeType: "DEFINES", from: "src/Big.ts", to: "BigComponent" },
      { record: "edge", edgeType: "DEFINES", from: "src/Big.ts", to: "BigComponent.a" },
      { record: "edge", edgeType: "DEFINES", from: "src/Big.ts", to: "BigComponent.b" },
      { record: "edge", edgeType: "DEFINES", from: "src/Big.ts", to: "BigComponent.c" },
      { record: "component", id: "BigComponent", name: "BigComponent", selector: "app-big", framework: "angular" },
      { record: "edge", edgeType: "BINDS_TEMPLATE", from: "BigComponent", to: "BigComponent.a" },
      { record: "edge", edgeType: "BINDS_TEMPLATE", from: "BigComponent", to: "BigComponent.b" },
      { record: "edge", edgeType: "BINDS_TEMPLATE", from: "BigComponent", to: "BigComponent.c" },
    ];
    await ingestGraphRecords(db, extra);

    const byId = await callTool("graph_get_component_tree", { componentId: "BigComponent" });
    expect(byId.components).toHaveLength(1);
    expect(byId.truncated).toBe(false);

    const capped = await callTool("graph_get_component_tree", { componentId: "BigComponent", maxBoundSymbols: 2 });
    expect(capped.components[0].boundSymbols).toHaveLength(2);
    expect(capped.components[0].boundSymbolsTruncated).toBe(true);

    const uncapped = await callTool("graph_get_component_tree", { componentId: "BigComponent", maxBoundSymbols: 10 });
    expect(uncapped.components[0].boundSymbols).toHaveLength(3);
    expect(uncapped.components[0].boundSymbolsTruncated).toBe(false);
  });

  it("graph_get_route_map accepts limit/offset with a truncated flag", async () => {
    const extraRoutes: GraphRecord[] = [
      { record: "file", path: "src/Foo.ts", language: "typescript", contentHash: "h1", sizeBytes: 10 },
      { record: "file", path: "src/Bar.ts", language: "typescript", contentHash: "h2", sizeBytes: 10 },
      { record: "file", path: "src/Extra.ts", language: "typescript", contentHash: "hextra", sizeBytes: 10 },
      { record: "symbol", id: "Route.A", name: "GET /a", kind: "Route", signature: "GET /a", filePath: "src/Extra.ts", startLine: 1, endLine: 1, modifiers: [], external: false },
      { record: "symbol", id: "Route.B", name: "GET /b", kind: "Route", signature: "GET /b", filePath: "src/Extra.ts", startLine: 2, endLine: 2, modifiers: [], external: false },
      { record: "symbol", id: "Route.C", name: "GET /c", kind: "Route", signature: "GET /c", filePath: "src/Extra.ts", startLine: 3, endLine: 3, modifiers: [], external: false },
      { record: "edge", edgeType: "DEFINES", from: "src/Extra.ts", to: "Route.A" },
      { record: "edge", edgeType: "DEFINES", from: "src/Extra.ts", to: "Route.B" },
      { record: "edge", edgeType: "DEFINES", from: "src/Extra.ts", to: "Route.C" },
    ];
    await ingestGraphRecords(db, extraRoutes);

    const capped = await callTool("graph_get_route_map", { limit: 2 });
    expect(capped.routes).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    const uncapped = await callTool("graph_get_route_map", {});
    expect(uncapped.routes).toHaveLength(3);
    expect(uncapped.truncated).toBe(false);
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

  it("graph_get_callers/callees/references/class_hierarchy/impact_analysis accept filePath+line as an alternative to symbolId", async () => {
    // src/Foo.ts:3 is inside Foo.doStuff's span (lines 2-4) — same resolution graph_get_definition
    // already does, now reused so a compact search/outline hit (id-less by default) can jump
    // straight into traversal without a round trip through graph_get_definition first.
    const callers = await callTool("graph_get_callers", { filePath: "src/Foo.ts", line: 3 });
    expect(callers.map((r: { symbol: { id: string } }) => r.symbol.id)).toEqual(["Bar.callIt"]);

    const references = await callTool("graph_get_references", { filePath: "src/Foo.ts", line: 3 });
    expect(references.map((r: { symbol: { id: string } }) => r.symbol.id)).toEqual(["Bar.callIt"]);

    const callees = await callTool("graph_get_callees", { filePath: "src/Bar.ts", line: 3 });
    expect(callees.map((r: { symbol: { id: string } }) => r.symbol.id)).toEqual(["Foo.doStuff"]);

    const hierarchy = await callTool("graph_get_class_hierarchy", { filePath: "src/Bar.ts", line: 1 });
    expect(hierarchy.ancestors.map((a: { id: string }) => a.id)).toEqual(["Foo"]);

    const impact = await callTool("graph_impact_analysis", { filePath: "src/Foo.ts", line: 1 });
    expect(impact.symbols.map((s: { id: string }) => s.id)).toEqual(["Bar"]);
  });

  it("errors with a clear message when neither symbolId nor filePath+line resolves to a symbol", async () => {
    const result = await client.callTool({ name: "graph_get_callers", arguments: {} });
    expect(result.isError).toBe(true);

    const noMatch = await client.callTool({
      name: "graph_get_callers",
      arguments: { filePath: "src/Foo.ts", line: 999 },
    });
    expect(noMatch.isError).toBe(true);
  });

  it("the no-symbol-at-location error points at graph_get_file_outline instead of just saying 'not found'", async () => {
    // A line outside every symbol's span is a common but easy mistake when a caller only has a
    // file path and no specific line in mind (e.g. guessing line 1, which real files rarely
    // cover since they start with imports/usings first) — the error must say how to recover.
    const result = await client.callTool({
      name: "graph_get_definition",
      arguments: { filePath: "src/Foo.ts", line: 999 },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const { error } = JSON.parse(content[0]!.text) as { error: string };
    expect(error).toContain("graph_get_file_outline");
  });

  it("graph_search_symbol scope: 'name' excludes matches that only hit signature/docSummary", async () => {
    // "Does the stuff." is Foo.doStuff's docSummary — an unscoped search for "stuff" matches it,
    // but scope: 'name' must not, since "doStuff" doesn't contain "stuff" as its own token.
    const unscoped = await callTool("graph_search_symbol", { query: "stuff" });
    expect(unscoped.map((s: { id: string }) => s.id)).toContain("Foo.doStuff");

    const nameScoped = await callTool("graph_search_symbol", { query: "stuff", scope: "name" });
    expect(nameScoped.map((s: { id: string }) => s.id)).not.toContain("Foo.doStuff");

    const nameScopedRealMatch = await callTool("graph_search_symbol", { query: "doStuff", scope: "name" });
    expect(nameScopedRealMatch.map((s: { id: string }) => s.id)).toContain("Foo.doStuff");
  });

  it("graph_get_callers dedups multiple call sites from the same caller into one hit with multiple occurrences", async () => {
    // Bar.callIt calls Foo.doStuff from both line 3 and line 4 (see FIXTURE) — must come back as
    // one hit carrying both occurrences, not two hits each repeating Bar.callIt's full symbol.
    const callers = await callTool("graph_get_callers", { symbolId: "Foo.doStuff" });
    expect(callers).toHaveLength(1);
    expect(
      callers[0].occurrences.sort((a: { line: number }, b: { line: number }) => a.line - b.line),
    ).toEqual([
      { line: 3, col: null },
      { line: 4, col: null },
    ]);
  });

  it("list-returning tools default to a compact symbol shape, omitting signature/docSummary unless detail: 'full' is passed", async () => {
    const searchCompact = await callTool("graph_search_symbol", { query: "doStuff" });
    const doStuffCompact = searchCompact.find((s: { id: string }) => s.id === "Foo.doStuff");
    expect(doStuffCompact).toEqual({
      id: "Foo.doStuff",
      name: "doStuff",
      kind: "Method",
      filePath: "src/Foo.ts",
      startLine: 2,
      endLine: 4,
    });

    const searchFull = await callTool("graph_search_symbol", { query: "doStuff", detail: "full" });
    const doStuffFull = searchFull.find((s: { id: string }) => s.id === "Foo.doStuff");
    expect(doStuffFull.signature).toBe("doStuff(): void");
    expect(doStuffFull.docSummary).toBe("Does the stuff.");

    const callersCompact = await callTool("graph_get_callers", { symbolId: "Foo.doStuff" });
    expect(callersCompact[0].symbol.signature).toBeUndefined();
    const callersFull = await callTool("graph_get_callers", { symbolId: "Foo.doStuff", detail: "full" });
    expect(callersFull[0].symbol.signature).toBe("callIt(): void");

    const hierarchyCompact = await callTool("graph_get_class_hierarchy", { symbolId: "Bar" });
    expect(hierarchyCompact.ancestors[0].signature).toBeUndefined();
    expect(hierarchyCompact.ancestors[0].depth).toBe(1);
    const hierarchyFull = await callTool("graph_get_class_hierarchy", { symbolId: "Bar", detail: "full" });
    expect(hierarchyFull.ancestors[0].signature).toBe("class Foo");

    const impactCompact = await callTool("graph_impact_analysis", { symbolId: "Foo", depth: 3 });
    expect(impactCompact.symbols[0].signature).toBeUndefined();
    const impactFull = await callTool("graph_impact_analysis", { symbolId: "Foo", depth: 3, detail: "full" });
    expect(impactFull.symbols[0].signature).toBe("class Bar extends Foo");

    const packCompact = await callTool("graph_context_pack", { seedSymbolIds: ["Bar.callIt"], hops: 1 });
    const doStuffInPack = packCompact.symbols.find((s: { id: string }) => s.id === "Foo.doStuff");
    expect(doStuffInPack.signature).toBeUndefined();
    const packFull = await callTool("graph_context_pack", { seedSymbolIds: ["Bar.callIt"], hops: 1, detail: "full" });
    const doStuffInPackFull = packFull.symbols.find((s: { id: string }) => s.id === "Foo.doStuff");
    expect(doStuffInPackFull.signature).toBe("doStuff(): void");
  });

  it("graph_get_definition always returns full detail regardless of the other tools' compact default", async () => {
    const def = await callTool("graph_get_definition", { symbolId: "Foo.doStuff" });
    expect(def.signature).toBe("doStuff(): void");
    expect(def.docSummary).toBe("Does the stuff.");
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
