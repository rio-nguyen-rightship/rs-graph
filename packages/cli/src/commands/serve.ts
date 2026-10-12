import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openGraphDb } from "@rs-graph/graph-store";
import { createServer } from "@rs-graph/mcp-server";

export async function runServe(targetPath: string): Promise<void> {
  const dbPath = path.join(targetPath, ".rs-graph", "graph.db");
  const db = openGraphDb({ dbPath, mustExist: true });
  const server = createServer(db);
  console.error("rs-graph: serving over stdio..."); // stderr only — stdout is reserved for MCP protocol messages
  await server.connect(new StdioServerTransport());
}
