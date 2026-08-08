import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ExternalSymbolRegistry, type GraphRecord } from "@rs-graph/core-schema";
import { AngularEnricher } from "./angularEnrichment.js";
import { TsGraphBuilder } from "./graphBuilder.js";
import { loadProgram } from "./program.js";
import { ArraySink } from "./sink.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/sample-angular-app");
const TSCONFIG = path.join(FIXTURE_ROOT, "tsconfig.json");

describe("TsGraphBuilder + AngularEnricher against fixtures/sample-angular-app", () => {
  let records: GraphRecord[];

  beforeAll(() => {
    const { program, checker, ownedFiles, compilerOptions } = loadProgram(TSCONFIG);
    const sink = new ArraySink();
    const externalSymbols = new ExternalSymbolRegistry("typescript", (d) => `external:${d.groupKey ?? "unknown"}`);

    new TsGraphBuilder(FIXTURE_ROOT, sink, externalSymbols, checker, ownedFiles, compilerOptions).process(program);
    new AngularEnricher(FIXTURE_ROOT, sink, checker, ownedFiles).process(program);
    for (const record of externalSymbols.flush()) sink.write(record);

    records = sink.records;
  });

  function symbolsByKind(kind: string) {
    return records.filter((r) => r.record === "symbol" && r.kind === kind);
  }
  function edgesByType(edgeType: string) {
    return records.filter((r) => r.record === "edge" && r.edgeType === edgeType);
  }

  it("emits repo-relative file paths, not absolute ones", () => {
    const files = records.filter((r) => r.record === "file");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      if (f.record !== "file") continue;
      expect(path.isAbsolute(f.path)).toBe(false);
      expect(f.path.startsWith("src/")).toBe(true);
    }
  });

  it("emits classes, methods, and a property with correct names", () => {
    const classNames = symbolsByKind("Class").map((s) => (s.record === "symbol" ? s.name : undefined));
    expect(classNames).toEqual(
      expect.arrayContaining(["GreeterService", "AppComponent", "AboutComponent", "AppRoutingModule"]),
    );

    const methodNames = symbolsByKind("Method").map((s) => (s.record === "symbol" ? s.name : undefined));
    expect(methodNames).toEqual(expect.arrayContaining(["greet", "buildMessage", "constructor", "greetTitle"]));

    const properties = symbolsByKind("Property");
    expect(properties.some((s) => s.record === "symbol" && s.name === "title")).toBe(true);
  });

  it("emits interface members (not just the interface itself) as their own symbols", () => {
    // Previously only the interface declaration got a symbol row; its members (methods,
    // properties) were referenced by edges (IMPLEMENTS, CALLS) but never emitted themselves —
    // graph_get_definition/graph_get_file_outline on an interface method found nothing.
    const igreeterGreet = records.find(
      (r) => r.record === "symbol" && r.id === "typescript:src/greeter.service.ts#IGreeter.greet",
    );
    expect(igreeterGreet).toMatchObject({ kind: "Method", name: "greet" });
  });

  it("resolves a cross-file CALLS edge with line info (through the interface type, as real DI code resolves it)", () => {
    const calls = edgesByType("CALLS");
    const call = calls.find(
      (e) =>
        e.record === "edge" &&
        e.from === "typescript:src/app.component.ts#AppComponent.greetTitle" &&
        e.to === "typescript:src/greeter.service.ts#IGreeter.greet",
    );
    expect(call).toBeDefined();
    expect(call && "line" in call ? call.line : undefined).toBe(18);
  });

  it("emits an INJECTS edge for constructor-injected services (typed by interface)", () => {
    const injects = edgesByType("INJECTS");
    expect(
      injects.some(
        (e) =>
          e.record === "edge" &&
          e.from === "typescript:src/app.component.ts#AppComponent.constructor" &&
          e.to === "typescript:src/greeter.service.ts#IGreeter",
      ),
    ).toBe(true);
  });

  it("emits a member-level IMPLEMENTS edge so callers of the concrete method resolve through the interface", () => {
    // Regression test for a real-world bug: real DI code overwhelmingly calls through an
    // interface-typed reference, so the CALLS edge above points at IGreeter.greet, never
    // GreeterService.greet directly. Without this edge, graph_get_callers/graph_get_references
    // on the concrete method would silently return empty even though it's genuinely called —
    // graph-store's polymorphism-aware traversal depends on this edge to bridge the two.
    expect(
      edgesByType("IMPLEMENTS").some(
        (e) =>
          e.record === "edge" &&
          e.from === "typescript:src/greeter.service.ts#GreeterService.greet" &&
          e.to === "typescript:src/greeter.service.ts#IGreeter.greet",
      ),
    ).toBe(true);
  });

  it("emits IMPORTS edges between owned files only", () => {
    const imports = edgesByType("IMPORTS");
    expect(
      imports.some(
        (e) => e.record === "edge" && e.from === "src/app.component.ts" && e.to === "src/greeter.service.ts",
      ),
    ).toBe(true);
  });

  it("emits Component records with selector and templatePath", () => {
    const components = records.filter((r) => r.record === "component");
    const appComponent = components.find((c) => c.record === "component" && c.name === "AppComponent");
    expect(appComponent).toMatchObject({ selector: "app-root", templatePath: "src/app.component.html" });
  });

  it("resolves template bindings to real component members", () => {
    const binds = edgesByType("BINDS_TEMPLATE");
    const targets = binds
      .filter((e) => e.record === "edge" && e.from === "typescript:src/app.component.ts#AppComponent")
      .map((e) => (e.record === "edge" ? e.to : undefined));
    expect(targets).toEqual(
      expect.arrayContaining([
        "typescript:src/app.component.ts#AppComponent.title",
        "typescript:src/app.component.ts#AppComponent.greetTitle",
      ]),
    );
  });

  it("emits Route symbols mapped to the right component via ROUTES_TO", () => {
    const routes = symbolsByKind("Route");
    expect(routes).toHaveLength(2);

    const routesTo = edgesByType("ROUTES_TO");
    const aboutRoute = routes.find((r) => r.record === "symbol" && r.name === "ROUTE about");
    const edge = routesTo.find((e) => e.record === "edge" && aboutRoute && e.from === aboutRoute.id);
    expect(edge && "to" in edge ? edge.to : undefined).toBe("typescript:src/about.component.ts#AboutComponent");
  });

  it("is idempotent at the id level: re-running produces the same ids", () => {
    const { program, checker, ownedFiles, compilerOptions } = loadProgram(TSCONFIG);
    const sink2 = new ArraySink();
    const externalSymbols2 = new ExternalSymbolRegistry("typescript", (d) => `external:${d.groupKey ?? "unknown"}`);
    new TsGraphBuilder(FIXTURE_ROOT, sink2, externalSymbols2, checker, ownedFiles, compilerOptions).process(program);
    new AngularEnricher(FIXTURE_ROOT, sink2, checker, ownedFiles).process(program);

    const firstRunIds = records
      .filter((r): r is Extract<GraphRecord, { record: "symbol" }> => r.record === "symbol")
      .map((r) => r.id)
      .sort();
    const secondRunIds = sink2.records
      .filter((r): r is Extract<GraphRecord, { record: "symbol" }> => r.record === "symbol")
      .map((r) => r.id)
      .sort();
    expect(secondRunIds).toEqual(firstRunIds);
  });
});
