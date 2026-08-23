import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWorkspaceTools } from "@rs-graph/mcp-server";
import { buildCrossRepoIndex, loadWorkspaceConfig } from "@rs-graph/workspace-store";

export async function runServeWorkspace(workspaceConfigPath: string): Promise<void> {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  const index = buildCrossRepoIndex(config.repos);
  if (index.skippedRepos.length > 0) {
    console.error(
      `rs-graph: skipping repo(s) not yet indexed: ${index.skippedRepos.join(", ")} — run ` +
        `\`rs-graph index-workspace ${workspaceConfigPath}\` first.`,
    );
  }

  const server = new McpServer({ name: "rs-graph-workspace", version: "0.1.0" });
  registerWorkspaceTools(server, index);

  console.error("rs-graph: serving workspace over stdio..."); // stderr only — stdout is reserved for MCP protocol messages
  await server.connect(new StdioServerTransport());
}
