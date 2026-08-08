import type { GroundTruth } from "./types.js";

export interface ScoreResult {
  recall: number;
  hallucinated: boolean;
}

/** Deliberately simple (case-insensitive substring match), not semantic — good enough to catch
 * "the answer never mentioned the actual caller" without needing an LLM-judge pass. Real-repo
 * tasks skip this entirely (no groundTruth) since there's no cheap way to auto-verify those. */
export function score(answer: string, groundTruth: GroundTruth): ScoreResult {
  const lower = answer.toLowerCase();
  const matched = groundTruth.mustMention.filter((s) => lower.includes(s.toLowerCase()));
  const recall = groundTruth.mustMention.length === 0 ? 1 : matched.length / groundTruth.mustMention.length;
  const hallucinated = (groundTruth.mustNotMention ?? []).some((s) => lower.includes(s.toLowerCase()));
  return { recall, hallucinated };
}
