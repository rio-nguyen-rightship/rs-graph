#!/usr/bin/env node
// SessionStart hook for the rs-graph Claude Code plugin.
//
// Makes sure the repo Claude was opened in has a usable graph, then tells the agent (via
// additionalContext) what state it's in. Deterministic on purpose: a skill is only advice the
// model may or may not follow, whereas this always runs.
//
//   missing      -> start `rs-graph index` in the background
//   stale        -> start an incremental re-index in the background
//   needs-build  -> do nothing but tell the agent (rs-graph never runs restore/build itself)
//   degraded/ok  -> tell the agent
//
// Never blocks the session and never fails it: every problem degrades to "no context".
// Opt out with RS_GRAPH_AUTO_INDEX=0, or RS_GRAPH_AUTO_INDEX=missing to only build absent graphs
// (a re-index recompiles the whole repo, which is slow on big .NET solutions).

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// `rs-graph` is an npm-linked .cmd shim on Windows, which only resolves through a shell.
const USE_SHELL = process.platform === "win32";

/** Pure decision: what to do and what to tell the agent, given `rs-graph doctor --json` output. */
export function planSessionStart(report, mode = "1") {
  const nudge = "For questions about code structure use the rs-graph skill and graph_* tools before Grep.";

  switch (report.status) {
    case "missing":
      return {
        startIndex: mode !== "0",
        context:
          "rs-graph: this repo has no graph yet — indexing started in the background (log: .rs-graph/hooks.log). " +
          'Until it finishes, graph_* tools answer "not indexed yet"; use Grep/Read meanwhile and retry afterwards — ' +
          "no restart needed.",
      };
    case "stale": {
      const examples = (report.changedSinceIndex?.examples ?? []).slice(0, 3).join(", ");
      return {
        startIndex: mode === "1",
        context:
          `rs-graph: ${report.changedSinceIndex?.count ?? "some"} source file(s) changed since the graph was last ` +
          `built${examples ? ` (e.g. ${examples})` : ""}` +
          (mode === "1"
            ? " — a re-index started in the background. Graph answers may lag for a minute; "
            : " — auto re-index is off, so run `rs-graph index` to refresh. Graph answers may be out of date; ") +
          "verify anything surprising with Grep/Read.",
      };
    }
    case "needs-build":
      return {
        startIndex: false,
        context:
          `rs-graph: ${report.summary} ${report.suggestedAction} Don't run restore/build yourself — ask the user. ` +
          "Until then graph results for .NET code will be empty or incomplete; use Grep/Read.",
      };
    case "degraded":
      return {
        startIndex: false,
        context:
          `rs-graph: ${report.summary} ${report.suggestedAction} Treat empty callers/references for C# symbols as ` +
          '"unknown", not "none", and fall back to Grep.',
      };
    default:
      return {
        startIndex: false,
        context:
          `rs-graph: graph is up to date (${report.counts?.files ?? "?"} files, ${report.counts?.symbols ?? "?"} symbols). ` +
          nudge,
      };
  }
}

/** Windows needs a shell for the npm .cmd shim, but Node warns (DEP0190) about passing an args
 * array alongside `shell: true`. Every argument here is a fixed, space-free token, so joining
 * them into the command string is safe. */
function shellForm(command, args) {
  return USE_SHELL ? [[command, ...args].join(" "), []] : [command, args];
}

function run(command, args, cwd) {
  const [file, fileArgs] = shellForm(command, args);
  return execFileSync(file, fileArgs, {
    cwd,
    shell: USE_SHELL,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Keeps `.rs-graph/` out of `git status` without touching any tracked file: .git/info/exclude is
 * local to this clone. Skipped when the repo already ignores it. */
function excludeLocally(projectDir, report) {
  if (report.gitIgnored !== false) return;
  try {
    const excludePath = path.resolve(projectDir, run("git", ["rev-parse", "--git-path", "info/exclude"], projectDir).trim());
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (existing.split(/\r?\n/).includes(".rs-graph/")) return;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}.rs-graph/\n`);
  } catch {
    // Cosmetic only — never worth failing the session over.
  }
}

function startBackgroundIndex(projectDir) {
  const logDir = path.join(projectDir, ".rs-graph");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "hooks.log");
  fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] session-start: rs-graph index\n`);

  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-index.mjs");
  const child = spawn(process.execPath, [runner, projectDir], { detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function emit(context) {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}
`,
  );
}

export function main(env = process.env) {
  const mode = env.RS_GRAPH_AUTO_INDEX ?? "1";
  if (mode === "0") return;

  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  // Only real repo roots: a session opened in a workspace folder that merely *contains* repos
  // (e.g. C:\Git) must not be indexed as if it were one project.
  if (!fs.existsSync(path.join(projectDir, ".git"))) return;

  let report;
  try {
    report = JSON.parse(run("rs-graph", ["doctor", ".", "--json"], projectDir));
  } catch {
    emit(
      "rs-graph: the `rs-graph` CLI wasn't found on PATH (or failed), so no graph is available this session — " +
        "use Grep/Read. Install it with `npm link --workspace @rs-graph/cli` from the rs-graph repo.",
    );
    return;
  }
  if (!Array.isArray(report.languages) || report.languages.length === 0) return;

  const plan = planSessionStart(report, mode);
  if (plan.startIndex) {
    excludeLocally(projectDir, report);
    try {
      startBackgroundIndex(projectDir);
    } catch {
      // Couldn't start it (read-only checkout, say) — the context line would now be wrong.
      emit("rs-graph: this repo has no up-to-date graph and indexing couldn't be started (see .rs-graph/hooks.log).");
      return;
    }
  }
  emit(plan.context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    // A hook must never fail the session.
  }
}
