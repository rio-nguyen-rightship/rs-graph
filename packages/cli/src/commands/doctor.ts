import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { closeGraphDb, openGraphDb } from "@rs-graph/graph-store";
import { detectProjects, walk } from "../detect.js";
import { readIndexReport, type DotnetIndexStats } from "../indexReport.js";

export type DoctorStatus = "missing" | "needs-build" | "stale" | "degraded" | "ok";

export interface DoctorReport {
  path: string;
  status: DoctorStatus;
  summary: string;
  /** The one thing to do next; empty when status is "ok". */
  suggestedAction: string;
  indexedAt?: string;
  languages: string[];
  counts?: { files: number; symbols: number };
  dotnet?: {
    projects: number;
    projectsWithoutAssets: number;
    unresolvedReferenceErrors?: number;
    worstProjects?: DotnetIndexStats["worstProjects"];
  };
  changedSinceIndex?: { count: number; examples: string[] };
  mcpRegistered: boolean;
  /** null when this isn't a git repo. */
  gitIgnored: boolean | null;
  /** All three rs-graph hooks present; null when this isn't a git repo. */
  hooksInstalled: boolean | null;
}

/** At or above this many unresolved declaration references the graph is called "degraded": a
 * handful is normal (generated code, optional packages), hundreds means references never loaded
 * and most call/injection edges are missing. */
export const DEGRADED_UNRESOLVED_THRESHOLD = 50;

const SOURCE_EXTENSIONS = new Set([".cs", ".ts", ".tsx", ".html", ".py"]);
const HOOK_NAMES = ["post-merge", "post-checkout", "post-rewrite"];

function git(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function isMcpRegistered(repoPath: string): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(repoPath, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(config.mcpServers?.["rs-graph"]);
  } catch {
    return false;
  }
}

function areHooksInstalled(repoPath: string): boolean | null {
  if (!git(repoPath, ["rev-parse", "--git-dir"]).ok) return null;
  const configured = git(repoPath, ["config", "--get", "core.hooksPath"]);
  const hooksDir =
    configured.ok && configured.stdout ? path.resolve(repoPath, configured.stdout) : path.join(repoPath, ".git", "hooks");
  return HOOK_NAMES.every((name) => {
    try {
      return fs.readFileSync(path.join(hooksDir, name), "utf8").includes("rs-graph");
    } catch {
      return false;
    }
  });
}

function isGitIgnored(repoPath: string): boolean | null {
  if (!git(repoPath, ["rev-parse", "--git-dir"]).ok) return null;
  return git(repoPath, ["check-ignore", "-q", ".rs-graph/graph.db"]).ok;
}

/** Reads graph.db without ever creating it. Returns undefined when the db is absent or has no
 * schema yet (an index run that's still creating it). */
function readCounts(dbPath: string): { files: number; symbols: number } | undefined {
  if (!fs.existsSync(dbPath)) return undefined;
  const db = openGraphDb({ dbPath, mustExist: true });
  try {
    const hasSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Symbol'").get();
    if (!hasSchema) return undefined;
    const files = (db.prepare("SELECT COUNT(*) AS n FROM File").get() as { n: number }).n;
    const symbols = (db.prepare("SELECT COUNT(*) AS n FROM Symbol").get() as { n: number }).n;
    return { files, symbols };
  } finally {
    closeGraphDb(db);
  }
}

function dbMtimeMs(dbPath: string): number {
  return Math.max(...[dbPath, `${dbPath}-wal`].map((p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0)));
}

function findChangedSince(files: string[], repoPath: string, sinceMs: number): { count: number; examples: string[] } {
  const changed: string[] = [];
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
    try {
      if (fs.statSync(file).mtimeMs > sinceMs) changed.push(path.relative(repoPath, file));
    } catch {
      // Deleted between the walk and the stat — the next index will notice.
    }
  }
  return { count: changed.length, examples: changed.slice(0, 5) };
}

/**
 * Read-only health check of one repo's graph — never indexes, builds, restores, or writes.
 * Status priority: nothing indexed (missing, or needs-build when the .NET projects were never
 * restored, since indexing them would only produce a hollow graph) → majority of .NET projects
 * unrestored → stale (source files newer than the last index) → degraded (indexed, but the
 * compiler couldn't resolve many types) → ok.
 */
