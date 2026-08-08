import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every tool returns compact JSON in a single text block — no pretty-printing, since the
 * whole point of this server is minimizing tokens spent on structure an agent would otherwise
 * have to re-derive by reading source. */
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}
