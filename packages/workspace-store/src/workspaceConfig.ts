import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspaceRepoConfig {
  name: string;
  path: string;
  /** Optional .sln/.slnx (or .csproj) override, threaded through to RunIndexOptions.slnPath. */
  sln?: string;
  /** Optional tsconfig.json override, threaded through to RunIndexOptions.tsconfigPath. */
  tsconfig?: string;
}

export interface WorkspaceConfig {
  repos: WorkspaceRepoConfig[];
}

/**
 * Reads a workspace.json: an explicit, user-maintained list of repos — no recursive directory
 * discovery, since a real machine's source root typically has many unrelated checkouts alongside
 * the ones actually meant to be linked (see the root README's registration notes). Each repo's
 * `path` is resolved relative to the workspace.json file's own directory if not already absolute,
 * so the same config is portable across machines that check out repos under a different root.
 */
export function loadWorkspaceConfig(workspaceConfigPath: string): WorkspaceConfig {
  const raw = fs.readFileSync(workspaceConfigPath, "utf8");
  const parsed = JSON.parse(raw) as { repos?: unknown };
  if (!Array.isArray(parsed.repos)) {
    throw new Error(`${workspaceConfigPath}: expected a top-level "repos" array`);
  }

  const configDir = path.dirname(workspaceConfigPath);
  const repos = parsed.repos.map((entry, i) => {
    const r = entry as Partial<WorkspaceRepoConfig>;
    if (!r.name || !r.path) {
      throw new Error(`${workspaceConfigPath}: repos[${i}] must have "name" and "path"`);
    }
    return {
      name: r.name,
      path: path.isAbsolute(r.path) ? r.path : path.resolve(configDir, r.path),
      sln: r.sln,
      tsconfig: r.tsconfig,
    };
  });

  return { repos };
}

/** Resolves a configured repo's .rs-graph/graph.db path — the same layout `rs-graph index`
 * already creates for a single repo. */
export function repoDbPath(repo: WorkspaceRepoConfig): string {
  return path.join(repo.path, ".rs-graph", "graph.db");
}

/**
 * A workspace.json repo path should always already exist — `openGraphDb` happily
 * `mkdir -p`s whatever parent directory `.rs-graph/graph.db` needs, with no regard for whether
 * that directory existed a moment ago. A relative path that resolved against the wrong base
 * directory (real-world regression: a workspace.json meant to point at sibling repos under
 * `C:\Works\SourceCode` instead resolved several of its entries to non-existent subpaths of an
 * unrelated repo, psc-riskiq-app) doesn't fail loudly — it silently fabricates a brand-new, empty
 * directory out of thin air just to hold a nearly-empty `.rs-graph/graph.db`, leaving debris
 * behind in whatever unrelated project happened to be at that path. Checking existence first
 * catches the mistake before any of that happens, without rejecting real, legitimate targets —
 * a monorepo's own sub-project, or a test fixture — that simply lack their own `.git`.
 */
export function isExistingDirectory(repoPath: string): boolean {
  try {
    return fs.statSync(repoPath).isDirectory();
  } catch {
    return false;
  }
}
