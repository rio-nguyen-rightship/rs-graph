import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { loadWorkspaceConfig } from "@rs-graph/workspace-store";

/**
 * Locates templates/post-merge.sample relative to this package's own install location. Same
 * development-mode-only resolution caveat as findDotnetIndexerDll/findPythonIndexerScript in
 * indexRepo.ts — this only resolves inside the rs-graph monorepo during development.
 */
function findHookTemplate(): string | undefined {
  const templatePath = path.resolve(import.meta.dirname, "../../../../templates/post-merge.sample");
  return fs.existsSync(templatePath) ? templatePath : undefined;
}

/**
 * Installs the post-merge hook into one repo: copies the template to .githooks/post-merge
 * (overwriting any previous copy — this is rs-graph's own generated file, not a user-editable
 * config, so there's nothing to preserve across a reinstall) and points core.hooksPath at
 * .githooks, unless it's already pointed somewhere else, in which case that customization is
 * left alone rather than silently overwritten.
 */
export function installHook(repoPath: string): void {
  const templatePath = findHookTemplate();
  if (!templatePath) {
    console.error("Hook template not found (development-mode path resolution — see installHook.ts).");
    process.exitCode = 1;
    return;
  }

  const hooksDir = path.join(repoPath, ".githooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "post-merge");
  fs.copyFileSync(templatePath, hookPath);
  fs.chmodSync(hookPath, 0o755);

  let currentHooksPath: string | undefined;
  try {
    currentHooksPath = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    currentHooksPath = undefined; // core.hooksPath isn't set yet.
  }

  if (currentHooksPath && currentHooksPath !== ".githooks") {
    console.log(`  Installed .githooks/post-merge, but core.hooksPath is already "${currentHooksPath}" — left as-is.`);
    console.log(`  Move .githooks/post-merge into "${currentHooksPath}", or run: git config core.hooksPath .githooks`);
    return;
  }

  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: repoPath });
  console.log(`  Installed post-merge hook at ${hookPath}, set core.hooksPath to .githooks.`);
  console.log(
    "  Commit .githooks/post-merge so it's shared with the rest of the team (on Windows, also run " +
      "`git update-index --chmod=+x .githooks/post-merge` after staging it, since NTFS doesn't track the bit).",
  );
}

/** Installs the hook into every repo listed in a workspace.json, with per-repo isolation — one
 * repo's git-config failure (e.g. not actually a git repo) shouldn't abort the rest. */
export function installHookWorkspace(workspaceConfigPath: string): void {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  if (config.repos.length === 0) {
    console.log(`${workspaceConfigPath}: "repos" is empty — nothing to install into.`);
    return;
  }

  let failed = 0;
  for (const repo of config.repos) {
    console.log(`\n=== ${repo.name} (${repo.path}) ===`);
    try {
      installHook(repo.path);
    } catch (err) {
      failed++;
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} of ${config.repos.length} repo(s) failed — see above.`);
    process.exitCode = 1;
  }
}
