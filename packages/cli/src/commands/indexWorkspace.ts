import * as path from "node:path";
import { loadWorkspaceConfig } from "@rs-graph/workspace-store";
import { ensureMcpServerEntry, toPosixPath } from "../mcpConfig.js";
import { runIndexForWorkspace, type WorkspaceIndexOutcome } from "./indexRepo.js";

export interface RunIndexWorkspaceOptions {
  fresh?: boolean;
}

interface RepoResult extends WorkspaceIndexOutcome {
  name: string;
}

/**
 * Indexes every repo listed in a workspace.json, one at a time, with real per-repo isolation —
 * unlike the single-repo `index` command, a failure in one repo must not abort the batch (there
 * is no per-repo error isolation in runIndex itself, which is exactly why runIndexForWorkspace
 * exists — see indexRepo.ts). Prints a pass/skip/fail summary at the end rather than stopping at
 * the first failure.
 */
export async function runIndexWorkspace(
  workspaceConfigPath: string,
  options: RunIndexWorkspaceOptions = {},
): Promise<void> {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  if (config.repos.length === 0) {
    console.log(`${workspaceConfigPath}: "repos" is empty — nothing to index.`);
    return;
  }

  const workspaceDir = path.dirname(workspaceConfigPath);

  const results: RepoResult[] = [];
  for (const repo of config.repos) {
    console.log(`\n=== ${repo.name} (${repo.path}) ===`);
    const outcome = await runIndexForWorkspace(repo.path, {
      slnPath: repo.sln,
      tsconfigPath: repo.tsconfig,
      fresh: options.fresh,
    });
    results.push({ name: repo.name, ...outcome });
    if (outcome.status === "unsupported") {
      console.log("  no recognized project type under this path — skipping.");
    } else if (outcome.status === "failed") {
      console.log(`  FAILED: ${outcome.error}`);
    } else {
      // Register both the single-repo server (for this repo's own tools) and the
      // workspace server (for cross-repo tools) in this repo's own .mcp.json, so a Claude
      // Code session opened here has both without any manual config step.
      ensureMcpServerEntry(repo.path, "rs-graph", { command: "rs-graph", args: ["serve", "."] });
      const relWorkspaceConfigPath = toPosixPath(path.relative(repo.path, workspaceConfigPath));
      const workspaceResult = ensureMcpServerEntry(repo.path, "rs-graph-workspace", {
        command: "rs-graph",
        args: ["serve-workspace", relWorkspaceConfigPath],
      });
      if (workspaceResult === "added") {
        console.log('  .mcp.json: added "rs-graph" and "rs-graph-workspace" server entries.');
      }

      // Also register this repo's single-repo server at the workspace root, uniquely named per
      // repo — a session opened there (common for a task that touches more than one repo at
      // once) has no single "current repo" for a plain "rs-graph" entry to mean, but still needs
      // real structural tools for each repo, not just the workspace joins. Without this, an
      // agent working from the shared root has no single-repo tools at all and falls back to
      // Grep/Read entirely, not just for the genuinely cross-repo questions.
      const relRepoPathFromWorkspaceDir = toPosixPath(path.relative(workspaceDir, repo.path));
      ensureMcpServerEntry(workspaceDir, `rs-graph-${repo.name}`, {
        command: "rs-graph",
        args: ["serve", relRepoPathFromWorkspaceDir],
      });
    }
  }

  // Also register the workspace server at workspace.json's own folder — a Claude Code session
  // opened at the workspace root (rather than inside any one repo) still needs its own .mcp.json
  // to get cross-repo tools. Registered regardless of per-repo outcomes above: even a partially-
  // indexed workspace is useful, and graph_workspace_status reports what's missing.
  const relConfigFromWorkspaceDir = toPosixPath(path.relative(workspaceDir, workspaceConfigPath));
  const rootResult = ensureMcpServerEntry(workspaceDir, "rs-graph-workspace", {
    command: "rs-graph",
    args: ["serve-workspace", relConfigFromWorkspaceDir],
  });
  if (rootResult === "added") {
    console.log(`\n.mcp.json: added "rs-graph-workspace" server entry in ${workspaceDir}.`);
  }

  printSummary(results);
}

function printSummary(results: RepoResult[]): void {
  const ok = results.filter((r) => r.status === "ok");
  const unsupported = results.filter((r) => r.status === "unsupported");
  const failed = results.filter((r) => r.status === "failed");

  console.log(`\n=== Summary: ${ok.length} indexed, ${unsupported.length} skipped, ${failed.length} failed ===`);
  for (const r of results) {
    const marker = r.status === "ok" ? "OK" : r.status === "unsupported" ? "SKIP" : "FAIL";
    const detail = r.status === "ok" ? (r.languages ?? []).join(", ") : (r.error ?? "unsupported project type");
    console.log(`  [${marker}] ${r.name} — ${detail}`);
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
