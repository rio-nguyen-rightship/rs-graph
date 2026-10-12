import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.resolve(__dirname, "../../../plugin/hooks/session-start.mjs");
const { planSessionStart } = (await import(/* @vite-ignore */ pathToFileURL(HOOK_PATH).href)) as {
  planSessionStart: (report: Record<string, unknown>, mode?: string) => { startIndex: boolean; context: string };
};

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

describe("planSessionStart", () => {
  it("indexes a missing graph and says so", () => {
    const plan = planSessionStart({ status: "missing" });
    expect(plan.startIndex).toBe(true);
    expect(plan.context).toContain("indexing started");
  });

  it("re-indexes a stale graph, but not when auto-index is limited to missing graphs", () => {
    const report = { status: "stale", changedSinceIndex: { count: 2, examples: ["a.cs", "b.cs"] } };
    expect(planSessionStart(report, "1").startIndex).toBe(true);
    const limited = planSessionStart(report, "missing");
    expect(limited.startIndex).toBe(false);
    expect(limited.context).toContain("auto re-index is off");
  });

  it("never indexes when auto-index is off", () => {
    expect(planSessionStart({ status: "missing" }, "0").startIndex).toBe(false);
  });

  it("tells the agent not to build when .NET projects need a restore/build", () => {
    const plan = planSessionStart({ status: "needs-build", summary: "Not indexed.", suggestedAction: "Restore it." });
    expect(plan.startIndex).toBe(false);
    expect(plan.context).toContain("ask the user");
  });

  it("warns that empty C# results mean unknown when the graph is degraded", () => {
    const plan = planSessionStart({ status: "degraded", summary: "300 unresolved.", suggestedAction: "Rebuild." });
    expect(plan.startIndex).toBe(false);
    expect(plan.context).toContain('"unknown"');
  });

  it("just nudges toward the skill when everything is fine", () => {
    const plan = planSessionStart({ status: "ok", counts: { files: 10, symbols: 99 } });
    expect(plan.startIndex).toBe(false);
    expect(plan.context).toContain("up to date");
    expect(plan.context).toContain("rs-graph skill");
  });
});

describe("plugin/hooks/session-start.mjs", () => {
  let repo: string;
  let binDir: string;
  let invocationLog: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-session-hook-repo-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-session-hook-bin-"));
    invocationLog = path.join(binDir, "invocations.json");
    execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
  });

  afterEach(() => {
    rmSyncRetrying(repo);
    rmSyncRetrying(binDir);
  });

  /** A fake `rs-graph`: `doctor` prints $FAKE_DOCTOR_JSON, anything else (the background `index`)
   * is recorded to a file so the test can see what the hook launched. */
  function installFakeRsGraph(): void {
    const script = path.join(binDir, "fake-rs-graph.mjs");
    fs.writeFileSync(
      script,
      [
        'import * as fs from "node:fs";',
        "const args = process.argv.slice(2);",
        'if (args[0] === "doctor") { process.stdout.write(process.env.FAKE_DOCTOR_JSON ?? "{}"); }',
        `else { fs.writeFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ args, cwd: process.cwd() })); }`,
      ].join("\n"),
    );
    // Both shims: the hook uses a shell on Windows (finds the .cmd) and none elsewhere.
    fs.writeFileSync(path.join(binDir, "rs-graph.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
    const sh = path.join(binDir, "rs-graph");
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }

  function runHook(env: Record<string, string>, pathDirs: string[] = [binDir, process.env.PATH ?? ""]) {
    return spawnSync(process.execPath, [HOOK_PATH], {
      env: {
        ...process.env,
        PATH: pathDirs.join(path.delimiter),
        CLAUDE_PROJECT_DIR: repo,
        RS_GRAPH_AUTO_INDEX: "",
        ...env,
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
  }

  const contextOf = (stdout: string): string => JSON.parse(stdout).hookSpecificOutput.additionalContext;

  it("is silent outside a git repo root", () => {
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    installFakeRsGraph();

    const result = runHook({ FAKE_DOCTOR_JSON: JSON.stringify({ status: "missing", languages: ["csharp"] }) });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("is silent when the repo has no recognized project type", () => {
    installFakeRsGraph();

    const result = runHook({ FAKE_DOCTOR_JSON: JSON.stringify({ status: "missing", languages: [] }) });

    expect(result.stdout).toBe("");
    expect(fs.existsSync(invocationLog)).toBe(false);
  });

  it("does nothing when auto-index is turned off", () => {
    installFakeRsGraph();

    const result = runHook({
      RS_GRAPH_AUTO_INDEX: "0",
      FAKE_DOCTOR_JSON: JSON.stringify({ status: "missing", languages: ["csharp"] }),
    });

    expect(result.stdout).toBe("");
  });

  it("explains itself, and exits 0, when the rs-graph CLI isn't installed", () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-graph-session-hook-empty-"));
    try {
      const result = runHook({}, [emptyDir]);

      expect(result.status).toBe(0);
      expect(contextOf(result.stdout)).toContain("wasn't found on PATH");
    } finally {
      rmSyncRetrying(emptyDir);
    }
  });

  it("starts a background index for a missing graph and keeps .rs-graph out of git status", async () => {
    installFakeRsGraph();

    const result = runHook({
      FAKE_DOCTOR_JSON: JSON.stringify({ status: "missing", languages: ["csharp"], gitIgnored: false }),
    });

    expect(result.status).toBe(0);
    expect(contextOf(result.stdout)).toContain("indexing started");

    // The index is detached, so give the fake a moment to record that it ran.
    for (let i = 0; i < 100 && !fs.existsSync(invocationLog); i++) await new Promise((r) => setTimeout(r, 50));
    const invocation = JSON.parse(fs.readFileSync(invocationLog, "utf8")) as { args: string[]; cwd: string };
    expect(invocation.args).toEqual(["index", ".", "--no-mcp-config"]);
    expect(fs.realpathSync(invocation.cwd)).toBe(fs.realpathSync(repo));

    expect(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain(".rs-graph/");
  });

  it("only tells the agent when .NET projects need a build, without indexing", () => {
    installFakeRsGraph();

    const result = runHook({
      FAKE_DOCTOR_JSON: JSON.stringify({
        status: "needs-build",
        languages: ["csharp"],
        summary: "Not indexed.",
        suggestedAction: "Restore it.",
      }),
    });

    expect(contextOf(result.stdout)).toContain("ask the user");
    expect(fs.existsSync(invocationLog)).toBe(false);
    expect(fs.existsSync(path.join(repo, ".rs-graph"))).toBe(false);
  });
});
