import { beforeEach, describe, expect, it } from "vitest";
import type { GraphRecord } from "@rs-graph/core-schema";
import { openGraphDb, type GraphDb } from "./db.js";
import { ingestGraphRecords } from "./ingest.js";
import {
  contextPack,
  getCallers,
  getCallees,
  getClassHierarchy,
  getComponentTree,
  getDefinitionAtLocation,
  getDependencies,
  getDiGraph,
  getFileOutline,
  getReferences,
  getRouteMap,
  getStats,
  getSymbolById,
  impactAnalysis,
  searchSymbol,
} from "./queries.js";

const FIXTURE: GraphRecord[] = [
  { record: "file", path: "src/IFoo.cs", language: "csharp", contentHash: "h1", sizeBytes: 10 },
  { record: "file", path: "src/Foo.cs", language: "csharp", contentHash: "h2", sizeBytes: 20 },
  { record: "file", path: "src/Bar.cs", language: "csharp", contentHash: "h3", sizeBytes: 30 },
  { record: "file", path: "src/Startup.cs", language: "csharp", contentHash: "h4", sizeBytes: 15 },
  {
    record: "file",
    path: "src/app.component.ts",
    language: "typescript",
    contentHash: "h5",
    sizeBytes: 25,
  },

  {
    record: "symbol",
    id: "IFoo",
    name: "IFoo",
    kind: "Interface",
    signature: "public interface IFoo",
    filePath: "src/IFoo.cs",
    startLine: 1,
    endLine: 3,
    modifiers: ["public"],
    external: false,
  },
  {
    record: "symbol",
    id: "Foo",
    name: "Foo",
    kind: "Class",
    signature: "public class Foo : IFoo",
    filePath: "src/Foo.cs",
    startLine: 1,
    endLine: 10,
    modifiers: ["public"],
    external: false,
  },
  {
    record: "symbol",
    id: "Foo.baseMethod",
    name: "baseMethod",
    kind: "Method",
    signature: "public void baseMethod()",
    filePath: "src/Foo.cs",
    startLine: 5,
    endLine: 7,
    modifiers: ["public"],
    external: false,
  },
  {
    record: "symbol",
    id: "IFoo.doWork",
    name: "doWork",
    kind: "Method",
    signature: "void doWork()",
    filePath: "src/IFoo.cs",
    startLine: 2,
    endLine: 2,
    modifiers: ["public", "abstract"],
    external: false,
  },
  {
    record: "symbol",
    id: "Foo.doWork",
    name: "doWork",
    kind: "Method",
    signature: "public void doWork()",
    filePath: "src/Foo.cs",
    startLine: 8,
    endLine: 9,
    modifiers: ["public"],
    external: false,
  },
  {
    record: "symbol",
    id: "Bar",
    name: "Bar",
    kind: "Class",
    signature: "public class Bar : Foo",
    filePath: "src/Bar.cs",
    startLine: 1,
    endLine: 12,
    modifiers: ["public"],
    external: false,
  },
  {
    record: "symbol",
    id: "Bar.doStuff",
    name: "doStuff",
    kind: "Method",
    signature: "public void doStuff()",
    docSummary: "Does stuff.",
    filePath: "src/Bar.cs",
    startLine: 5,
    endLine: 8,
    modifiers: ["public"],
    external: false,
  },
  {
    record: "symbol",
    id: "Route.GetBar",
    name: "GET /bar",
    kind: "Route",
    signature: "[HttpGet(\"/bar\")]",
    filePath: "src/Bar.cs",
    startLine: 4,
    endLine: 4,
    modifiers: [],
    external: false,
  },
  {
    record: "symbol",
    id: "DIReg.1",
    name: "AddScoped<IFoo, Foo>",
    kind: "DIRegistration",
    signature: "services.AddScoped<IFoo, Foo>()",
    filePath: "src/Startup.cs",
    startLine: 10,
    endLine: 10,
    modifiers: [],
    external: false,
  },
  {
    record: "symbol",
    id: "AppComponent",
    name: "AppComponent",
    kind: "Component",
    signature: "class AppComponent",
    filePath: "src/app.component.ts",
    startLine: 1,
    endLine: 6,
    modifiers: [],
    external: false,
  },
  {
    record: "symbol",
    id: "AppComponent.title",
    name: "title",
    kind: "Property",
    signature: "title: string",
    filePath: "src/app.component.ts",
    startLine: 2,
    endLine: 2,
    modifiers: [],
    external: false,
  },

  {
    record: "component",
    id: "AppComponent",
    name: "AppComponent",
    selector: "app-root",
    framework: "angular",
    templatePath: "src/app.component.html",
  },

  { record: "edge", edgeType: "DEFINES", from: "src/IFoo.cs", to: "IFoo" },
  { record: "edge", edgeType: "DEFINES", from: "src/IFoo.cs", to: "IFoo.doWork" },
  { record: "edge", edgeType: "DEFINES", from: "src/Foo.cs", to: "Foo" },
  { record: "edge", edgeType: "DEFINES", from: "src/Foo.cs", to: "Foo.baseMethod" },
  { record: "edge", edgeType: "DEFINES", from: "src/Foo.cs", to: "Foo.doWork" },
  { record: "edge", edgeType: "DEFINES", from: "src/Bar.cs", to: "Bar" },
  { record: "edge", edgeType: "DEFINES", from: "src/Bar.cs", to: "Bar.doStuff" },
  { record: "edge", edgeType: "DEFINES", from: "src/Bar.cs", to: "Route.GetBar" },
  { record: "edge", edgeType: "DEFINES", from: "src/Startup.cs", to: "DIReg.1" },
  { record: "edge", edgeType: "DEFINES", from: "src/app.component.ts", to: "AppComponent" },
  { record: "edge", edgeType: "DEFINES", from: "src/app.component.ts", to: "AppComponent.title" },

  { record: "edge", edgeType: "IMPLEMENTS", from: "Foo", to: "IFoo" },
  { record: "edge", edgeType: "IMPLEMENTS", from: "Foo.doWork", to: "IFoo.doWork" },
  { record: "edge", edgeType: "EXTENDS", from: "Bar", to: "Foo" },
  { record: "edge", edgeType: "CALLS", from: "Bar.doStuff", to: "Foo.baseMethod", line: 6 },
  // Bar.doStuff calls doWork() through an IFoo-typed reference — Roslyn/the TS checker resolve
  // this to the *interface* method, never Foo.doWork directly, which is the real-world pattern
  // that made graph_get_callers silently return empty for a heavily-called concrete method.
  { record: "edge", edgeType: "CALLS", from: "Bar.doStuff", to: "IFoo.doWork", line: 7 },
  { record: "edge", edgeType: "ROUTES_TO", from: "Route.GetBar", to: "Bar.doStuff" },
  { record: "edge", edgeType: "REGISTERS", from: "DIReg.1", to: "Foo" },
  { record: "edge", edgeType: "INJECTS", from: "Bar.doStuff", to: "IFoo" },
  { record: "edge", edgeType: "IMPORTS", from: "src/Bar.cs", to: "src/Foo.cs" },
  { record: "edge", edgeType: "BINDS_TEMPLATE", from: "AppComponent", to: "AppComponent.title" },
];

