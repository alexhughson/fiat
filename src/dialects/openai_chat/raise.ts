// lower IR -> core IR. Rewrites the openai_chat ops this dialect owns into
// core ops; passes through core ops and leaves openai_chat.param residuals
// in place. Shared between requests and responses — the ops are the same
// shapes in both directions.

import { opData, type Op, type Program, type StopReason } from "../../core/ops";
import { LintError } from "../../core/pass";
import type { WireContentPart, WireMessage } from "./ops";

export function raise(program: Program): Program {
  const out: Program = [];
  for (const op of program) {
    switch (op.op) {
      case "openai_chat.message":
        out.push(...raiseMessage(opData<{ message: WireMessage }>(op).message));
        break;
      case "openai_chat.finish_reason":
        out.push({ op: "response.stop", reason: raiseFinishReason(opData<{ value: string }>(op).value) });
        break;
      case "openai_chat.usage": {
        const { prompt_tokens, completion_tokens, ...rest } = opData<{ usage: Record<string, unknown> }>(op).usage;
        out.push({
          op: "response.usage",
          ...(prompt_tokens != null ? { inputTokens: prompt_tokens as number } : {}),
          ...(completion_tokens != null ? { outputTokens: completion_tokens as number } : {}),
        });
        if (Object.keys(rest).length > 0) {
          out.push({ op: "openai_chat.usage", usage: rest, required: false });
        }
        break;
      }
      default:
        out.push(op);
    }
  }
  return out;
}

function raiseMessage(message: WireMessage): Op[] {
  const ops: Op[] = [];
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
      ops.push(...textOps(message.role, message.content));
      for (const call of message.tool_calls ?? []) {
        ops.push({
          op: "llm.tool_call",
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments, call.id),
        });
      }
      break;
    case "tool": {
      if (!message.tool_call_id) throw new Error("openai_chat tool message: missing tool_call_id");
      ops.push({
        op: "llm.tool_result",
        id: message.tool_call_id,
        content: flattenText(message.content),
      });
      break;
    }
    default:
      throw new LintError(`openai_chat message: unsupported role ${JSON.stringify(message.role)}`);
  }
  return ops;
}

function textOps(role: "system" | "user" | "assistant", content: WireMessage["content"]): Op[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content === "" ? [] : [{ op: "llm.text", role, content }];
  }
  return content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") {
      throw new LintError(`openai_chat message: unsupported content part type ${JSON.stringify(part.type)}`);
    }
    return { op: "llm.text", role, content: part.text };
  });
}

function flattenText(content: string | WireContentPart[] | null): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") {
        throw new LintError(`openai_chat tool result: unsupported content part type ${JSON.stringify(part.type)}`);
      }
      return part.text;
    })
    .join("\n");
}

function parseArguments(raw: string, callId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new Error(`openai_chat tool call ${callId}: arguments are not valid JSON: ${raw}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`openai_chat tool call ${callId}: arguments must be a JSON object, got ${raw}`);
  }
  return parsed as Record<string, unknown>;
}

const FINISH_REASON_TO_STOP: Record<string, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
};

export function raiseFinishReason(value: string): StopReason {
  const reason = FINISH_REASON_TO_STOP[value];
  if (!reason) throw new LintError(`openai_chat finish_reason "${value}" has no core stop reason mapping`);
  return reason;
}

export const STOP_TO_FINISH_REASON: Record<StopReason, string> = {
  end_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  stop_sequence: "stop",
};
