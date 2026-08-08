import type { GraphNodeRecord } from "./nodes.js";
import type { GraphEdgeRecord } from "./edges.js";

/**
 * The wire format every indexer emits: one JSON object per line (NDJSON) on stdout.
 * graph-store's ingester reads this stream and upserts into Kuzu.
 */
export type GraphRecord = GraphNodeRecord | GraphEdgeRecord;

export function parseGraphRecordLine(line: string): GraphRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as GraphRecord;
}

export function stringifyGraphRecord(record: GraphRecord): string {
  return JSON.stringify(record);
}
