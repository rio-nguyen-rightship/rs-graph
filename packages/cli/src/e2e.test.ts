import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { createServer } from "@rs-graph/mcp-server";
import { runIndex } from "./commands/indexRepo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DOTNET_INDEXER_SRC = path.join(REPO_ROOT, "packages/indexer-dotnet/src");
const DOTNET_FIXTURE = path.join(REPO_ROOT, "fixtures/sample-dotnet-api");
const ANGULAR_FIXTURE = path.join(REPO_ROOT, "fixtures/sample-angular-app");
const PYTHON_FIXTURE = path.join(REPO_ROOT, "fixtures/sample-python-api");
const AURELIA_FIXTURE = path.join(REPO_ROOT, "fixtures/sample-aurelia-app");

function rmRsGraphDir(repoPath: string): void {
  fs.rmSync(path.join(repoPath, ".rs-graph"), { recursive: true, force: true });
  fs.rmSync(path.join(repoPath, ".mcp.json"), { force: true });
}

async function callTool(dbPath: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  let db: GraphDb | undefined;
  try {
    db = openGraphDb({ dbPath });
    const server = createServer(db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "e2e-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    await client.close();
    return JSON.parse(content[0]!.text);
  } finally {
    db?.close();
  }
}

describe("end-to-end: rs-graph index + serve across every language fixture", () => {
  beforeAll(() => {
    // Restoring/building our own indexer + our own test fixture — not a target repo, see the
    // security note in docs/architecture.md.
    execFileSync("dotnet", ["build"], { cwd: DOTNET_INDEXER_SRC, stdio: "pipe" });
    // Explicit SampleApi.slnx: the fixture has two .sln/.slnx files (see the --sln override
    // test below), and a bare `dotnet restore`/`build` fails with an ambiguity error once more
    // than one project/solution file is present in the directory.
    execFileSync("dotnet", ["restore", "SampleApi.slnx"], { cwd: DOTNET_FIXTURE, stdio: "pipe" });
    execFileSync("dotnet", ["build", "SampleApi.slnx"], { cwd: DOTNET_FIXTURE, stdio: "pipe" });
  }, 60_000);

  afterEach(() => {
    rmRsGraphDir(DOTNET_FIXTURE);
    rmRsGraphDir(ANGULAR_FIXTURE);
    rmRsGraphDir(PYTHON_FIXTURE);
    rmRsGraphDir(AURELIA_FIXTURE);
  });

  // Backstop beyond afterEach: when this file runs alongside others in the same vitest
  // invocation, the last afterEach can race worker teardown and leave the final test's
  // artifacts behind — this guarantees a clean end state regardless.
  afterAll(() => {
    rmRsGraphDir(DOTNET_FIXTURE);
    rmRsGraphDir(ANGULAR_FIXTURE);
    rmRsGraphDir(PYTHON_FIXTURE);
    rmRsGraphDir(AURELIA_FIXTURE);
  });

  it(
    "indexes and serves the .NET fixture via a real MCP tool call",
    async () => {
      // Explicit --sln rather than relying on auto-detection's pick order: the fixture now
      // has two .sln/.slnx files (see the --sln override test below) specifically so ordering
      // assumptions can't make this test flaky.
      await runIndex(DOTNET_FIXTURE, { slnPath: "SampleApi.slnx" });
      const dbPath = path.join(DOTNET_FIXTURE, ".rs-graph", "graph.db");

      const stats = (await callTool(dbPath, "graph_stats")) as { totalFiles: number; byLanguage: Record<string, number> };
      // 16 real .cs files (Domain/{IGreeter,Greeter,Greeter.Diagnostics,AsyncGreeter}.cs, Api/
      // {GreetingController,Program,VesselLookupService,VesselRawHttpClientLookup,
      // AsyncGreeterConsumer,Clients/VesselApiClient,
      // Messaging/{Messaging,VoyageChecklistPublisher,VoyageChecklistConsumer},
      // Signaling/{Signaling,VoyageStatusPublisher,OnboardingHubInterceptor}}.cs)
      // + 6 external pseudo-files. Fixing indexer-dotnet's reference resolution (transitive
      // project references, a shared BCL/NuGet reference cache, and picking up the SDK's
      // auto-generated implicit-usings file — see ProjectLoader.Load/ReferenceResolver.Resolve)
      // let several previously-silently-unresolved framework types (ControllerBase, [Route],
      // ActionResult<T>, DI's IServiceCollection, ...) resolve correctly, surfacing external
      // dependency groups that were always real but never tracked before.
      expect(stats.totalFiles).toBe(22);
      expect(stats.byLanguage.csharp).toBe(22);

      const routeMap = (await callTool(dbPath, "graph_get_route_map")) as {
        routes: Array<{ route: { name: string } }>;
      };
      // GreetingController exposes GET/POST/DELETE under the same route template — GET and POST
      // via a single attribute carrying both verb and inline path (see RouteUtils.BuildRouteId's
      // regression fixture), DELETE via two separate attributes ([HttpDelete] + [Route(...)] —
      // see GetHttpVerbAndRoute's regression fixture) — three distinct Route symbols.
      expect(routeMap.routes.map((r) => r.route.name).sort()).toEqual(
        ["GET api/Greeting/{name}", "POST api/Greeting/{name}", "DELETE api/Greeting/{name}"].sort(),
      );

      const diGraph = (await callTool(dbPath, "graph_get_di_graph")) as {
        registrations: Array<{ target: { id: string } | null }>;
      };
      expect(diGraph.registrations.some((d) => d.target?.id === "csharp:global::SampleApi.Domain.Greeter")).toBe(true);

      // Indexing should register this repo's MCP server automatically, no manual .mcp.json step.
      const mcpConfig = JSON.parse(fs.readFileSync(path.join(DOTNET_FIXTURE, ".mcp.json"), "utf8"));
      expect(mcpConfig.mcpServers["rs-graph"]).toEqual({ command: "rs-graph", args: ["serve", "."] });
    },
    30_000,
  );

  it(
    "--sln overrides auto-detection when a repo has more than one solution file",
    async () => {
      // DomainOnly.slnx references only the Domain project, not Api — a real, observable
      // difference from SampleApi.slnx (no routes, no DI registrations, no GreetingController)
      // that proves the override actually took effect rather than just not erroring.
      await runIndex(DOTNET_FIXTURE, { slnPath: "DomainOnly.slnx" });
      const dbPath = path.join(DOTNET_FIXTURE, ".rs-graph", "graph.db");

      const stats = (await callTool(dbPath, "graph_stats")) as { byLanguage: Record<string, number> };
      expect(stats.byLanguage.csharp).toBeGreaterThan(0);

      const routeMap = (await callTool(dbPath, "graph_get_route_map")) as { routes: unknown[] };
      expect(routeMap.routes).toHaveLength(0);

      const search = (await callTool(dbPath, "graph_search_symbol", { query: "GreetingController" })) as unknown[];
      expect(search).toHaveLength(0);

      const greeter = (await callTool(dbPath, "graph_search_symbol", { query: "Greeter" })) as Array<{ id: string }>;
      expect(greeter.some((s) => s.id === "csharp:global::SampleApi.Domain.Greeter")).toBe(true);
    },
    30_000,
  );

  it(
    "--fresh deletes any existing .rs-graph before indexing",
    async () => {
      await runIndex(DOTNET_FIXTURE, { slnPath: "SampleApi.slnx" });
      const rsGraphDir = path.join(DOTNET_FIXTURE, ".rs-graph");
      // Stands in for stale/corrupted state left behind by an interrupted or older-version run —
      // --fresh should wipe the whole directory, not just overwrite graph.db.
      const staleMarker = path.join(rsGraphDir, "stale-marker.txt");
      fs.writeFileSync(staleMarker, "leftover from a previous run");

      await runIndex(DOTNET_FIXTURE, { slnPath: "SampleApi.slnx", fresh: true });

      expect(fs.existsSync(staleMarker)).toBe(false);
      const dbPath = path.join(rsGraphDir, "graph.db");
      const stats = (await callTool(dbPath, "graph_stats")) as { totalFiles: number };
      expect(stats.totalFiles).toBe(22);
    },
    30_000,
  );

  it(
    "indexes and serves the Angular fixture via a real MCP tool call",
    async () => {
      await runIndex(ANGULAR_FIXTURE);
      const dbPath = path.join(ANGULAR_FIXTURE, ".rs-graph", "graph.db");

      const stats = (await callTool(dbPath, "graph_stats")) as { totalFiles: number; byLanguage: Record<string, number> };
      // +1 for src/signal.service.ts (SignalR PUBLISHES/CONSUMES extraction fixture), +1 for
      // src/vessel-lookup.service.ts (HttpClientEnrichment's INVOKES_ROUTE extraction fixture),
      // +1 external pseudo-file for @angular/common (VesselLookupService both injects and calls
      // a method on HttpClient).
      expect(stats.totalFiles).toBe(7);
      expect(stats.byLanguage.typescript).toBe(7);

      const componentTree = (await callTool(dbPath, "graph_get_component_tree")) as {
        components: Array<{ component: { name: string } }>;
      };
      expect(componentTree.components.map((c) => c.component.name).sort()).toEqual(["AboutComponent", "AppComponent"]);

      const search = (await callTool(dbPath, "graph_search_symbol", { query: "greet" })) as Array<{ id: string }>;
      expect(search.some((s) => s.id === "typescript:src/greeter.service.ts#GreeterService.greet")).toBe(true);
    },
    30_000,
  );

  it(
    "indexes and serves the Python fixture via a real MCP tool call",
    async () => {
      await runIndex(PYTHON_FIXTURE);
      const dbPath = path.join(PYTHON_FIXTURE, ".rs-graph", "graph.db");

      const stats = (await callTool(dbPath, "graph_stats")) as { totalFiles: number; byLanguage: Record<string, number> };
      // +1 for api/messaging.py (PUBLISHES/CONSUMES extraction fixture).
      expect(stats.totalFiles).toBe(6);
      expect(stats.byLanguage.python).toBe(6);

      const routeMap = (await callTool(dbPath, "graph_get_route_map")) as {
        routes: Array<{ route: { name: string }; handler: { id: string } | null }>;
      };
      expect(routeMap.routes).toHaveLength(1);
      expect(routeMap.routes[0]?.route.name).toBe("GET /api/greeting/<name>");

      const callers = (await callTool(dbPath, "graph_get_callers", {
        symbolId: "python:domain/greeter.py#IGreeter.greet",
      })) as Array<{ symbol: { id: string } }>;
      expect(callers.some((c) => c.symbol.id === "python:api/controller.py#GreetingController.get")).toBe(true);
    },
    30_000,
  );

  it(
    "indexes and serves the Aurelia fixture via a real MCP tool call",
    async () => {
      await runIndex(AURELIA_FIXTURE);
      const dbPath = path.join(AURELIA_FIXTURE, ".rs-graph", "graph.db");

      const stats = (await callTool(dbPath, "graph_stats")) as { totalFiles: number; byLanguage: Record<string, number> };
      expect(stats.totalFiles).toBe(5);
      expect(stats.byLanguage.typescript).toBe(5);

      const componentTree = (await callTool(dbPath, "graph_get_component_tree")) as {
        components: Array<{ component: { name: string } }>;
      };
      expect(componentTree.components.map((c) => c.component.name).sort()).toEqual(["About", "App", "Home"]);

      const routeMap = (await callTool(dbPath, "graph_get_route_map")) as {
        routes: Array<{ route: { name: string }; handler: { id: string } | null }>;
      };
      expect(routeMap.routes.map((r) => r.handler?.id).sort()).toEqual(
        ["typescript:src/about.ts#About", "typescript:src/home.ts#Home"].sort(),
      );
    },
    30_000,
  );

  it("re-indexing either fixture is idempotent", async () => {
    await runIndex(DOTNET_FIXTURE);
    const dbPath = path.join(DOTNET_FIXTURE, ".rs-graph", "graph.db");
    const before = (await callTool(dbPath, "graph_stats")) as { totalSymbols: number };

    await runIndex(DOTNET_FIXTURE);
    const after = (await callTool(dbPath, "graph_stats")) as { totalSymbols: number };

    expect(after).toEqual(before);
  }, 30_000);
});
