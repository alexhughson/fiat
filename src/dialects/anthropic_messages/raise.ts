// lower IR -> core IR. Shared between requests and responses.

import { opData, type Op, type Program, type StopReason } from "../../core/ops";
import { LintError } from "../../core/pass";
import type { WireAnthropicMessage, WireBlock } from "./ops";

export function raise(program: Program): Program {
  const out: Program = [];
  for (const op of program) {
    switch (op.op) {
      case "anthropic_messages.message":
        out.push(...raiseMessage(opData<{ message: WireAnthropicMessage }>(op).message));
        break;
      case "anthropic_messages.stop_reason":
        out.push({ op: "response.stop", reason: raiseStopReason(opData<{ value: string }>(op).value) });
        break;
      case "anthropic_messages.usage": {
        const { input_tokens, output_tokens, ...rest } = opData<{ usage: Record<string, unknown> }>(op).usage;
        out.push({
          op: "response.usage",
          ...(input_tokens != null ? { inputTokens: input_tokens as number } : {}),
          ...(output_tokens != null ? { outputTokens: output_tokens as number } : {}),
        });
        if (Object.keys(rest).length > 0) {
          out.push({ op: "anthropic_messages.usage", usage: rest, required: false });
        }
        break;
      }
      default:
        out.push(op);
    }
  }
  return out;
}

function raiseMessage(message: WireAnthropicMessage): Op[] {
  const { role, content } = message;
  if (typeof content === "string") {
    return content === "" ? [] : [{ op: "llm.text", role, content }];
  }
  return content.map((block) => raiseBlock(role, block));
}

function raiseBlock(role: "user" | "assistant", block: WireBlock): Op {
  switch (block.type) {
    case "text":
      return { op: "llm.text", role, content: block.text ?? "" };
    case "tool_use":
      return {
        op: "llm.tool_call",
        id: block.id ?? missing("tool_use.id"),
        name: block.name ?? missing("tool_use.name"),
        arguments: block.input ?? {},
      };
    case "tool_result":
      return {
        op: "llm.tool_result",
        id: block.tool_use_id ?? missing("tool_result.tool_use_id"),
        content: flattenResultContent(block.content),
        ...(block.is_error ? { isError: true } : {}),
      };
    default:
      throw new LintError(`anthropic_messages message: unsupported block type ${JSON.stringify(block.type)}`);
  }
}

function flattenResultContent(content: WireBlock["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") {
        throw new LintError(`anthropic_messages tool_result: unsupported block type ${JSON.stringify(block.type)}`);
      }
      return block.text;
    })
    .join("\n");
}

function missing(field: string): never {
  throw new Error(`anthropic_messages block: missing ${field}`);
}

const WIRE_STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  tool_use: "tool_use",
  stop_sequence: "stop_sequence",
};

export function raiseStopReason(value: string): StopReason {
  const reason = WIRE_STOP_REASONS[value];
  if (!reason) throw new LintError(`anthropic_messages stop_reason "${value}" has no core stop reason mapping`);
  return reason;
}
