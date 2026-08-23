import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, "../../../templates/post-merge.sample");

/**
 * The hook intentionally backgrounds its actual work and returns before that work is done (the
 * whole point — see the hook's own comment) — so on Windows, the detached process can still hold
 * a file handle open inside the test's temp dir for a few ms after spawnSync already returned.
 * Retrying a bounded number of times avoids a flaky EPERM on cleanup without masking a real leak
 * (a real leak would still fail after all retries are exhausted).
 */
function rmSyncRetrying(target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/**
 * The hook's one hard requirement — see templates/post-merge.sample's own comment — is that it
 * can never make `git pull`/merge look like it failed, no matter what state the repo or the
 * `rs-graph` command is in. These exercise that directly, without needing a real index to run.
 */
describe("templates/post-merge.sample", () => {
  let repoPath: string;
  let binDir: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-post-merge-hook-test-"));
    execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-post-merge-hook-bin-"));
  });

  afterEach(() => {
    rmSyncRetrying(repoPath);
    rmSyncRetrying(binDir);
  });

  function withFakeRsGraphOnPath(): NodeJS.ProcessEnv {
    const fakeRsGraph = path.join(binDir, "rs-graph");
    fs.writeFileSync(fakeRsGraph, "#!/bin/sh\nexit 1\n"); // fails — proves the hook doesn't care
    fs.chmodSync(fakeRsGraph, 0o755);
    // path.delimiter, not a hardcoded ":" — Windows PATH entries are drive-letter paths like
    // "C:\...", so joining with ":" would misparse the drive letter itself as a path segment.
    return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  }

  it("exits 0 when rs-graph isn't on PATH", () => {
    // This dev sandbox has no globally-installed rs-graph (see README's "Not done yet: standalone
    // npx rs-graph distribution") — the real inherited PATH already exercises the absent case.
    const result = spawnSync("sh", [TEMPLATE_PATH], { cwd: repoPath, env: process.env });
    expect(result.status).toBe(0);
  });

  it("exits 0 when rs-graph is on PATH but the repo/index would fail", () => {
    // The hook backgrounds the actual index run and returns before it's even done, so a failing
    // rs-graph can't affect the hook's own exit code either way — this proves that isolation
    // actually holds, not just that the failure is caught.
    const result = spawnSync("sh", [TEMPLATE_PATH], { cwd: repoPath, env: withFakeRsGraphOnPath() });
    expect(result.status).toBe(0);
  });

  it("still exits 0 outside of any git repo", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-post-merge-hook-nongit-"));
    try {
      const result = spawnSync("sh", [TEMPLATE_PATH], { cwd: outsideDir, env: withFakeRsGraphOnPath() });
      expect(result.status).toBe(0);
    } finally {
      rmSyncRetrying(outsideDir);
    }
  });
});
