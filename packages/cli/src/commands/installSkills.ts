import * as fs from "node:fs";
import * as path from "node:path";
import { loadWorkspaceConfig } from "@rs-graph/workspace-store";

/**
 * Locates plugin/skills relative to this package's own install location. Same development-mode-only
 * resolution caveat as findHookTemplate in installHook.ts — this only resolves inside the rs-graph
 * monorepo during development.
 */
function findSkillsRoot(): string | undefined {
  const skillsRoot = path.resolve(import.meta.dirname, "../../../../plugin/skills");
  return fs.existsSync(skillsRoot) ? skillsRoot : undefined;
}

export interface InstallSkillsResult {
  written: string[];
  unchanged: string[];
  /** Exist with different content — left alone unless `force`. */
  differing: string[];
}

/**
 * Copies the plugin's skills into <repo>/.claude/skills/ so they're committed with the repo and
 * load for anyone (or any CI job) that opens it — the route for repos or environments where the
 * Claude Code plugin isn't installed, notably a GitHub Action reviewing a PR with only this repo
 * checked out. An existing file with different content is treated as a deliberate local edit and
 * left alone unless `force` is set.
 */
export function installSkills(repoPath: string, options: { force?: boolean } = {}): InstallSkillsResult {
  const skillsRoot = findSkillsRoot();
  if (!skillsRoot) {
    throw new Error("Skill sources not found (development-mode path resolution — see installSkills.ts).");
  }

  const result: InstallSkillsResult = { written: [], unchanged: [], differing: [] };
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(source)) continue;

    const target = path.join(repoPath, ".claude", "skills", entry.name, "SKILL.md");
    const wanted = fs.readFileSync(source, "utf8");
    const label = path.join(".claude", "skills", entry.name, "SKILL.md");

    if (fs.existsSync(target)) {
      if (fs.readFileSync(target, "utf8") === wanted) {
        result.unchanged.push(label);
        continue;
      }
      if (!options.force) {
        result.differing.push(label);
        continue;
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, wanted);
    result.written.push(label);
  }
  return result;
}

function report(result: InstallSkillsResult): void {
  for (const f of result.written) console.log(`  [OK] wrote ${f}`);
  for (const f of result.unchanged) console.log(`  [UNCHANGED] ${f}`);
  for (const f of result.differing) console.log(`  [SKIP] ${f} differs from the shipped version — pass --force to overwrite it.`);
  if (result.written.length > 0) console.log("  Commit .claude/skills/ so the rest of the team (and CI) gets them.");
}

export function runInstallSkills(repoPath: string, options: { force?: boolean } = {}): void {
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    console.error(`${repoPath} is not an existing directory.`);
    process.exitCode = 1;
    return;
  }
  report(installSkills(repoPath, options));
}

/** Installs the skills into every repo listed in a workspace.json, with per-repo isolation. */
export function installSkillsWorkspace(workspaceConfigPath: string, options: { force?: boolean } = {}): void {
  const config = loadWorkspaceConfig(workspaceConfigPath);
  if (config.repos.length === 0) {
    console.log(`${workspaceConfigPath}: "repos" is empty — nothing to install into.`);
    return;
  }

  let failed = 0;
  for (const repo of config.repos) {
    console.log(`\n=== ${repo.name} (${repo.path}) ===`);
    try {
      runInstallSkills(repo.path, options);
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