describe("graph-store", () => {
  let db: GraphDb;

  beforeEach(() => {
    db = openGraphDb({ dbPath: ":memory:" });
    ingestGraphRecords(db, FIXTURE);
  });

  it("computes repo-wide stats", () => {
    const stats = getStats(db);
    expect(stats.totalFiles).toBe(5);
    expect(stats.totalSymbols).toBe(11);
    expect(stats.byKind.Method).toBe(4);
    expect(stats.byLanguage.csharp).toBe(4);
    expect(stats.byLanguage.typescript).toBe(1);
  });

  it("returns a file outline ordered by line", () => {
    const outline = getFileOutline(db, "src/Bar.cs");
    expect(outline.map((s) => s.name)).toEqual(["Bar", "GET /bar", "doStuff"]);
  });

  it("finds the definition at a given file location, preferring the most nested span", () => {
    const def = getDefinitionAtLocation(db, "src/Bar.cs", 6);
    expect(def?.id).toBe("Bar.doStuff");
  });

  it("full-text searches symbols by name/signature/doc", () => {
    const results = searchSymbol(db, { query: "stuff" });
    expect(results.map((s) => s.id)).toContain("Bar.doStuff");
  });

  it("finds callers and callees across a CALLS edge", () => {
    expect(getCallers(db, "Foo.baseMethod").map((r) => r.symbol.id)).toEqual(["Bar.doStuff"]);
    expect(getCallees(db, "Bar.doStuff").map((r) => r.symbol.id).sort()).toEqual(["Foo.baseMethod", "IFoo.doWork"]);
  });

  it("includes both CALLS and REFERENCES in getReferences", () => {
    const refs = getReferences(db, "Foo.baseMethod");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.line).toBe(6);
  });

  it("finds callers of a concrete method reached only through the interface it implements", () => {
    // The CALLS edge points at IFoo.doWork (the real-world resolution when calling through an
    // interface-typed reference) — querying the interface method directly already worked...
    expect(getCallers(db, "IFoo.doWork").map((r) => r.symbol.id)).toEqual(["Bar.doStuff"]);
    // ...but this is the regression case: querying the *concrete implementation* must also
    // surface that same caller, via the IMPLEMENTS edge from Foo.doWork to IFoo.doWork.
    expect(getCallers(db, "Foo.doWork").map((r) => r.symbol.id)).toEqual(["Bar.doStuff"]);
    expect(getReferences(db, "Foo.doWork").map((r) => r.symbol.id)).toEqual(["Bar.doStuff"]);
  });

  it("walks class hierarchy ancestors and descendants through EXTENDS/IMPLEMENTS", () => {
    const hierarchy = getClassHierarchy(db, "Bar");
    expect(hierarchy.ancestors.map((s) => s.id)).toEqual(["Foo", "IFoo"]);

    const fooHierarchy = getClassHierarchy(db, "Foo");
    expect(fooHierarchy.descendants.map((s) => s.id)).toEqual(["Bar"]);
  });

  it("reports file-level import dependencies in both directions", () => {
    expect(getDependencies(db, "src/Bar.cs").imports).toEqual(["src/Foo.cs"]);
    expect(getDependencies(db, "src/Foo.cs").importedBy).toEqual(["src/Bar.cs"]);
  });

  it("computes transitive impact through calls, inheritance, and injection", () => {
    const impacted = impactAnalysis(db, "IFoo", 3);
    const ids = impacted.symbols.map((s) => s.id);
    expect(ids).toContain("Foo"); // IMPLEMENTS
    expect(ids).toContain("Bar.doStuff"); // INJECTS
    expect(impacted.truncated).toBe(false);
  });

  it("caps impact analysis results and reports truncation", () => {
    const capped = impactAnalysis(db, "IFoo", 3, 1);
    expect(capped.symbols).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("maps routes to their handler symbol", () => {
    const routes = getRouteMap(db);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.route.id).toBe("Route.GetBar");
    expect(routes[0]?.handler?.id).toBe("Bar.doStuff");
  });

  it("maps DI registrations to their target symbol", () => {
    const registrations = getDiGraph(db);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.target?.id).toBe("Foo");
  });

  it("maps components to their template-bound symbols", () => {
    const tree = getComponentTree(db);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.component.selector).toBe("app-root");
    expect(tree[0]?.boundSymbols.map((s) => s.id)).toEqual(["AppComponent.title"]);
  });

  it("builds a bounded context pack around seed symbols", () => {
    const pack = contextPack(db, ["Bar.doStuff"], 1);
    const ids = pack.symbols.map((s) => s.id).sort();
    expect(ids).toEqual(["Bar.doStuff", "Foo.baseMethod", "IFoo", "IFoo.doWork", "Route.GetBar"].sort());
    expect(pack.truncated).toBe(false);
  });

  it("is idempotent: re-ingesting the same batch does not duplicate rows", () => {
    ingestGraphRecords(db, FIXTURE);
    const stats = getStats(db);
    expect(stats.totalSymbols).toBe(11);
    expect(getCallers(db, "Foo.baseMethod")).toHaveLength(1);
  });

  it("replaces a changed file's symbols/edges but leaves unchanged files alone", () => {
    const updated: GraphRecord[] = [
      { record: "file", path: "src/Bar.cs", language: "csharp", contentHash: "h3-changed", sizeBytes: 31 },
      {
        record: "symbol",
        id: "Bar",
        name: "Bar",
        kind: "Class",
        signature: "public class Bar : Foo",
        filePath: "src/Bar.cs",
        startLine: 1,
        endLine: 5,
        modifiers: ["public"],
        external: false,
      },
      { record: "edge", edgeType: "DEFINES", from: "src/Bar.cs", to: "Bar" },
      { record: "edge", edgeType: "EXTENDS", from: "Bar", to: "Foo" },
    ];
    const result = ingestGraphRecords(db, updated);
    expect(result.filesChanged).toBe(1);

    // Bar.doStuff and the route symbol were dropped from the new batch for this file,
    // so they should be gone; Foo (a different, unchanged file) must be untouched.
    expect(getFileOutline(db, "src/Bar.cs").map((s) => s.id)).toEqual(["Bar"]);
    expect(getFileOutline(db, "src/Foo.cs").map((s) => s.id)).toEqual(["Foo", "Foo.baseMethod", "Foo.doWork"]);
  });

  it("dedupes a symbol id that appears as both an owned declaration and an external stub", () => {
    // Mirrors a real cross-project collision (seen indexing a multi-project .NET solution):
    // one project defines a type in source, a sibling project in the same solution only sees
    // it through a compiled reference and the indexer — correctly, from that project's own
    // point of view — treats it as external. Both compute the same id. Without dedup this
    // violates Symbol.id's PRIMARY KEY and the whole ingest batch fails.
    const withCollision: GraphRecord[] = [
      { record: "file", path: "src/Shared.cs", language: "csharp", contentHash: "hc1", sizeBytes: 10 },
      { record: "file", path: "external:Shared.Package", language: "csharp", contentHash: "hc2", sizeBytes: 0 },
      {
        record: "symbol",
        id: "Shared.Base",
        name: "Base",
        kind: "Class",
        signature: "public abstract class Base",
        filePath: "src/Shared.cs",
        startLine: 1,
        endLine: 5,
        modifiers: ["public", "abstract"],
        external: false,
      },
      {
        record: "symbol",
        id: "Shared.Base",
        name: "Base",
        kind: "Class",
        signature: "Base",
        filePath: "external:Shared.Package",
        startLine: 0,
        endLine: 0,
        modifiers: [],
        external: true,
      },
    ];

    expect(() => ingestGraphRecords(db, withCollision)).not.toThrow();

    const symbol = getSymbolById(db, "Shared.Base");
    expect(symbol?.external).toBe(false);
    expect(symbol?.filePath).toBe("src/Shared.cs");
    expect(getStats(db).totalSymbols).toBe(12); // 11 from FIXTURE + 1 deduped (not 2) for the collided id
  });

  it("redacts likely secrets out of signatures and doc summaries before persisting", () => {
    const withSecret: GraphRecord[] = [
      { record: "file", path: "src/Startup.cs", language: "csharp", contentHash: "hs", sizeBytes: 5 },
      {
        record: "symbol",
        id: "Startup.Configure",
        name: "Configure",
        kind: "Method",
        signature: 'services.AddDbContext(o => o.UseSqlServer("password=hunter2;Server=x"))',
        docSummary: "Uses apiKey: 'sk-abc123def456' internally.",
        filePath: "src/Startup.cs",
        startLine: 1,
        endLine: 1,
        modifiers: [],
        external: false,
      },
      { record: "edge", edgeType: "DEFINES", from: "src/Startup.cs", to: "Startup.Configure" },
    ];
    ingestGraphRecords(db, withSecret);

    const symbol = getFileOutline(db, "src/Startup.cs")[0];
    expect(symbol?.signature).not.toContain("hunter2");
    expect(symbol?.signature).toContain("password=[REDACTED]");
    expect(symbol?.docSummary).not.toContain("sk-abc123def456");

    // The redacted text, not the raw secret, is what full-text search indexes too.
    expect(searchSymbol(db, { query: "hunter2" })).toHaveLength(0);
  });
});
