#!/usr/bin/env node
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openGraphDb } from "@rs-graph/graph-store";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const targetPath = path.resolve(process.argv[2] ?? ".");
  const dbPath = path.join(targetPath, ".rs-graph", "graph.db");

  const db = openGraphDb({ dbPath, mustExist: true });
  const server = createServer(db);

  // stdio only, by design — see docs/architecture.md's security note. No network listener,
  // no auth surface; the only client is whatever spawned this process (e.g. Claude Code).
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
