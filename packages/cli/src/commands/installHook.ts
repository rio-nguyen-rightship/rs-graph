import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { loadWorkspaceConfig } from "@rs-graph/workspace-store";

/** Every git event that can change working-tree content without the developer's own editor doing
 * it — pull/merge, branch switch, rebase/amend — each gets its own hook file (git dispatches by
 * filename), all running the same background reindex. `reset --hard` and `stash pop`/`apply`
 * change the tree too but git has no hook for either; `watch` is the only thing that catches those
 * live, and a stale graph otherwise just needs a manual `rs-graph index`. */
const HOOK_NAMES = ["post-merge", "post-checkout", "post-rewrite"] as const;

/**
 * Locates templates/<name>.sample relative to this package's own install location. Same
 * development-mode-only resolution caveat as findDotnetIndexerDll/findPythonIndexerScript in
 * indexRepo.ts — this only resolves inside the rs-graph monorepo during development.
 */
function findHookTemplate(name: string): string | undefined {
  const templatePath = path.resolve(import.meta.dirname, `../../../../templates/${name}.sample`);
  return fs.existsSync(templatePath) ? templatePath : undefined;
}

/**
 * Installs every hook in HOOK_NAMES into one repo: copies each template to .githooks/<name>
 * (overwriting any previous copy — these are rs-graph's own generated files, not user-editable
 * config, so there's nothing to preserve across a reinstall) and points core.hooksPath at
 * .githooks, unless it's already pointed somewhere else, in which case that customization is
 * left alone rather than silently overwritten.
 */
export function installHook(repoPath: string): void {
  const hooksDir = path.join(repoPath, ".githooks");
  fs.mkdirSync(hooksDir, { recursive: true });

  const installed: string[] = [];
  for (const name of HOOK_NAMES) {
    const templatePath = findHookTemplate(name);
    if (!templatePath) {
      console.error(`Hook template not found for ${name} (development-mode path resolution — see installHook.ts).`);
      process.exitCode = 1;
      continue;
    }
    const hookPath = path.join(hooksDir, name);
    fs.copyFileSync(templatePath, hookPath);
    fs.chmodSync(hookPath, 0o755);
    installed.push(name);
  }
  if (installed.length === 0) return;

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
    console.log(`  Installed .githooks/{${installed.join(",")}}, but core.hooksPath is already "${currentHooksPath}" — left as-is.`);
    console.log(`  Move them into "${currentHooksPath}", or run: git config core.hooksPath .githooks`);
    return;
  }

  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: repoPath });
  console.log(`  Installed ${installed.join(", ")} hooks at ${hooksDir}, set core.hooksPath to .githooks.`);
  console.log(
    `  Commit .githooks/{${installed.join(",")}} so they're shared with the rest of the team (on Windows, also run ` +
      `\`git update-index --chmod=+x ${installed.map((n) => `.githooks/${n}`).join(" ")}\` after staging them, ` +
      "since NTFS doesn't track the bit).",
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
