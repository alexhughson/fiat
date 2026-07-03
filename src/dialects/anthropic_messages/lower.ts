// core IR -> lower IR. The wire requires user/assistant turns to alternate,
// so lowering merges consecutive same-role content into one message's block
// list (tool results are user-role blocks). System text stays a core op —
// requestToWire serializes it into the top-level system string.

import type { OpOf, Program } from "../../core/ops";
import { LintError } from "../../core/pass";
import type { WireAnthropicMessage, WireBlock } from "./ops";

export function lowerRequest(program: Program): Program {
  const out: Program = [];
  let openMessage: WireAnthropicMessage | undefined;

  const appendBlock = (role: "user" | "assistant", block: WireBlock) => {
    if (!openMessage || openMessage.role !== role) {
      if (openMessage) out.push({ op: "anthropic_messages.message", message: openMessage });
      openMessage = { role, content: [] };
    }
    (openMessage.content as WireBlock[]).push(block);
  };
  const flush = () => {
    if (openMessage) {
      out.push({ op: "anthropic_messages.message", message: openMessage });
      openMessage = undefined;
    }
  };

  for (const op of program) {
    switch (op.op) {
      case "llm.text": {
        const text = op as OpOf<"llm.text">;
        if (text.role === "system") {
          flush();
          out.push(op);
        } else {
          appendBlock(text.role, { type: "text", text: text.content });
        }
        break;
      }
      case "llm.tool_call": {
        const call = op as OpOf<"llm.tool_call">;
        appendBlock("assistant", { type: "tool_use", id: call.id, name: call.name, input: call.arguments });
        break;
      }
      case "llm.tool_result": {
        const result = op as OpOf<"llm.tool_result">;
        appendBlock("user", {
          type: "tool_result",
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
        break;
      }
      case "llm.output":
        throw new LintError(
          "anthropic_messages has no structured-output equivalent of llm.output — " +
            "map it with a core-IR pass (e.g. rewrite to a forced tool) or remove it",
        );
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
  const blocks: WireBlock[] = [];

  for (const op of program) {
    switch (op.op) {
      case "llm.text": {
        const text = op as OpOf<"llm.text">;
        if (text.role !== "assistant") {
          throw new Error(`anthropic_messages response lower: unexpected ${text.role} text in a response program`);
        }
        blocks.push({ type: "text", text: text.content });
        break;
      }
      case "llm.tool_call": {
        const call = op as OpOf<"llm.tool_call">;
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
        break;
      }
      case "response.stop":
        // Core stop reasons are a subset of Anthropic's wire enum, same names.
        out.push({ op: "anthropic_messages.stop_reason", value: (op as OpOf<"response.stop">).reason });
        break;
      case "response.usage": {
        const counts = op as OpOf<"response.usage">;
        out.push({
          op: "anthropic_messages.usage",
          usage: {
            ...(counts.inputTokens != null ? { input_tokens: counts.inputTokens } : {}),
            ...(counts.outputTokens != null ? { output_tokens: counts.outputTokens } : {}),
          },
        });
        break;
      }
      default:
        out.push(op);
    }
  }

  out.push({
    op: "anthropic_messages.message",
    message: { role: "assistant", content: blocks },
  });
  return out;
}
