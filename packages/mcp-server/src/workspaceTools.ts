import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lookupCrossRepo, type CrossRepoIndex } from "@rs-graph/workspace-store";
import { jsonResult } from "./toolResult.js";

/**
 * Registers workspace-scoped tools against an already-built cross-repo index (see
 * @rs-graph/workspace-store). Each tool takes a symbol id from the CALLING repo's own single-repo
 * graph (from graph_get_route_map/graph_search_symbol) and looks up what every OTHER configured
 * repo knows about it — the thing a single-repo graph_* tool can never answer on its own.
 */
export function registerWorkspaceTools(server: McpServer, index: CrossRepoIndex): void {
  server.registerTool(
    "graph_workspace_route_consumers",
    {
      title: "Workspace: route consumers",
      description:
        "Given a Route symbol id from THIS repo's own graph (graph_get_route_map/graph_search_symbol), " +
        "finds every other configured repo that calls it through a generated SDK client (an NSwag " +
        "[RouteUrl]-decorated method, matched by normalized verb-less route template — the join " +
        "misses a producer registering the same template under more than one verb without further " +
        "disambiguation). This is the cross-repo half of 'what would deleting this endpoint break', " +
        "which a single-repo graph can never answer on its own. Returns { key, owners, references }: " +
        "owners are the repo(s) that actually declare this route (usually one); references are the " +
        "INVOKES_ROUTE call sites in every consuming repo.",
      inputSchema: { symbolId: z.string().describe("A Route symbol id from this repo's own graph") },
    },
    ({ symbolId }) => jsonResult(lookupCrossRepo(index, "Route", symbolId)),
  );

  server.registerTool(
    "graph_workspace_message_consumers",
    {
      title: "Workspace: message consumers",
      description:
        "Given a MessageContract symbol id from THIS repo's own graph, finds every other configured " +
        "repo that PUBLISHES or CONSUMES the same Azure Service Bus message type — even across " +
        "languages (the join key is the message type's bare name, the same convention the real " +
        "services already correlate producer/consumer by). Returns { key, owners, references }: " +
        "owners are every repo with a local PUBLISHES/CONSUMES reference to this type name (not just " +
        "the one that declares the real contract class, if any); references carries each repo's " +
        "edge with its direction (edgeType: PUBLISHES or CONSUMES).",
      inputSchema: { symbolId: z.string().describe("A MessageContract symbol id from this repo's own graph") },
    },
    ({ symbolId }) => jsonResult(lookupCrossRepo(index, "MessageContract", symbolId)),
  );

  server.registerTool(
    "graph_workspace_signal_consumers",
    {
      title: "Workspace: SignalR event consumers",
      description:
        "Given a HubEvent symbol id from THIS repo's own graph, finds every other configured repo " +
        "that PUBLISHES (a server broadcast, or a client's dispatch-name argument to .invoke(...)) or " +
        "CONSUMES (a client's .on/.subscribe, or an ISignalHubInterceptor.InterceptorName the server " +
        "dispatches to) the same event/dispatch name. Returns { key, owners, references }, same shape " +
        "as graph_workspace_message_consumers.",
      inputSchema: { symbolId: z.string().describe("A HubEvent symbol id from this repo's own graph") },
    },
    ({ symbolId }) => jsonResult(lookupCrossRepo(index, "HubEvent", symbolId)),
  );

  server.registerTool(
    "graph_workspace_status",
    {
      title: "Workspace status",
      description:
        "Lists which configured repos were skipped when building the cross-repo index (not yet " +
        "indexed — run `rs-graph index-workspace` first). Call this if a workspace_* tool returns " +
        "fewer results than expected, to rule out a repo simply missing from the index rather than " +
        "a genuine absence of any cross-repo caller.",
      inputSchema: {},
    },
    () => jsonResult({ skippedRepos: index.skippedRepos }),
  );
}
