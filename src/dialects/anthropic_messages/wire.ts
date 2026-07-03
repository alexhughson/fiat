// wire <-> lower IR for anthropic_messages. Mechanical flattening only.

import { opData, type JsonSchema, type Op, type OpOf, type Program, type ToolChoice } from "../../core/ops";
import { firstOp } from "../../core/program";
import { LintError } from "../../core/pass";
import { asArray, asNumber, asRecord, asString } from "../../core/wire";
import type { WireAnthropicMessage } from "./ops";

export function requestFromWire(wire: unknown): Program {
  const body = asRecord(wire, "anthropic_messages request body");
  const program: Program = [];
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case "model":
        program.push({ op: "llm.model", model: asString(value, "model") });
        break;
      case "temperature":
        program.push({ op: "llm.temperature", value: asNumber(value, "temperature") });
        break;
      case "max_tokens":
        program.push({ op: "llm.max_output_tokens", value: asNumber(value, "max_tokens") });
        break;
      case "system":
        program.push(...systemFromWire(value));
        break;
      case "messages":
        for (const m of asArray(value, "messages")) {
          program.push({
            op: "anthropic_messages.message",
            message: asRecord(m, "message") as unknown as WireAnthropicMessage,
          });
        }
        break;
      case "tools":
        for (const t of asArray(value, "tools")) {
          const tool = asRecord(t, "tool");
          program.push({
            op: "llm.tool",
            name: asString(tool.name, "tool.name"),
            ...(tool.description != null ? { description: asString(tool.description, "tool.description") } : {}),
            inputSchema: (tool.input_schema ?? {}) as JsonSchema,
          });
        }
        break;
      case "tool_choice":
        program.push({ op: "llm.tool_choice", value: toolChoiceFromWire(asRecord(value, "tool_choice")) });
        break;
      default:
        program.push({ op: "anthropic_messages.param", key, value });
    }
  }
  if (!firstOp(program, "llm.model")) throw new Error("anthropic_messages request body: missing model");
  return program;
}

export function requestToWire(program: Program): unknown {
  const body: Record<string, unknown> = {};
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  const tools: unknown[] = [];
  for (const op of program) {
    switch (op.op) {
      case "llm.model":
        body.model = op.model;
        break;
      case "llm.temperature":
        body.temperature = op.value;
        break;
      case "llm.max_output_tokens":
        body.max_tokens = op.value;
        break;
      case "llm.text":
        // Lowering turns user/assistant text into message ops; only system
        // text remains a core op, because the wire has no system message —
        // just the top-level system string.
        if (op.role !== "system") {
          throw new LintError(`anthropic_messages request toWire: unlowered llm.text with role "${op.role}"`);
        }
        systemParts.push((op as OpOf<"llm.text">).content);
        break;
      case "anthropic_messages.message":
        messages.push(op.message);
        break;
      case "llm.tool":
        tools.push({
          name: op.name,
          ...(op.description != null ? { description: op.description } : {}),
          input_schema: op.inputSchema,
        });
        break;
      case "llm.tool_choice":
        body.tool_choice = toolChoiceToWire((op as OpOf<"llm.tool_choice">).value);
        break;
      case "anthropic_messages.param": {
        const param = opData<{ key: string; value: unknown }>(op);
        body[param.key] = param.value;
        break;
      }
      default:
        throw new LintError(`anthropic_messages request toWire: no serialization for op "${op.op}"`);
    }
  }
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  body.messages = messages;
  if (tools.length > 0) body.tools = tools;
  if (!body.model) throw new Error("anthropic_messages request toWire: program has no llm.model op");
  if (body.max_tokens == null) {
    throw new Error(
      "anthropic_messages request toWire: max_tokens is required by the API — " +
        "set llm.max_output_tokens or enable the default-max-tokens legalization",
    );
  }
  return body;
}

export function responseFromWire(wire: unknown): Program {
  const body = asRecord(wire, "anthropic_messages response body");
  const program: Program = [];
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case "model":
        program.push({ op: "llm.model", model: asString(value, "model") });
        break;
      case "role":
      case "content":
        // Handled together below via role+content; skip here.
        break;
      case "stop_reason":
        if (value != null) {
          program.push({ op: "anthropic_messages.stop_reason", value: asString(value, "stop_reason") });
        }
        break;
      case "usage":
        program.push({ op: "anthropic_messages.usage", usage: asRecord(value, "usage") });
        break;
      default:
        // Response envelope bookkeeping (id, type, stop_sequence, ...) is
        // born droppable — see the openai_chat note.
        program.push({ op: "anthropic_messages.param", key, value, required: false });
    }
  }
  program.unshift({
    op: "anthropic_messages.message",
    message: {
      role: asString(body.role ?? "assistant", "role") as "assistant",
      content: asArray(body.content, "content") as WireAnthropicMessage["content"],
    },
  });
  return program;
}

export function responseToWire(program: Program): unknown {
  const body: Record<string, unknown> = {};
  let message: WireAnthropicMessage | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const op of program) {
    switch (op.op) {
      case "llm.model":
        body.model = op.model;
        break;
      case "anthropic_messages.message":
        if (message) throw new Error("anthropic_messages response toWire: expected a single message op");
        message = op.message as WireAnthropicMessage;
        break;
      case "anthropic_messages.stop_reason":
        body.stop_reason = opData<{ value: string }>(op).value;
        break;
      // Mapped counts from lower plus any { required: false } vendor detail
      // residual merge into one wire usage object.
      case "anthropic_messages.usage":
        usage = { ...usage, ...opData<{ usage: Record<string, unknown> }>(op).usage };
        break;
      case "anthropic_messages.param": {
        const param = opData<{ key: string; value: unknown }>(op);
        body[param.key] = param.value;
        break;
      }
      default:
        throw new LintError(`anthropic_messages response toWire: no serialization for op "${op.op}"`);
    }
  }
  if (!message) throw new Error("anthropic_messages response toWire: program has no message");
  if (usage) body.usage = usage;
  body.id ??= `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  body.type ??= "message";
  body.role = message.role;
  body.content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  body.stop_reason ??= null;
  return body;
}

function systemFromWire(value: unknown): Op[] {
  if (typeof value === "string") {
    return [{ op: "llm.text", role: "system", content: value }];
  }
  return asArray(value, "system").map((block) => {
    const b = asRecord(block, "system block");
    if (b.type !== "text") {
      throw new LintError(`anthropic_messages system: unsupported block type ${JSON.stringify(b.type)}`);
    }
    return { op: "llm.text", role: "system", content: asString(b.text, "system block text") };
  });
}

function toolChoiceFromWire(choice: Record<string, unknown>): ToolChoice {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { name: asString(choice.name, "tool_choice.name") };
    default:
      throw new Error(`anthropic_messages tool_choice: unsupported type ${JSON.stringify(choice.type)}`);
  }
}

function toolChoiceToWire(value: ToolChoice): unknown {
  if (typeof value !== "string") return { type: "tool", name: value.name };
  switch (value) {
    case "auto":
      return { type: "auto" };
    case "required":
      return { type: "any" };
    case "none":
      return { type: "none" };
  }
}
