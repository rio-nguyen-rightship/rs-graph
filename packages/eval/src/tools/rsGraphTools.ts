import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeGraphDb, openGraphDb, type GraphDb } from "@rs-graph/graph-store";
import { createServer } from "@rs-graph/mcp-server";
import type { ToolDef } from "../types.js";

export interface RsGraphTools {
  tools: ToolDef[];
  close: () => void;
}

/**
 * Wires up the rs-graph MCP server in-process against an already-built .rs-graph/graph.db
 * (same InMemoryTransport pattern cli/src/e2e.test.ts uses) and converts its tool list into
 * Anthropic's tool-use shape. Deliberately does NOT index the repo itself — the eval harness
 * measures query-time effectiveness, not indexing cost, so `rs-graph index --fresh <repo>` is a
 * documented prerequisite (see README.md) rather than something this script does silently.
 */
export async function createRsGraphTools(repoRoot: string): Promise<RsGraphTools> {
  const dbPath = path.join(repoRoot, ".rs-graph", "graph.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No .rs-graph/graph.db under ${repoRoot} — run 'rs-graph index --fresh ${repoRoot}' before evaluating this repo.`,
    );
  }

  const db: GraphDb = openGraphDb({ dbPath });
  const server = createServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rs-graph-eval", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const { tools: mcpTools } = await client.listTools();

  const tools: ToolDef[] = mcpTools.map((mcpTool) => ({
    name: mcpTool.name,
    description: mcpTool.description ?? "",
    input_schema: mcpTool.inputSchema as Record<string, unknown>,
    handler: async (input) => {
      const result = await client.callTool({ name: mcpTool.name, arguments: input });
      const content = result.content as Array<{ type: string; text: string }>;
      return content.map((c) => c.text).join("\n");
    },
  }));

  return {
    tools,
    close: () => {
      void client.close();
      closeGraphDb(db);
    },
  };
}
