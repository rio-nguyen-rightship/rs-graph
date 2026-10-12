import * as fs from "node:fs";
import * as path from "node:path";

export interface DotnetIndexStats {
  projects: number;
  /** Declarations whose type/namespace the compiler couldn't resolve — see the .NET indexer's
   * CompilationStats. High means references were incomplete (usually: repo not restored/built). */
  unresolvedReferenceErrors: number;
  worstProjects: Array<{ project: string; errors: number }>;
}

/** Written next to graph.db after every successful index; read by `rs-graph doctor`. Lives in a
 * JSON file rather than the db so it needs no schema change. */
export interface IndexReport {
  /** ISO time the run *started* — a file edited mid-index must still count as newer. */
  startedAt: string;
  languages: string[];
  dotnet?: DotnetIndexStats;
}

export const STATS_MARKER = "RS_GRAPH_STATS ";

const reportPath = (repoPath: string) => path.join(repoPath, ".rs-graph", "index-report.json");

export function writeIndexReport(repoPath: string, report: IndexReport): void {
  fs.writeFileSync(reportPath(repoPath), `${JSON.stringify(report, null, 2)}\n`);
}

export function readIndexReport(repoPath: string): IndexReport | undefined {
  try {
    return JSON.parse(fs.readFileSync(reportPath(repoPath), "utf8")) as IndexReport;
  } catch {
    return undefined;
  }
}

/** Splits the indexer's stderr into the stats line (parsed) and everything else (to be echoed). */
export function extractDotnetStats(stderr: string): { stats?: DotnetIndexStats; rest: string } {
  let stats: DotnetIndexStats | undefined;
  const rest: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (line.startsWith(STATS_MARKER)) {
      try {
        stats = JSON.parse(line.slice(STATS_MARKER.length)) as DotnetIndexStats;
      } catch {
        // A malformed stats line is just missing health info, never an indexing failure.
      }
    } else {
      rest.push(line);
    }
  }
  return { stats, rest: rest.join("\n").trim() };
}
