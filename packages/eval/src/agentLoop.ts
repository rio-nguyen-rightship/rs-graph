import Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "./types.js";

export interface AgentRunResult {
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
}

const SYSTEM_PROMPT =
  "You are a coding assistant investigating a codebase using only the tools provided. " +
  "Use as many tool calls as you need to give a complete, accurate answer — don't guess. " +
  "When you have enough information, respond with a final plain-text answer and no further tool calls.";

/**
 * Minimal Claude tool-use loop: call the model, execute any tool_use blocks against the
 * ToolDef handlers passed in, feed tool_result blocks back, repeat until the model stops
 * requesting tools (or maxTurns is hit). Both eval arms (fsTools, rsGraphTools) share this
 * loop — only the ToolDef list passed in differs, which is the whole point of the comparison.
 */
export async function runAgent(
  client: Anthropic,
  model: string,
  tools: ToolDef[],
  taskPrompt: string,
  maxTurns = 20,
): Promise<AgentRunResult> {
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: taskPrompt }];
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let turns = 0;

  for (turns = 1; turns <= maxTurns; turns++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools: anthropicTools,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
      const finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { finalText, inputTokens, outputTokens, toolCalls, turns };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      toolCalls++;
      const tool = toolByName.get(block.name);
      let resultText: string;
      let isError = false;
      if (!tool) {
        resultText = `Unknown tool: ${block.name}`;
        isError = true;
      } else {
        try {
          resultText = await tool.handler(block.input as Record<string, unknown>);
        } catch (err) {
          resultText = `Tool error: ${(err as Error).message}`;
          isError = true;
        }
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText, is_error: isError });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    finalText: "(max turns exceeded without a final answer)",
    inputTokens,
    outputTokens,
    toolCalls,
    turns: maxTurns,
  };
}
