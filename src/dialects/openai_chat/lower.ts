// core IR -> lower IR. The core IR deliberately flattens message grouping,
// so the work here is regrouping: consecutive assistant text + tool calls
// become one wire message, tool results become role:"tool" messages. Core
// ops that toWire serializes directly (llm.model, llm.tool, ...) pass
// through untouched, as do residuals (the pipeline lints foreign ones).

import type { OpOf, Program } from "../../core/ops";
import { STOP_TO_FINISH_REASON } from "./raise";
import type { WireMessage, WireToolCall } from "./ops";

export function lowerRequest(program: Program): Program {
  const out: Program = [];
  let openMessage: WireMessage | undefined;

  const flush = () => {
    if (openMessage) {
      out.push({ op: "openai_chat.message", message: openMessage });
      openMessage = undefined;
    }
  };

  for (const op of program) {
    switch (op.op) {
      case "llm.text": {
        const text = op as OpOf<"llm.text">;
        flush();
        openMessage = { role: text.role, content: text.content };
        break;
      }
      case "llm.tool_call": {
        // Attach to an open assistant message so "text then call" stays one
        // wire message; a bare call gets content: null per the wire format.
        if (!openMessage || openMessage.role !== "assistant") {
          flush();
          openMessage = { role: "assistant", content: null };
        }
        (openMessage.tool_calls ??= []).push(wireToolCall(op as OpOf<"llm.tool_call">));
        flush();
        break;
      }
      case "llm.tool_result": {
        const result = op as OpOf<"llm.tool_result">;
        flush();
        out.push({
          op: "openai_chat.message",
          message: { role: "tool", tool_call_id: result.id, content: result.content },
        });
        break;
      }
      default:
        flush();
        out.push(op);
    }
  }
  flush();
  return out;
}

export function lowerResponse(program: Program): Program {
  const out: Program = [];
  const texts: string[] = [];
  const toolCalls: WireToolCall[] = [];

  for (const op of program) {
    switch (op.op) {
      case "llm.text": {
        const text = op as OpOf<"llm.text">;
        if (text.role !== "assistant") {
          throw new Error(`openai_chat response lower: unexpected ${text.role} text in a response program`);
        }
        texts.push(text.content);
        break;
      }
      case "llm.tool_call":
        toolCalls.push(wireToolCall(op as OpOf<"llm.tool_call">));
        break;
      case "response.stop":
        out.push({
          op: "openai_chat.finish_reason",
          value: STOP_TO_FINISH_REASON[(op as OpOf<"response.stop">).reason],
        });
        break;
      case "response.usage": {
        const counts = op as OpOf<"response.usage">;
        out.push({
          op: "openai_chat.usage",
          usage: {
            ...(counts.inputTokens != null ? { prompt_tokens: counts.inputTokens } : {}),
            ...(counts.outputTokens != null ? { completion_tokens: counts.outputTokens } : {}),
          },
        });
        break;
      }
      default:
        out.push(op);
    }
  }

  const message: WireMessage = {
    role: "assistant",
    content: texts.length > 0 ? texts.join("\n") : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  out.push({ op: "openai_chat.message", message });
  return out;
}

function wireToolCall(op: { id: string; name: string; arguments: Record<string, unknown> }): WireToolCall {
  return {
    id: op.id,
    type: "function",
    function: { name: op.name, arguments: JSON.stringify(op.arguments) },
  };
}
