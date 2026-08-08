import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphDb } from "@rs-graph/graph-store";
import { registerTools } from "./tools.js";

export function createServer(db: GraphDb): McpServer {
  const server = new McpServer({ name: "rs-graph", version: "0.1.0" });
  registerTools(server, db);
  return server;
}
