import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHook, installHookWorkspace } from "./installHook.js";

function initGitRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-install-hook-test-"));
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  return repoPath;
}

function getHooksPath(repoPath: string): string | undefined {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

describe("installHook", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = initGitRepo();
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  const HOOK_NAMES = ["post-merge", "post-checkout", "post-rewrite"];

  it("copies every hook template into .githooks/ and points core.hooksPath at it", () => {
    installHook(repoPath);

    for (const name of HOOK_NAMES) {
      const hookPath = path.join(repoPath, ".githooks", name);
      expect(fs.existsSync(hookPath)).toBe(true);
      const hookContent = fs.readFileSync(hookPath, "utf8");
      expect(hookContent).toContain("rs-graph index");
      expect(hookContent).toContain("nohup");
    }

    expect(getHooksPath(repoPath)).toBe(".githooks");
  });

  it("does not overwrite an already-customized core.hooksPath", () => {
    fs.mkdirSync(path.join(repoPath, "custom-hooks"), { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", "custom-hooks"], { cwd: repoPath });

    installHook(repoPath);

    // The hook files are still installed (so the user can move them manually), but the existing
    // customization is left untouched rather than silently overwritten.
    for (const name of HOOK_NAMES) {
      expect(fs.existsSync(path.join(repoPath, ".githooks", name))).toBe(true);
    }
    expect(getHooksPath(repoPath)).toBe("custom-hooks");
  });

  it("is safe to run twice", () => {
    installHook(repoPath);
    installHook(repoPath);

    expect(getHooksPath(repoPath)).toBe(".githooks");
    for (const name of HOOK_NAMES) {
      expect(fs.existsSync(path.join(repoPath, ".githooks", name))).toBe(true);
    }
  });
});

describe("installHookWorkspace", () => {
  let workspaceDir: string;
  let repoA: string;
  let repoB: string;
  let workspaceConfigPath: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-install-hook-workspace-test-"));
    repoA = path.join(workspaceDir, "repo-a");
    repoB = path.join(workspaceDir, "repo-b");
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);
    execFileSync("git", ["init"], { cwd: repoA, stdio: "pipe" });
    execFileSync("git", ["init"], { cwd: repoB, stdio: "pipe" });

    workspaceConfigPath = path.join(workspaceDir, "workspace.json");
    fs.writeFileSync(
      workspaceConfigPath,
      JSON.stringify({ repos: [{ name: "repo-a", path: "./repo-a" }, { name: "repo-b", path: "./repo-b" }] }),
    );
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("installs every hook into every repo listed in the workspace config", () => {
    installHookWorkspace(workspaceConfigPath);

    for (const repo of [repoA, repoB]) {
      for (const name of ["post-merge", "post-checkout", "post-rewrite"]) {
        expect(fs.existsSync(path.join(repo, ".githooks", name))).toBe(true);
      }
      expect(getHooksPath(repo)).toBe(".githooks");
    }
  });
});
