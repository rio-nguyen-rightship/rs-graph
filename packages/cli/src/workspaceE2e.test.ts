import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeGraphDb, openGraphDb } from "@rs-graph/graph-store";
import { createServer, registerWorkspaceTools } from "@rs-graph/mcp-server";
import { buildCrossRepoIndex, loadWorkspaceConfig, lookupCrossRepo } from "@rs-graph/workspace-store";
import { runIndexForWorkspace } from "./commands/indexRepo.js";
import { runIndexWorkspace } from "./commands/indexWorkspace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DOTNET_INDEXER_SRC = path.join(REPO_ROOT, "packages/indexer-dotnet/src");
const WORKSPACE_FIXTURE = path.join(REPO_ROOT, "fixtures/sample-workspace");
const WORKSPACE_CONFIG_PATH = path.join(WORKSPACE_FIXTURE, "workspace.json");
const PRODUCER_REPO = path.join(WORKSPACE_FIXTURE, "producer-api");
const CONSUMER_REPO = path.join(WORKSPACE_FIXTURE, "consumer-api");

/**
 * The one load-bearing end-to-end test for the whole cross-repo feature (Milestones 0-4):
 * everything upstream only proves one repo's indexer emits an edge with the right shape — this
 * proves the workspace resolver actually joins two SEPARATELY indexed repos' graphs by the
 * normalized xrepo:route:.../xrepo:message:... keys those edges target.
 */
