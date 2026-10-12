import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndexWorkspace } from "./indexWorkspace.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-index-workspace-test-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("runIndexWorkspace", () => {
  it("skips a repo path that doesn't exist instead of fabricating it, and reports the batch as failed", async () => {
    // Real-world regression: a workspace.json path that resolves against the wrong base directory
    // can silently point at a path that was never a real directory at all. Indexing it anyway
    // would `mkdir -p` a brand-new, previously-nonexistent directory just to hold a nearly-empty
    // .rs-graph/graph.db (seen in the wild against psc-riskiq-app, where several stray subfolders
    // sharing names with unrelated sibling repos were fabricated entirely by rs-graph itself).
    const neverExisted = path.join(workspaceDir, "not-a-repo");

    const workspaceConfigPath = path.join(workspaceDir, "workspace.json");
    fs.writeFileSync(workspaceConfigPath, JSON.stringify({ repos: [{ name: "not-a-repo", path: "./not-a-repo" }] }));

    await runIndexWorkspace(workspaceConfigPath);

    expect(fs.existsSync(neverExisted)).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
