import * as fs from "node:fs";
import * as path from "node:path";
import { buildCrossRepoIndex, buildManifestForRepo, loadWorkspaceConfig } from "@rs-graph/workspace-store";

export interface ManifestRunResult {
  written: string[];
  unchanged: string[];
  skipped: string[];
}

/** The manifest's own content, minus the timestamp that would otherwise make every regeneration
 * look like a change. */
function withoutTimestamp(json: unknown): string {
  const { generatedAt: _ignored, ...rest } = json as Record<string, unknown>;
  return JSON.stringify(rest);
}

function isUnchanged(repoPath: string, next: { generatedAt: string }): boolean {
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(repoPath, "CROSS_REPO_MANIFEST.json"), "utf8"));
    return fs.existsSync(path.join(repoPath, "CROSS_REPO_MANIFEST.md")) && withoutTimestamp(existing) === withoutTimestamp(next);
  } catch {
    return false;
  }
}

/**
 * Writes CROSS_REPO_MANIFEST.md/.json into each indexed repo's own root — deliberately not under
 * .rs-graph/ (which is always gitignored, local-cache-only). This file is meant to be committed,
 * so a repo-scoped GitHub Action or Claude-based reviewer with only this one repo checked out
 * still has this repo's cross-repo integration surface available, without a live workspace
 * server or any other repo's checkout. See docs/mcp-tools.md's "PR-review manifest" section.
 *
 * A repo's files are only rewritten when their content changed (ignoring the timestamp), so
 * regenerating after every change — as `watch-workspace` does — leaves no spurious git diffs.
 * Prints nothing; callers decide what to report.
 */
export function generateManifests(workspaceConfigPath: string): ManifestRunResult {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  const result: ManifestRunResult = { written: [], unchanged: [], skipped: [] };
  if (config.repos.length === 0) return result;

  const index = buildCrossRepoIndex(config.repos);
  for (const repo of config.repos) {
    if (index.skippedRepos.includes(repo.name)) {
      result.skipped.push(repo.name);
      continue;
    }

    const { markdown, json } = buildManifestForRepo(index, repo.name, workspaceConfigPath);
    if (isUnchanged(repo.path, json)) {
      result.unchanged.push(repo.name);
      continue;
    }
    fs.writeFileSync(path.join(repo.path, "CROSS_REPO_MANIFEST.md"), markdown);
    fs.writeFileSync(path.join(repo.path, "CROSS_REPO_MANIFEST.json"), `${JSON.stringify(json, null, 2)}\n`);
    result.written.push(repo.name);
  }
  return result;
}

export function runGenerateManifest(workspaceConfigPath: string): void {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  if (config.repos.length === 0) {
    console.log(`${workspaceConfigPath}: "repos" is empty — nothing to generate a manifest for.`);
    return;
  }

  const result = generateManifests(workspaceConfigPath);
  for (const name of result.written) console.log(`  [OK] ${name} — wrote CROSS_REPO_MANIFEST.md/.json`);
  for (const name of result.unchanged) console.log(`  [UNCHANGED] ${name} — manifest already up to date`);
  for (const name of result.skipped) console.log(`  [SKIP] ${name} — not yet indexed, no manifest generated.`);
  console.log(
    `\n=== Manifests: ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.skipped.length} skipped ===`,
  );
}
