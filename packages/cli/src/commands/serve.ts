import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLazyDbGetter, createServer } from "@rs-graph/mcp-server";

export async function runServe(targetPath: string): Promise<void> {
  const dbPath = path.join(targetPath, ".rs-graph", "graph.db");
  const server = createServer(createLazyDbGetter(dbPath));
  console.error("rs-graph: serving over stdio..."); // stderr only — stdout is reserved for MCP protocol messages
  await server.connect(new StdioServerTransport());
}
