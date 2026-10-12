import * as fs from "node:fs";
import * as path from "node:path";
import { buildCrossRepoIndex, buildManifestForRepo, loadWorkspaceConfig } from "@rs-graph/workspace-store";

/**
 * Writes CROSS_REPO_MANIFEST.md/.json into each indexed repo's own root — deliberately not under
 * .rs-graph/ (which is always gitignored, local-cache-only). This file is meant to be committed,
 * so a repo-scoped GitHub Action or Claude-based reviewer with only this one repo checked out
 * still has this repo's cross-repo integration surface available, without a live workspace
 * server or any other repo's checkout. See docs/mcp-tools.md's "PR-review manifest" section.
 */
export function runGenerateManifest(workspaceConfigPath: string): void {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  if (config.repos.length === 0) {
    console.log(`${workspaceConfigPath}: "repos" is empty — nothing to generate a manifest for.`);
    return;
  }

  const index = buildCrossRepoIndex(config.repos);

  let written = 0;
  let skipped = 0;
  for (const repo of config.repos) {
    if (index.skippedRepos.includes(repo.name)) {
      console.log(`  [SKIP] ${repo.name} — not yet indexed, no manifest generated.`);
      skipped++;
      continue;
    }

    const { markdown, json } = buildManifestForRepo(index, repo.name, workspaceConfigPath);
    fs.writeFileSync(path.join(repo.path, "CROSS_REPO_MANIFEST.md"), markdown);
    fs.writeFileSync(path.join(repo.path, "CROSS_REPO_MANIFEST.json"), `${JSON.stringify(json, null, 2)}\n`);
    console.log(`  [OK] ${repo.name} — wrote CROSS_REPO_MANIFEST.md/.json`);
    written++;
  }

  console.log(`\n=== Manifests: ${written} written, ${skipped} skipped ===`);
}
