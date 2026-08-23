import { z } from "zod";
import type { ReferenceHit, SymbolSummary, SymbolWithDepth } from "@rs-graph/graph-store";

export type Detail = "compact" | "full";

/** Enough to decide where to go next (id to pass to another tool, kind to filter by eye,
 * location to jump to) without the two fields that dominate response size in a multi-result
 * list — signature and docSummary, which can run to a full method signature or doc paragraph
 * each. graph_get_definition (a single result, not multiplied by N) still returns those in full;
 * for a list, they're a follow-up call away once a specific hit looks worth a closer look. */
export interface SymbolRef {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export const detailParam = z
  .enum(["compact", "full"])
  .optional()
  .describe(
    "'compact' (default): omits signature/docSummary/modifiers to save tokens — id/kind/location is " +
      "usually enough to decide what to look at next; follow up with graph_get_definition or Read for " +
      "a specific result once you've picked one. 'full': include signature/docSummary/modifiers inline, " +
      "worth it up front if you already expect to need them for every result (e.g. comparing overloads).",
  );

function toRef(s: SymbolSummary): SymbolRef {
  return { id: s.id, name: s.name, kind: s.kind, filePath: s.filePath, startLine: s.startLine, endLine: s.endLine };
}

export function projectSymbol(s: SymbolSummary, detail: Detail | undefined): SymbolSummary | SymbolRef {
  return detail === "full" ? s : toRef(s);
}

export function projectWithDepth(
  s: SymbolWithDepth,
  detail: Detail | undefined,
): (SymbolSummary | SymbolRef) & { depth: number } {
  return { ...projectSymbol(s, detail), depth: s.depth };
}

export function projectReferenceHit(hit: ReferenceHit, detail: Detail | undefined) {
  return { symbol: projectSymbol(hit.symbol, detail), occurrences: hit.occurrences };
}
