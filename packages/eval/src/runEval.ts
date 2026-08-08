import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agentLoop.js";
import { resolveRepo } from "./config.js";
import { score } from "./score.js";
import { TASKS } from "./tasks.js";
import { createFsTools } from "./tools/fsTools.js";
import { createRsGraphTools, type RsGraphTools } from "./tools/rsGraphTools.js";
import type { Arm, EvalTask, RunResult, ToolDef } from "./types.js";

interface CliArgs {
  repetitions: number;
  model: string;
  maxTurns: number;
  taskIds?: string[];
  arms: Arm[];
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const armsRaw = get("--arms");
  return {
    repetitions: Number(get("--repetitions") ?? 3),
    model: get("--model") ?? process.env.EVAL_MODEL ?? "claude-sonnet-5",
    maxTurns: Number(get("--max-turns") ?? 20),
    taskIds: get("--tasks")?.split(","),
    arms: (armsRaw?.split(",") as Arm[] | undefined) ?? ["baseline", "rs-graph"],
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

const rsGraphCache = new Map<string, RsGraphTools>();

async function getToolsForArm(arm: Arm, repoKey: string): Promise<ToolDef[]> {
  const repo = resolveRepo(repoKey);
  if (arm === "baseline") return createFsTools(repo.path);
  let cached = rsGraphCache.get(repoKey);
  if (!cached) {
    cached = await createRsGraphTools(repo.path);
    rsGraphCache.set(repoKey, cached);
  }
  return cached.tools;
}

async function runOne(
  client: Anthropic,
  args: CliArgs,
  task: EvalTask,
  arm: Arm,
  repetition: number,
): Promise<RunResult> {
  const started = Date.now();
  try {
    const tools = await getToolsForArm(arm, task.repoKey);
    const result = await runAgent(client, args.model, tools, task.prompt, args.maxTurns);
    const base: RunResult = {
      taskId: task.id,
      arm,
      repetition,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls,
      turns: result.turns,
      wallClockMs: Date.now() - started,
      finalAnswer: result.finalText,
    };
    if (task.groundTruth) {
      const { recall, hallucinated } = score(result.finalText, task.groundTruth);
      return { ...base, recall, hallucinated };
    }
    return base;
  } catch (err) {
    return {
      taskId: task.id,
      arm,
      repetition,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      turns: 0,
      wallClockMs: Date.now() - started,
      finalAnswer: "",
      error: (err as Error).message,
    };
  }
}

function printSummary(results: RunResult[]): void {
  const byKey = new Map<string, RunResult[]>();
  for (const r of results) {
    const task = TASKS.find((t) => t.id === r.taskId);
    const key = `${task?.category ?? "unknown"} / ${r.arm}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  const rows: string[][] = [["category / arm", "n", "median tokens (in+out)", "median tool calls", "recall", "errors"]];
  for (const [key, list] of [...byKey.entries()].sort()) {
    const ok = list.filter((r) => !r.error);
    const totalTokens = ok.map((r) => r.inputTokens + r.outputTokens);
    const toolCalls = ok.map((r) => r.toolCalls);
    const withRecall = ok.filter((r) => r.recall !== undefined);
    const recall =
      withRecall.length > 0
        ? `${(withRecall.reduce((s, r) => s + (r.recall ?? 0), 0) / withRecall.length).toFixed(2)}`
        : "n/a";
    const errors = list.length - ok.length;
    rows.push([key, String(list.length), String(Math.round(median(totalTokens))), String(median(toolCalls)), recall, String(errors)]);
  }

  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  |  "));
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. This script makes real, billed API calls — see README.md.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const tasks = args.taskIds ? TASKS.filter((t) => args.taskIds!.includes(t.id)) : TASKS;
  if (tasks.length === 0) {
    console.error("No tasks matched --tasks filter.");
    process.exit(1);
  }

  const totalRuns = tasks.length * args.arms.length * args.repetitions;
  console.log(
    `Running ${tasks.length} task(s) x ${args.arms.length} arm(s) x ${args.repetitions} repetition(s) ` +
      `= ${totalRuns} agent runs against ${args.model}. This costs real API tokens.\n`,
  );

  const client = new Anthropic({ apiKey });
  const results: RunResult[] = [];

  for (const task of tasks) {
    for (const arm of args.arms) {
      for (let rep = 1; rep <= args.repetitions; rep++) {
        process.stdout.write(`  ${task.id} [${arm}] rep ${rep}/${args.repetitions} ... `);
        const result = await runOne(client, args, task, arm, rep);
        console.log(result.error ? `ERROR: ${result.error}` : `${result.inputTokens + result.outputTokens} tokens, ${result.toolCalls} tool calls`);
        results.push(result);
      }
    }
  }

  for (const cached of rsGraphCache.values()) cached.close();

  console.log("\n=== Summary ===");
  printSummary(results);

  const resultsDir = path.resolve(import.meta.dirname, "../results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `run-${new Date().toISOString().replaceAll(":", "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nRaw results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
