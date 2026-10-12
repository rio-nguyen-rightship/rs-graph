import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLazyDbGetter, createServer, registerWorkspaceTools } from "@rs-graph/mcp-server";
import { createLiveCrossRepoIndex, loadWorkspaceConfig } from "@rs-graph/workspace-store";

export interface QueryOptions {
  /** Repo whose graph to query (default "."). Ignored when `workspace` is set. */
  repo?: string;
  /** A workspace.json: query the cross-repo `graph_workspace_*` tools instead of one repo. */
  workspace?: string;
  /** `key=value` pairs, coerced to the tool's declared parameter types. */
  args?: string[];
  /** Whole argument object as JSON, or "-" to read it from stdin; `args` override its keys. */
  json?: string;
  list?: boolean;
  pretty?: boolean;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] };
}

/** Accepts the full name or a shorthand: `callers` → graph_get_callers, `route_map` →
 * graph_get_route_map, `route_consumers` → graph_workspace_route_consumers. */
export function resolveToolName(requested: string, names: string[]): { name: string } | { error: string } {
  if (names.includes(requested)) return { name: requested };

  const candidates = [`graph_${requested}`, `graph_get_${requested}`, `graph_workspace_${requested}`];
  const matches = names.filter((n) => candidates.includes(n));
  if (matches.length === 1) return { name: matches[0]! };
  if (matches.length > 1) return { error: `"${requested}" is ambiguous: ${matches.join(", ")}` };
  return { error: `Unknown tool "${requested}". Available: ${names.join(", ")}` };
}

function coerce(value: string, type: string | string[] | undefined): unknown {
  const t = Array.isArray(type) ? type.find((x) => x !== "null") : type;
  switch (t) {
    case "number":
    case "integer": {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`"${value}" is not a number`);
      return n;
    }
    case "boolean":
      if (value !== "true" && value !== "false") throw new Error(`"${value}" is not true/false`);
      return value === "true";
    case "array":
      return value.trim().startsWith("[") ? JSON.parse(value) : value.split(",").map((v) => v.trim());
    default:
      return value;
  }
}

/** Merges `--json` and repeated `--arg key=value` into one argument object, typing each value by
 * the tool's own input schema so callers never have to quote numbers or arrays. */
export function buildArguments(tool: ToolInfo, pairs: string[], json?: string): Record<string, unknown> {
  const result: Record<string, unknown> = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--arg expects key=value, got "${pair}"`);
    const key = pair.slice(0, eq);
    const spec = tool.inputSchema.properties?.[key];
    if (!spec) {
      const known = Object.keys(tool.inputSchema.properties ?? {}).join(", ") || "(none)";
      throw new Error(`${tool.name} has no parameter "${key}". Parameters: ${known}`);
    }
    result[key] = coerce(pair.slice(eq + 1), spec.type);
  }
  return result;
}

export function formatToolList(tools: ToolInfo[]): string {
  return tools
    .map((tool) => {
      const required = new Set(tool.inputSchema.required ?? []);
      const params = Object.entries(tool.inputSchema.properties ?? {}).map(
        ([name, spec]) => `${name}${required.has(name) ? "" : "?"}: ${Array.isArray(spec.type) ? spec.type.join("|") : (spec.type ?? "any")}`,
      );
      const summary = (tool.description ?? "").split(/(?<=\.)\s/)[0] ?? "";
      return `${tool.name}\n    ${summary}\n    params: ${params.join(", ") || "(none)"}`;
    })
    .join("\n");
}

async function connect(options: QueryOptions): Promise<{ client: Client; close: () => Promise<void> }> {
  let server: McpServer;
  let closeDb = () => {};
  if (options.workspace) {
    const config = loadWorkspaceConfig(path.resolve(options.workspace));
    server = new McpServer({ name: "rs-graph-workspace", version: "0.1.0" });
    registerWorkspaceTools(server, createLiveCrossRepoIndex(config.repos));
  } else {
    const repoPath = path.resolve(options.repo ?? ".");
    const getDb = createLazyDbGetter(path.join(repoPath, ".rs-graph", "graph.db"));
    closeDb = () => getDb.close();
    server = createServer(getDb);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rs-graph-cli", version: "0.1.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      closeDb();
    },
  };
}

/**
 * Runs one graph tool from the command line through the exact same handlers the MCP server
 * exposes (in-process, via an in-memory MCP transport) — so an agent with a shell but no
 * registered MCP server (a repo with no .mcp.json yet, or a server added mid-session) gets the
 * same answers, schemas and "not indexed yet" errors, with no second implementation to drift.
 */
export async function runQuery(toolArg: string | undefined, options: QueryOptions = {}): Promise<void> {
  let connection: Awaited<ReturnType<typeof connect>>;
  try {
    connection = await connect(options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    const tools = (await connection.client.listTools()).tools as ToolInfo[];

    if (options.list || !toolArg) {
      console.log(formatToolList(tools));
      return;
    }

    const resolved = resolveToolName(toolArg, tools.map((t) => t.name));
    if ("error" in resolved) {
      console.error(resolved.error);
      process.exitCode = 1;
      return;
    }

    const tool = tools.find((t) => t.name === resolved.name)!;
    const jsonText = options.json === "-" ? fs.readFileSync(0, "utf8") : options.json;
    const args = buildArguments(tool, options.args ?? [], jsonText);

    const result = await connection.client.callTool({ name: tool.name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");

    if (result.isError) {
      console.error(text);
      process.exitCode = 1;
      return;
    }
    console.log(options.pretty ? prettify(text) : text);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await connection.close();
  }
}

function prettify(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
