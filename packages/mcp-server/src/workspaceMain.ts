#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLiveCrossRepoIndex, loadWorkspaceConfig } from "@rs-graph/workspace-store";
import { registerWorkspaceTools } from "./workspaceTools.js";

async function main(): Promise<void> {
  const workspaceConfigPath = process.argv[2];
  if (!workspaceConfigPath) {
    console.error("usage: rs-graph-mcp-workspace <workspace.json>");
    process.exit(1);
  }

  const config = loadWorkspaceConfig(workspaceConfigPath);
  const getIndex = createLiveCrossRepoIndex(config.repos);
  const initial = getIndex();
  if (initial.skippedRepos.length > 0) {
    console.error(
      `rs-graph: skipping repo(s) not yet indexed: ${initial.skippedRepos.join(", ")} — run ` +
        `\`rs-graph index-workspace ${workspaceConfigPath}\` first.`,
    );
  }

  const server = new McpServer({ name: "rs-graph-workspace", version: "0.1.0" });
  registerWorkspaceTools(server, getIndex);

  // stdio only, by design — same rationale as the single-repo server, see docs/architecture.md.
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