describe("workspace cross-repo resolution against fixtures/sample-workspace", () => {
  beforeAll(() => {
    // Restoring/building our own indexer + our own test fixtures — not a target repo, see the
    // security note in docs/architecture.md.
    execFileSync("dotnet", ["build"], { cwd: DOTNET_INDEXER_SRC, stdio: "pipe" });
    for (const repo of [PRODUCER_REPO, CONSUMER_REPO]) {
      execFileSync("dotnet", ["restore"], { cwd: repo, stdio: "pipe" });
      execFileSync("dotnet", ["build"], { cwd: repo, stdio: "pipe" });
    }
  }, 120_000);

  afterAll(() => {
    for (const repo of [PRODUCER_REPO, CONSUMER_REPO]) {
      fs.rmSync(path.join(repo, ".rs-graph"), { recursive: true, force: true });
      fs.rmSync(path.join(repo, ".mcp.json"), { force: true });
      fs.rmSync(path.join(repo, "CROSS_REPO_MANIFEST.md"), { force: true });
      fs.rmSync(path.join(repo, "CROSS_REPO_MANIFEST.json"), { force: true });
    }
    fs.rmSync(path.join(WORKSPACE_FIXTURE, ".mcp.json"), { force: true });
  });

  it(
    "indexes both fixture repos successfully",
    async () => {
      const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
      expect(config.repos.map((r) => r.name).sort()).toEqual(["consumer-api", "producer-api"]);

      for (const repo of config.repos) {
        const outcome = await runIndexForWorkspace(repo.path, { fresh: true });
        expect(outcome.status).toBe("ok");
      }
    },
    60_000,
  );

  it(
    "registers the single-repo and workspace MCP servers in each repo's own .mcp.json, plus the workspace server at workspace.json's own folder",
    async () => {
      await runIndexWorkspace(WORKSPACE_CONFIG_PATH);

      for (const repo of [PRODUCER_REPO, CONSUMER_REPO]) {
        const mcpConfig = JSON.parse(fs.readFileSync(path.join(repo, ".mcp.json"), "utf8"));
        expect(mcpConfig.mcpServers["rs-graph"]).toEqual({ command: "rs-graph", args: ["serve", "."] });
        // Path from this repo's own folder back to workspace.json — e.g. "../workspace.json" —
        // since a Claude Code session opened in the repo needs to reach it relative to cwd.
        expect(mcpConfig.mcpServers["rs-graph-workspace"]).toEqual({
          command: "rs-graph",
          args: ["serve-workspace", "../workspace.json"],
        });
      }

      // A session opened at the workspace root itself (not inside any one repo) needs its own
      // .mcp.json too — absolute paths here, since a session opened in some repo can still pick
      // up this file and a relative path would resolve against that repo's cwd instead.
      const rootMcpConfig = JSON.parse(fs.readFileSync(path.join(WORKSPACE_FIXTURE, ".mcp.json"), "utf8"));
      expect(rootMcpConfig.mcpServers["rs-graph-workspace"]).toEqual({
        command: "rs-graph",
        args: ["serve-workspace", path.resolve(WORKSPACE_CONFIG_PATH)],
      });
      // Plus one uniquely-named single-repo server per repo, so a root-level session still has
      // real structural tools for each repo — not just the cross-repo joins.
      expect(rootMcpConfig.mcpServers["rs-graph-producer-api"]).toEqual({
        command: "rs-graph",
        args: ["serve", path.resolve(PRODUCER_REPO)],
      });
      expect(rootMcpConfig.mcpServers["rs-graph-consumer-api"]).toEqual({
        command: "rs-graph",
        args: ["serve", path.resolve(CONSUMER_REPO)],
      });

      // runIndexWorkspace also regenerates each indexed repo's CROSS_REPO_MANIFEST.md/.json —
      // real end-to-end proof the wiring works, not just the pure manifest-building unit tests.
      const producerManifest = fs.readFileSync(path.join(PRODUCER_REPO, "CROSS_REPO_MANIFEST.md"), "utf8");
      expect(producerManifest).toContain("# Cross-repo integration surface: producer-api");
      expect(producerManifest).toContain("## Routes this repo defines");
      expect(producerManifest).toContain("consumer-api");

      const consumerManifest = fs.readFileSync(path.join(CONSUMER_REPO, "CROSS_REPO_MANIFEST.md"), "utf8");
      expect(consumerManifest).toContain("# Cross-repo integration surface: consumer-api");
      expect(consumerManifest).toContain("## Routes this repo calls in other repos");
    },
    60_000,
  );

  it("resolves a Route defined in producer-api against consumer-api's INVOKES_ROUTE edge", () => {
    const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    const index = buildCrossRepoIndex(config.repos);
    expect(index.skippedRepos).toEqual([]);

    // The producer's real, verb-prefixed Route id — RouteUtils.BuildRouteId("GET", "api/v1/vessel/{id}").
    // NormalizeTemplate collapses the {id} placeholder to {} — routes match by path shape, not by
    // the route parameter's own name (see RouteUtils.NormalizeTemplate).
    const producerRouteId = "csharp:route:GET:api/v1/vessel/{}";
    const result = lookupCrossRepo(index, "Route", producerRouteId);

    expect(result.key).toBe("xrepo:route:api/v1/vessel/{}");
    expect(result.owners).toEqual([
      expect.objectContaining({ repo: "producer-api", symbolId: producerRouteId, kind: "Route" }),
    ]);
    expect(result.references).toEqual([
      expect.objectContaining({
        repo: "consumer-api",
        fromSymbolId: "csharp:global::ConsumerApi.VesselOperations.LookupVesselAsync(int)",
        edgeType: "INVOKES_ROUTE",
      }),
    ]);
  });

  it("resolves a message published by consumer-api against producer-api's CONSUMES edge", () => {
    const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    const index = buildCrossRepoIndex(config.repos);

    // Both repos declare their own independent VesselStatusChangedMessage class — the join key
    // (xrepo:message:VesselStatusChangedMessage) is the same regardless, since it's name-based.
    const result = lookupCrossRepo(index, "MessageContract", "xrepo:message:VesselStatusChangedMessage");

    expect(result.owners.map((o) => o.repo).sort()).toEqual(["consumer-api", "producer-api"]);

    const publisher = result.references.find((r) => r.edgeType === "PUBLISHES");
    expect(publisher).toEqual(
      expect.objectContaining({
        repo: "consumer-api",
        fromSymbolId: "csharp:global::ConsumerApi.VesselOperations.PublishVesselStatusChanged(int)",
      }),
    );

    const consumer = result.references.find((r) => r.edgeType === "CONSUMES");
    expect(consumer).toEqual(
      expect.objectContaining({ repo: "producer-api", fromSymbolId: "csharp:global::ProducerApi.VesselStatusConsumer" }),
    );
  });

  it("exposes the same resolution through the real MCP tool surface", async () => {
    const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    const index = buildCrossRepoIndex(config.repos);

    const server = new McpServer({ name: "rs-graph-workspace-test", version: "0.0.0" });
    registerWorkspaceTools(server, () => index);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "workspace-e2e-test", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const routeResult = await client.callTool({
      name: "graph_workspace_route_consumers",
      arguments: { symbolId: "csharp:route:GET:api/v1/vessel/{}" },
    });
    const routeContent = routeResult.content as Array<{ type: string; text: string }>;
    const routeParsed = JSON.parse(routeContent[0]!.text) as { references: Array<{ repo: string }> };
    expect(routeParsed.references.some((r) => r.repo === "consumer-api")).toBe(true);

    const statusResult = await client.callTool({ name: "graph_workspace_status", arguments: {} });
    const statusContent = statusResult.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(statusContent[0]!.text)).toEqual({ skippedRepos: [] });

    await client.close();
  });

  it("follows the CLAUDE.md snippet's exact two-step navigation, with no hardcoded ids", async () => {
    // Validates docs/mcp-tools.md's "Suggested CLAUDE.md snippet" literally: step 1 asks an agent
    // to find the symbol via THIS repo's own single-repo tool (graph_get_route_map), step 2 asks
    // it to feed that id into the workspace tool. Unlike the other tests above, this never types
    // out "csharp:route:GET:..." by hand — it comes from the real single-repo server's real
    // response, exactly as an agent following the snippet would encounter it.
    const producerDb = openGraphDb({ dbPath: path.join(PRODUCER_REPO, ".rs-graph", "graph.db") });
    const producerServer = createServer(producerDb);
    const [producerClientTransport, producerServerTransport] = InMemoryTransport.createLinkedPair();
    const producerClient = new Client({ name: "producer-repo-session", version: "0.0.0" });
    await Promise.all([producerClient.connect(producerClientTransport), producerServer.connect(producerServerTransport)]);

    const routeMapResult = await producerClient.callTool({ name: "graph_get_route_map", arguments: {} });
    const routeMapContent = routeMapResult.content as Array<{ type: string; text: string }>;
    const routeMap = JSON.parse(routeMapContent[0]!.text) as { routes: Array<{ route: { id: string; name: string } }> };
    const vesselRoute = routeMap.routes.find((r) => r.route.name.includes("api/v1/Vessel"));
    expect(vesselRoute).toBeDefined();

    await producerClient.close();
    closeGraphDb(producerDb);

    // Step 2: feed that real, discovered id into the workspace server, exactly as the snippet says.
    const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    const index = buildCrossRepoIndex(config.repos);
    const workspaceServer = new McpServer({ name: "rs-graph-workspace-test", version: "0.0.0" });
    registerWorkspaceTools(workspaceServer, () => index);
    const [workspaceClientTransport, workspaceServerTransport] = InMemoryTransport.createLinkedPair();
    const workspaceClient = new Client({ name: "workspace-session", version: "0.0.0" });
    await Promise.all([workspaceClient.connect(workspaceClientTransport), workspaceServer.connect(workspaceServerTransport)]);

    const consumersResult = await workspaceClient.callTool({
      name: "graph_workspace_route_consumers",
      arguments: { symbolId: vesselRoute!.route.id },
    });
    const consumersContent = consumersResult.content as Array<{ type: string; text: string }>;
    const consumers = JSON.parse(consumersContent[0]!.text) as { references: Array<{ repo: string }> };
    expect(consumers.references.some((r) => r.repo === "consumer-api")).toBe(true);

    await workspaceClient.close();
  });

  it("reports a not-yet-indexed repo as skipped rather than silently empty", () => {
    fs.rmSync(path.join(PRODUCER_REPO, ".rs-graph"), { recursive: true, force: true });
    const config = loadWorkspaceConfig(WORKSPACE_CONFIG_PATH);
    const index = buildCrossRepoIndex(config.repos);
    expect(index.skippedRepos).toEqual(["producer-api"]);
  });
});
