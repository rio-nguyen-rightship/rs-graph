# @rs-graph/eval

Runs the same set of codebase-understanding tasks through two arms — a filesystem
grep/read baseline, and rs-graph's MCP tools — and compares token cost, tool-call count, and
(for tasks with hand-verified ground truth) answer correctness. Implements the methodology
worked out for validating rs-graph's actual value versus "just grep and read files."

Scoped to **.NET and TypeScript/Angular** — see [tasks.ts](src/tasks.ts).

## Cost warning

**This script makes real, billed calls to the Anthropic API.** It does not use your Claude Code
session — it drives its own agent loop via `@anthropic-ai/sdk` against `ANTHROPIC_API_KEY`, and
every tool-use turn is a separate metered request. A single task run against a large real repo
with many tool calls can be a non-trivial number of tokens; the full built-in suite (16 tasks x 2
arms x N repetitions) multiplies that. **Start small** (see "Try it" below) before running the
full suite, and check your Anthropic usage dashboard if you're unsure what a run will cost.

## Setup

1. `export ANTHROPIC_API_KEY=...` (or the PowerShell equivalent) — required, the script exits
   immediately without it.
2. Build the package (and its workspace deps) from the repo root: `npm run build --workspaces`.
3. Fixture tasks (`fixture-dotnet`, `fixture-angular`) work out of the box — no setup needed,
   they read `fixtures/sample-dotnet-api` and `fixtures/sample-angular-app` directly.
4. For real-repo tasks: copy `repos.config.example.json` to `repos.config.json` (gitignored —
   real repo paths are machine-specific and shouldn't be committed) and fill in real paths. Then
   index each one first: `rs-graph index --fresh <path>` (see the root README for registering
   `rs-graph` as a global command). The rs-graph arm fails fast with a clear error if a repo
   hasn't been indexed yet.

## Try it

Cheapest possible sanity check — one task, one arm, one repetition, against a 5-file fixture:

```bash
node dist/runEval.js --tasks fixture-dotnet-callers --arms baseline --repetitions 1
```

Then the same task on the rs-graph arm, to see the comparison:

```bash
node dist/runEval.js --tasks fixture-dotnet-callers --arms baseline,rs-graph --repetitions 1
```

Full suite (all tasks, both arms, 3 repetitions each — this is the expensive one):

```bash
node dist/runEval.js
```

### Flags

- `--tasks a,b,c` — run only these task ids (see `src/tasks.ts` for the full list).
- `--arms baseline,rs-graph` — defaults to both; restrict to one to isolate cost.
- `--repetitions N` — default 3. LLM output is stochastic; a single run per condition will make
  noise look like signal — this is why the methodology calls for repetitions, not raw cost.
- `--model <id>` — default `claude-sonnet-5` (or `$EVAL_MODEL`). Keep this pinned across a
  comparison run — switching models mid-suite invalidates the comparison.
- `--max-turns N` — default 20; caps how many tool-use round-trips one task run can take before
  it's recorded as "gave up."

## What it measures, and what it doesn't

- **Fixture tasks** (`fixture-*`) have hand-verified `groundTruth.mustMention` arrays — the
  final answer is scored for recall (did it mention every expected fact) automatically. These
  are too small (5-9 files) to show meaningful token savings; they exist to catch correctness
  regressions (e.g. a change that makes the rs-graph arm miss the polymorphic-caller case) cheaply.
- **Real-repo tasks** (`real-*`) have no automated ground truth — correctness there needs an
  independent oracle (e.g. Rider/Visual Studio "Find All References") that this script doesn't
  have access to. These tasks report cost only; `finalAnswer` is written to the results JSON for
  manual review. Don't read a real-repo cost win as a correctness win without checking the answer.
- Every run's raw data (tokens, tool calls, turns, wall-clock, final answer text, error if any)
  is written to `results/run-<timestamp>.json` (gitignored) — the console summary is a median
  rollup by category+arm, not the full picture.

## Adding tasks or repos

- New task: add an entry to `TASKS` in `src/tasks.ts`. Keep the `prompt` tool-agnostic (don't
  name `graph_*` tools or say "grep for X") so it doesn't prime which arm's tools to use.
- New repo: add a key to `repos.config.json` (`{ "key": { "path": "...", "language": "csharp" |
  "typescript" } }`), reference it as a task's `repoKey`, and index it with `rs-graph index
  --fresh` first.

## Known limitations

- Baseline tools (`grep`/`read_file`/`list_files` in `src/tools/fsTools.ts`) are a reasonable
  stand-in for Claude Code's real Read/Grep, not a byte-for-byte reimplementation — result caps,
  ignore-lists, and line-numbering follow the same conventions but aren't guaranteed identical.
- No statistical significance testing — with a handful of repetitions per task, treat results as
  directional (medians, not p-values), per the methodology this implements.
