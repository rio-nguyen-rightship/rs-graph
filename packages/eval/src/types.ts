/** A tool exposed to the model during an eval run, in Anthropic's tool-use shape. Both arms
 * (filesystem baseline and rs-graph MCP bridge) implement this same interface so agentLoop.ts
 * doesn't need to know which arm it's driving. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<string>;
}

export type Arm = "baseline" | "rs-graph";

export type Language = "csharp" | "typescript";

export type TaskCategory =
  | "callers"
  | "impact"
  | "hierarchy"
  | "di"
  | "file-outline"
  | "trivial-lookup";

export interface GroundTruth {
  /** Case-insensitive substrings the final answer must contain to count as correct — the
   * cheap, automatable half of scoring. Real-repo tasks without hand-verified ground truth
   * omit this and are scored by cost alone; the answer text is still recorded for manual review. */
  mustMention: string[];
  /** Substrings whose presence indicates a wrong/hallucinated answer (e.g. a class that looks
   * plausible but isn't actually in the call chain). Optional — most tasks don't need this. */
  mustNotMention?: string[];
}

export interface EvalTask {
  id: string;
  language: Language;
  category: TaskCategory;
  /** Key into repos.config.json (or the built-in fixture repos — see config.ts). */
  repoKey: string;
  /** Natural-language task, deliberately tool-agnostic so it doesn't prime which arm's tools
   * to reach for. */
  prompt: string;
  groundTruth?: GroundTruth;
}

export interface RunResult {
  taskId: string;
  arm: Arm;
  repetition: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
  wallClockMs: number;
  finalAnswer: string;
  /** undefined when the task has no groundTruth — cost-only task. */
  recall?: number;
  hallucinated?: boolean;
  error?: string;
}
