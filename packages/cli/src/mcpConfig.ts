import * as fs from "node:fs";
import * as path from "node:path";

export interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * Adds one MCP server entry to <repoPath>/.mcp.json, creating the file if it doesn't exist and
 * merging into it (preserving any other entries/fields already there) if it does. Never
 * overwrites an existing entry under the same name — a user's own edit (different command,
 * extra args/env) wins over what rs-graph would generate, so re-indexing a repo is idempotent
 * but never clobbers customization.
 */
export function ensureMcpServerEntry(repoPath: string, serverName: string, entry: McpServerEntry): "added" | "exists" {
  const mcpConfigPath = path.join(repoPath, ".mcp.json");
  let config: McpConfigFile = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) as McpConfigFile;
    } catch (err) {
      throw new Error(
        `${mcpConfigPath} exists but isn't valid JSON — fix or remove it before indexing (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  config.mcpServers ??= {};
  if (config.mcpServers[serverName]) return "exists";

  config.mcpServers[serverName] = entry;
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  return "added";
}

/** Converts a filesystem path to forward slashes for JSON config portability — path.relative()
 * emits backslashes on Windows, which would be an unnecessary platform difference in a committed
 * or shared .mcp.json. */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}
