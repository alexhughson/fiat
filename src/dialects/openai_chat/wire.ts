// wire <-> lower IR for openai_chat. Mechanical flattening only: fields that
// rename 1:1 onto a core op become core ops here; everything else becomes an
// openai_chat.* op with its wire shape intact. No semantic mapping — that
// lives in raise.ts / lower.ts.

import { opData, type JsonSchema, type Op, type OpOf, type Program, type ToolChoice } from "../../core/ops";
import { firstOp } from "../../core/program";
import { LintError } from "../../core/pass";
import { asArray, asNumber, asRecord, asString } from "../../core/wire";
import type { WireMessage } from "./ops";

export function requestFromWire(wire: unknown): Program {
  const body = asRecord(wire, "openai_chat request body");
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
      case "max_completion_tokens":
        program.push({ op: "llm.max_output_tokens", value: asNumber(value, key) });
        break;
      case "messages":
        for (const m of asArray(value, "messages")) {
          program.push({ op: "openai_chat.message", message: asRecord(m, "message") as unknown as WireMessage });
        }
        break;
      case "tools":
        for (const t of asArray(value, "tools")) {
          program.push(toolFromWire(asRecord(t, "tool")));
        }
        break;
      case "tool_choice":
        program.push({ op: "llm.tool_choice", value: toolChoiceFromWire(value) });
        break;
      case "response_format":
        program.push(responseFormatFromWire(asRecord(value, "response_format")));
        break;
      default:
        program.push({ op: "openai_chat.param", key, value });
    }
  }
  if (!firstOp(program, "llm.model")) throw new Error("openai_chat request body: missing model");
  return program;
}

export function requestToWire(program: Program): unknown {
  const body: Record<string, unknown> = {};
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
      case "openai_chat.message":
        messages.push(op.message);
        break;
      case "llm.tool":
        tools.push({
          type: "function",
          function: { name: op.name, description: op.description, parameters: op.inputSchema },
        });
        break;
      case "llm.tool_choice":
        body.tool_choice = toolChoiceToWire((op as OpOf<"llm.tool_choice">).value);
        break;
      case "llm.output":
        body.response_format = {
          type: "json_schema",
          json_schema: { name: op.name, schema: op.schema },
        };
        break;
      case "openai_chat.param": {
        const param = opData<{ key: string; value: unknown }>(op);
        body[param.key] = param.value;
        break;
      }
      default:
        throw new LintError(`openai_chat request toWire: no serialization for op "${op.op}"`);
    }
  }
  if (messages.length > 0) body.messages = messages;
  if (tools.length > 0) body.tools = tools;
  if (!body.model) throw new Error("openai_chat request toWire: program has no llm.model op");
  return body;
}

export function responseFromWire(wire: unknown): Program {
  const body = asRecord(wire, "openai_chat response body");
  const program: Program = [];
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case "model":
        program.push({ op: "llm.model", model: asString(value, "model") });
        break;
      case "choices": {
        const choices = asArray(value, "choices");
        if (choices.length !== 1) {
          throw new Error(`openai_chat response: expected exactly 1 choice, got ${choices.length} (n > 1 is out of scope)`);
        }
        const choice = asRecord(choices[0], "choice");
        program.push({
          op: "openai_chat.message",
          message: asRecord(choice.message, "choice.message") as unknown as WireMessage,
        });
        if (choice.finish_reason != null) {
          program.push({ op: "openai_chat.finish_reason", value: asString(choice.finish_reason, "finish_reason") });
        }
        break;
      }
      case "usage":
        program.push({ op: "openai_chat.usage", usage: asRecord(value, "usage") });
        break;
      default:
        // Response envelope bookkeeping (id, object, created, ...). Dropping
        // it when the program is re-targeted is by design, so unlike request
        // params these are born droppable.
        program.push({ op: "openai_chat.param", key, value, required: false });
    }
  }
  return program;
}

export function responseToWire(program: Program): unknown {
  const body: Record<string, unknown> = {};
  let message: WireMessage | undefined;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const op of program) {
    switch (op.op) {
      case "llm.model":
        body.model = op.model;
        break;
      case "openai_chat.message":
        if (message) throw new Error("openai_chat response toWire: expected a single message op (lower merges assistant output)");
        message = op.message as WireMessage;
        break;
      case "openai_chat.finish_reason":
        finishReason = opData<{ value: string }>(op).value;
        break;
      // Multiple usage ops merge: lower emits the mapped counts, and a
      // { required: false } residual from raise may carry vendor detail.
      case "openai_chat.usage":
        usage = { ...usage, ...opData<{ usage: Record<string, unknown> }>(op).usage };
        break;
      case "openai_chat.param": {
        const param = opData<{ key: string; value: unknown }>(op);
        body[param.key] = param.value;
        break;
      }
      default:
        throw new LintError(`openai_chat response toWire: no serialization for op "${op.op}"`);
    }
  }
  if (!message) throw new Error("openai_chat response toWire: program has no message");
  if (usage) body.usage = usage;
  // Protocol boilerplate a synthesized response needs; param ops (id,
  // created, ...) from a real upstream response take precedence above.
  body.id ??= `chatcmpl-${crypto.randomUUID()}`;
  body.object ??= "chat.completion";
  body.created ??= Math.floor(Date.now() / 1000);
  body.choices = [{ index: 0, message, finish_reason: finishReason ?? null, logprobs: null }];
  return body;
}

function toolFromWire(tool: Record<string, unknown>): Op {
  if (tool.type !== "function") {
    throw new Error(`openai_chat tool: unsupported tool type ${JSON.stringify(tool.type)}`);
  }
  const fn = asRecord(tool.function, "tool.function");
  return {
    op: "llm.tool",
    name: asString(fn.name, "tool.function.name"),
    ...(fn.description != null ? { description: asString(fn.description, "tool.function.description") } : {}),
    inputSchema: (fn.parameters ?? {}) as JsonSchema,
  };
}

function toolChoiceFromWire(value: unknown): ToolChoice {
  if (value === "auto" || value === "none" || value === "required") return value;
  const choice = asRecord(value, "tool_choice");
  if (choice.type === "function") {
    const fn = asRecord(choice.function, "tool_choice.function");
    return { name: asString(fn.name, "tool_choice.function.name") };
  }
  throw new Error(`openai_chat tool_choice: unsupported value ${JSON.stringify(value)}`);
}

function toolChoiceToWire(value: ToolChoice): unknown {
  if (typeof value === "string") return value;
  return { type: "function", function: { name: value.name } };
}

function responseFormatFromWire(format: Record<string, unknown>): Op {
  if (format.type === "json_schema") {
    const spec = asRecord(format.json_schema, "response_format.json_schema");
    return {
      op: "llm.output",
      format: "json_schema",
      name: asString(spec.name, "response_format.json_schema.name"),
      schema: asRecord(spec.schema, "response_format.json_schema.schema"),
    };
  }
  // text / json_object have no core representation yet; carry as residual.
  return { op: "openai_chat.param", key: "response_format", value: format };
}
