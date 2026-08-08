import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ExternalSymbolRegistry, type GraphRecord } from "@rs-graph/core-schema";
import { AureliaEnricher } from "./aureliaEnrichment.js";
import { TsGraphBuilder } from "./graphBuilder.js";
import { loadProgram } from "./program.js";
import { ArraySink } from "./sink.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../../../fixtures/sample-aurelia-app");
const TSCONFIG = path.join(FIXTURE_ROOT, "tsconfig.json");

describe("AureliaEnricher against fixtures/sample-aurelia-app", () => {
  let records: GraphRecord[];

  beforeAll(() => {
    const { program, checker, ownedFiles, compilerOptions } = loadProgram(TSCONFIG);
    const sink = new ArraySink();
    const externalSymbols = new ExternalSymbolRegistry("typescript", (d) => `external:${d.groupKey ?? "unknown"}`);

    new TsGraphBuilder(FIXTURE_ROOT, sink, externalSymbols, checker, ownedFiles, compilerOptions).process(program);
    new AureliaEnricher(FIXTURE_ROOT, sink, checker, ownedFiles).process(program);
    for (const record of externalSymbols.flush()) sink.write(record);

    records = sink.records;
  });

  function componentsByName(name: string) {
    return records.filter((r) => r.record === "component" && r.name === name);
  }
  function edgesByType(edgeType: string) {
    return records.filter((r) => r.record === "edge" && r.edgeType === edgeType);
  }

  it("detects components by view/view-model filename pairing, without needing a decorator", () => {
    const home = componentsByName("Home");
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({ framework: "aurelia", templatePath: "src/home.html" });

    const about = componentsByName("About");
    expect(about[0]).toMatchObject({ framework: "aurelia", templatePath: "src/about.html" });
  });

  it("surfaces @bindable and @autoinject decorators generically as modifiers", () => {
    const nameProp = records.find(
      (r) => r.record === "symbol" && r.id === "typescript:src/home.ts#Home.name",
    );
    expect(nameProp?.record === "symbol" && nameProp.modifiers).toContain("bindable");

    const homeClass = records.find((r) => r.record === "symbol" && r.id === "typescript:src/home.ts#Home");
    expect(homeClass?.record === "symbol" && homeClass.modifiers).toContain("autoinject");
  });

  it("resolves ${expr} template interpolations to real component members", () => {
    const binds = edgesByType("BINDS_TEMPLATE");
    expect(
      binds.some(
        (e) =>
          e.record === "edge" &&
          e.from === "typescript:src/app.ts#App" &&
          e.to === "typescript:src/app.ts#App.message",
      ),
    ).toBe(true);
    expect(
      binds.some(
        (e) =>
          e.record === "edge" &&
          e.from === "typescript:src/home.ts#Home" &&
          e.to === "typescript:src/home.ts#Home.greet",
      ),
    ).toBe(true);
  });

  it("resolves configureRouter's config.map([...]) moduleId routes to the target component's real class", () => {
    const routes = records.filter((r) => r.record === "symbol" && r.kind === "Route");
    expect(routes).toHaveLength(2);

    const routesTo = edgesByType("ROUTES_TO");
    const homeRoute = routes.find((r) => r.record === "symbol" && r.name === "ROUTE /");
    const aboutRoute = routes.find((r) => r.record === "symbol" && r.name === "ROUTE about");

    expect(
      routesTo.find((e) => e.record === "edge" && homeRoute && e.from === homeRoute.id)?.["to" as never],
    ).toBe("typescript:src/home.ts#Home");
    const aboutEdge = routesTo.find((e) => e.record === "edge" && aboutRoute && e.from === aboutRoute.id);
    expect(aboutEdge && "to" in aboutEdge ? aboutEdge.to : undefined).toBe("typescript:src/about.ts#About");
  });

  it("still resolves constructor injection and cross-file calls (framework-agnostic base pass)", () => {
    const injects = edgesByType("INJECTS");
    expect(
      injects.some(
        (e) =>
          e.record === "edge" &&
          e.from === "typescript:src/home.ts#Home.constructor" &&
          e.to === "typescript:src/greeter.ts#GreeterService",
      ),
    ).toBe(true);

    const calls = edgesByType("CALLS");
    expect(
      calls.some(
        (e) =>
          e.record === "edge" &&
          e.from === "typescript:src/home.ts#Home.greet" &&
          e.to === "typescript:src/greeter.ts#GreeterService.greet",
      ),
    ).toBe(true);
  });
});