export function diagnoseRepo(repoPath: string): DoctorReport {
  const detection = detectProjects(repoPath);
  const dbPath = path.join(repoPath, ".rs-graph", "graph.db");
  const counts = readCounts(dbPath);
  const report = readIndexReport(repoPath);

  const csprojFiles = detection.markers.csprojFiles;
  const projectsWithoutAssets = csprojFiles.filter(
    (csproj) => !fs.existsSync(path.join(path.dirname(csproj), "obj", "project.assets.json")),
  ).length;
  const needsBuild = csprojFiles.length > 0 && projectsWithoutAssets * 2 >= csprojFiles.length;

  const base: DoctorReport = {
    path: repoPath,
    status: "ok",
    summary: "",
    suggestedAction: "",
    languages: [...detection.languages],
    counts,
    mcpRegistered: isMcpRegistered(repoPath),
    gitIgnored: isGitIgnored(repoPath),
    hooksInstalled: areHooksInstalled(repoPath),
  };
  if (csprojFiles.length > 0) {
    base.dotnet = {
      projects: csprojFiles.length,
      projectsWithoutAssets,
      unresolvedReferenceErrors: report?.dotnet?.unresolvedReferenceErrors,
      worstProjects: report?.dotnet?.worstProjects,
    };
  }

  const buildAdvice =
    `${projectsWithoutAssets} of ${csprojFiles.length} .NET project(s) have no obj/project.assets.json, so ` +
    "references can't be resolved. rs-graph never runs restore/build itself — restore/build the solution " +
    `yourself, then run \`rs-graph index ${repoPath}\`.`;

  if (!counts) {
    if (needsBuild) {
      return {
        ...base,
        status: "needs-build",
        summary: "Not indexed, and the .NET projects aren't restored.",
        suggestedAction: buildAdvice,
      };
    }
    return {
      ...base,
      status: "missing",
      summary: "No graph yet (or indexing is still creating it).",
      suggestedAction: `rs-graph index ${repoPath}`,
    };
  }

  const indexedAtMs = report ? Date.parse(report.startedAt) : dbMtimeMs(dbPath);
  base.indexedAt = new Date(indexedAtMs).toISOString();

  if (needsBuild) {
    return {
      ...base,
      status: "needs-build",
      summary: "Indexed, but the .NET projects aren't restored, so the graph is hollow.",
      suggestedAction: buildAdvice,
    };
  }

  const changed = findChangedSince(walk(repoPath), repoPath, indexedAtMs);
  if (changed.count > 0) {
    return {
      ...base,
      status: "stale",
      changedSinceIndex: changed,
      summary: `${changed.count} source file(s) changed since the last index (${base.indexedAt}).`,
      suggestedAction: `rs-graph index ${repoPath}   (incremental — only changed files are re-processed)`,
    };
  }

  const unresolved = report?.dotnet?.unresolvedReferenceErrors ?? 0;
  if (unresolved >= DEGRADED_UNRESOLVED_THRESHOLD) {
    const worst = (report?.dotnet?.worstProjects ?? []).map((p) => `${p.project} (${p.errors})`).join(", ");
    return {
      ...base,
      status: "degraded",
      summary:
        `Up to date, but ${unresolved} declaration(s) reference types the compiler couldn't resolve` +
        (worst ? ` — worst: ${worst}.` : "."),
      suggestedAction:
        "Callers/references through those types will be missing. Make sure the solution is restored and built, " +
        `then \`rs-graph index ${repoPath} --fresh\`.`,
    };
  }

  return { ...base, status: "ok", summary: `Up to date (${counts.files} files, ${counts.symbols} symbols).` };
}

function yesNo(value: boolean | null): string {
  return value === null ? "n/a (not a git repo)" : value ? "yes" : "no";
}

export function runDoctor(repoPath: string, options: { json?: boolean } = {}): void {
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    console.error(`${repoPath} is not an existing directory.`);
    process.exitCode = 1;
    return;
  }

  const report = diagnoseRepo(repoPath);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`rs-graph doctor — ${report.path}`);
  console.log(`  status:          ${report.status.toUpperCase()} — ${report.summary}`);
  if (report.suggestedAction) console.log(`  next step:       ${report.suggestedAction}`);
  console.log(`  languages:       ${report.languages.join(", ") || "none detected"}`);
  if (report.dotnet) {
    const unresolved = report.dotnet.unresolvedReferenceErrors;
    console.log(
      `  .NET projects:   ${report.dotnet.projects} (${report.dotnet.projectsWithoutAssets} not restored)` +
        (unresolved === undefined ? "" : `, ${unresolved} unresolved reference(s) at last index`),
    );
  }
  if (report.changedSinceIndex) {
    const more = report.changedSinceIndex.count > report.changedSinceIndex.examples.length ? ", …" : "";
    console.log(`  changed files:   ${report.changedSinceIndex.examples.join(", ")}${more}`);
  }
  console.log(`  MCP registered:  ${yesNo(report.mcpRegistered)}`);
  console.log(`  git-ignored:     ${yesNo(report.gitIgnored)}`);
  console.log(`  git hooks:       ${yesNo(report.hooksInstalled)}`);
}
