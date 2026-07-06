// wire <-> lower IR for openai_chat. Mechanical flattening only: fields that
// rename 1:1 onto a core op become core ops here; everything else becomes an
// openai_chat.* op with its wire shape intact. No semantic mapping — that
// lives in raise.ts / lower.ts.

import {
    opData,
    type JsonSchema,
    type Op,
    type OpOf,
    type Program,
    type ThinkingEffort,
    type ToolChoice,
} from "../../core/ops";
import { firstOp } from "../../core/program";
import { LintError } from "../../core/lint";
import {
    asArray,
    asBoolean,
    asNumber,
    asRecord,
    asString,
    asStringArray,
    asThinkingEffort,
} from "../../core/wire";
import type { WireMessage } from "./ops";

const RESPONSE_ENVELOPE_PARAM_KEYS = new Set([
    "id",
    "object",
    "created",
    "choices",
    "usage",
    "system_fingerprint",
]);

export function requestFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_chat request body");
    const program: Program = [];
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "temperature":
                program.push({
                    op: "llm.temperature",
                    value: asNumber(value, "temperature"),
                });
                break;
            case "max_tokens":
            case "max_completion_tokens":
                program.push({
                    op: "llm.max_output_tokens",
                    value: asNumber(value, key),
                });
                break;
            case "user":
                program.push({
                    op: "request.user",
                    value: asString(value, "user"),
                });
                break;
            case "stream":
                program.push({
                    op: "request.stream",
                    value: asBoolean(value, "stream"),
                });
                break;
            case "n":
                program.push({
                    op: "openai_chat.choice_count",
                    value: asNumber(value, "n"),
                });
                break;
            case "stop":
                program.push({
                    op: "request.stop_sequences",
                    value:
                        typeof value === "string"
                            ? [value]
                            : asStringArray(value, "stop"),
                });
                break;
            case "reasoning_effort":
                program.push({
                    op: "llm.thinking",
                    effort: asThinkingEffort(value, "reasoning_effort"),
                });
                break;
            case "messages":
                for (const m of asArray(value, "messages")) {
                    program.push({
                        op: "openai_chat.message",
                        message: asRecord(
                            m,
                            "message",
                        ) as unknown as WireMessage,
                    });
                }
                break;
            case "tools":
                for (const t of asArray(value, "tools")) {
                    program.push(toolFromWire(asRecord(t, "tool")));
                }
                break;
            case "tool_choice":
                program.push({
                    op: "llm.tool_choice",
                    value: toolChoiceFromWire(value),
                });
                break;
            case "response_format":
                program.push(
                    ...responseFormatFromWire(
                        asRecord(value, "response_format"),
                    ),
                );
                break;
            default:
                program.push({ op: "openai_chat.body_field", key, value });
        }
    }
    if (!firstOp(program, "llm.model"))
        throw new Error("openai_chat request body: missing model");
    return program;
}

export function requestToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const messages: unknown[] = [];
    const tools: unknown[] = [];
    let hasToolHistory = false;
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
            case "openai_chat.max_completion_tokens":
                body.max_completion_tokens = opData<{ value: number }>(
                    op,
                ).value;
                break;
            case "request.user":
                body.user = op.value;
                break;
            case "request.stream":
                body.stream = op.value;
                break;
            case "request.stop_sequences":
                body.stop = op.value;
                break;
            case "llm.thinking":
                body.reasoning_effort = openAIReasoningEffort(
                    (op as OpOf<"llm.thinking">).effort,
                );
                break;
            case "openai_chat.message":
                messages.push(op.message);
                if (messageHasToolHistory(op.message as WireMessage)) {
                    hasToolHistory = true;
                }
                break;
            case "llm.tool":
                tools.push({
                    type: "function",
                    function: {
                        name: op.name,
                        description: op.description,
                        parameters: op.inputSchema,
                    },
                });
                break;
            case "llm.tool_choice":
                body.tool_choice = toolChoiceToWire(
                    (op as OpOf<"llm.tool_choice">).value,
                );
                break;
            case "llm.output":
                body.response_format = {
                    type: "json_schema",
                    json_schema: { name: op.name, schema: op.schema },
                };
                break;
            case "openai_chat.response_format":
                body.response_format = opData<{
                    value: Record<string, unknown>;
                }>(op).value;
                break;
            case "openai_chat.choice_count":
                body.n = opData<{ value: number }>(op).value;
                break;
            case "openai_chat.body_field": {
                const param = opData<{
                    key: string;
                    value: unknown;
                    appliesTo?: "request" | "response";
                }>(op);
                if (skipRequestParam(param)) break;
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_chat request toWire: no serialization for op "${op.op}"`,
                );
        }
    }
    if (messages.length > 0) body.messages = messages;
    if (tools.length > 0 || hasToolHistory) body.tools = tools;
    if (!body.model)
        throw new Error(
            "openai_chat request toWire: program has no llm.model op",
        );
    return body;
}

function messageHasToolHistory(message: WireMessage): boolean {
    return message.role === "tool" || (message.tool_calls?.length ?? 0) > 0;
}

export function responseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_chat response body");
    const program: Program = [];
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "choices": {
                const choices = asArray(value, "choices");
                if (choices.length !== 1) {
                    throw new Error(
                        `openai_chat response: expected exactly 1 choice, got ${choices.length} (n > 1 is out of scope)`,
                    );
                }
                const choice = asRecord(choices[0], "choice");
                program.push({
                    op: "openai_chat.message",
                    message: asRecord(
                        choice.message,
                        "choice.message",
                    ) as unknown as WireMessage,
                });
                if (choice.finish_reason != null) {
                    program.push({
                        op: "openai_chat.finish_reason",
                        value: asString(choice.finish_reason, "finish_reason"),
                    });
                }
                break;
            }
            case "usage":
                program.push({
                    op: "openai_chat.usage",
                    usage: asRecord(value, "usage"),
                    appliesTo: "response",
                });
                break;
            default:
                program.push({
                    op: "openai_chat.body_field",
                    key,
                    value,
                    appliesTo: "response",
                });
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
                if (message)
                    throw new Error(
                        "openai_chat response toWire: expected a single message op (lower merges assistant output)",
                    );
                message = op.message as WireMessage;
                break;
            case "openai_chat.finish_reason":
                finishReason = opData<{ value: string }>(op).value;
                break;
            // Multiple usage ops merge: lower emits the mapped counts, and a
            // Response usage residuals from raise may carry vendor detail.
            case "openai_chat.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "openai_chat.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_chat response toWire: no serialization for op "${op.op}"`,
                );
        }
    }
    if (!message)
        throw new Error("openai_chat response toWire: program has no message");
    if (usage) body.usage = usage;
    // Protocol boilerplate a synthesized response needs; param ops (id,
    // created, ...) from a real upstream response take precedence above.
    body.id ??= `chatcmpl-${crypto.randomUUID()}`;
    body.object ??= "chat.completion";
    body.created ??= Math.floor(Date.now() / 1000);
    body.choices = [
        {
            index: 0,
            message,
            finish_reason: finishReason ?? null,
            logprobs: null,
        },
    ];
    return body;
}

export function streamResponseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_chat stream response chunk");
    const program: Program = [];
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "choices":
                program.push(...streamChoicesFromWire(value));
                break;
            case "usage":
                if (value != null) {
                    program.push({
                        op: "openai_chat.usage",
                        usage: asRecord(value, "usage"),
                        appliesTo: "response",
                    });
                }
                break;
            default:
                program.push({
                    op: "openai_chat.body_field",
                    key,
                    value,
                    appliesTo: "response",
                });
        }
    }
    return program;
}

export function streamResponseToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const delta: Record<string, unknown> = {};
    const toolCalls: unknown[] = [];
    const choice: Record<string, unknown> = {};
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "response.text_delta": {
                const text = op as OpOf<"response.text_delta">;
                delta.role ??= text.role ?? "assistant";
                delta.content = `${String(delta.content ?? "")}${text.content}`;
                break;
            }
            case "response.tool_call_delta": {
                const tool = op as OpOf<"response.tool_call_delta">;
                const functionDelta: Record<string, unknown> = {};
                if (tool.name != null) functionDelta.name = tool.name;
                if (tool.arguments != null)
                    functionDelta.arguments = tool.arguments;
                toolCalls.push({
                    index: tool.index ?? toolCalls.length,
                    ...(tool.id != null ? { id: tool.id } : {}),
                    type: "function",
                    function: functionDelta,
                });
                break;
            }
            case "openai_chat.finish_reason":
                finishReason = opData<{ value: string }>(op).value;
                break;
            case "openai_chat.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "openai_chat.stream_choice_param": {
                const param = opData<{ key: string; value: unknown }>(op);
                choice[param.key] = param.value;
                break;
            }
            case "openai_chat.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_chat stream response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (toolCalls.length > 0) delta.tool_calls = toolCalls;
    if (usage) body.usage = usage;
    body.id ??= `chatcmpl-${crypto.randomUUID()}`;
    body.object ??= "chat.completion.chunk";
    body.created ??= Math.floor(Date.now() / 1000);
    if (
        Object.keys(delta).length === 0 &&
        finishReason == null &&
        usage != null
    ) {
        body.choices = [];
    } else {
        const choiceBody: Record<string, unknown> = {
            index: 0,
            ...choice,
            delta,
            finish_reason: finishReason ?? null,
        };
        if (!Object.hasOwn(choiceBody, "logprobs")) choiceBody.logprobs = null;
        body.choices = [choiceBody];
    }
    return body;
}

function skipRequestParam(param: {
    key: string;
    appliesTo?: "request" | "response";
}): boolean {
    return (
        param.appliesTo === "response" ||
        RESPONSE_ENVELOPE_PARAM_KEYS.has(param.key)
    );
}

function toolFromWire(tool: Record<string, unknown>): Op {
    if (tool.type !== "function") {
        throw new Error(
            `openai_chat tool: unsupported tool type ${JSON.stringify(tool.type)}`,
        );
    }
    const fn = asRecord(tool.function, "tool.function");
    return {
        op: "llm.tool",
        name: asString(fn.name, "tool.function.name"),
        ...(fn.description != null
            ? {
                  description: asString(
                      fn.description,
                      "tool.function.description",
                  ),
              }
            : {}),
        inputSchema: (fn.parameters ?? {}) as JsonSchema,
    };
}

function toolChoiceFromWire(value: unknown): ToolChoice {
    if (value === "auto" || value === "none" || value === "required")
        return value;
    const choice = asRecord(value, "tool_choice");
    if (choice.type === "function") {
        const fn = asRecord(choice.function, "tool_choice.function");
        return { name: asString(fn.name, "tool_choice.function.name") };
    }
    throw new Error(
        `openai_chat tool_choice: unsupported value ${JSON.stringify(value)}`,
    );
}

function toolChoiceToWire(value: ToolChoice): unknown {
    if (typeof value === "string") return value;
    return { type: "function", function: { name: value.name } };
}

function responseFormatFromWire(format: Record<string, unknown>): Op[] {
    if (format.type === "json_schema") {
        const spec = asRecord(
            format.json_schema,
            "response_format.json_schema",
        );
        const { name, schema, ...rest } = spec;
        return [
            {
                op: "llm.output",
                format: "json_schema",
                name: asString(name, "response_format.json_schema.name"),
                schema: asRecord(schema, "response_format.json_schema.schema"),
            },
            ...(Object.keys(rest).length > 0
                ? [
                      {
                          op: "openai_chat.response_format",
                          value: format,
                      } as Op,
                  ]
                : []),
        ];
    }
    // text / json_object have no core representation yet; carry as residual.
    return [{ op: "openai_chat.response_format", value: format }];
}

function openAIReasoningEffort(effort: ThinkingEffort): string {
    switch (effort) {
        case "low":
        case "medium":
        case "high":
        case "xhigh":
            return effort;
        case "max":
            throw new LintError(
                'openai_chat request toWire: reasoning_effort does not support llm.thinking effort "max"',
            );
    }
}

function streamChoicesFromWire(value: unknown): Program {
    const choices = asArray(value, "choices");
    if (choices.length > 1) {
        throw new Error(
            `openai_chat stream response: expected 0 or 1 choice, got ${choices.length} (n > 1 is out of scope)`,
        );
    }
    if (choices.length === 0) return [];
    const choice = asRecord(choices[0], "choice");
    const program: Program = [];
    for (const [key, field] of Object.entries(choice)) {
        if (key === "delta" || key === "finish_reason") continue;
        program.push({
            op: "openai_chat.stream_choice_param",
            key,
            value: field,
            appliesTo: "response",
        });
    }
    const delta = asRecord(choice.delta ?? {}, "choice.delta");
    if (delta.role != null || delta.content != null) {
        program.push({
            op: "response.text_delta",
            ...(delta.role != null
                ? { role: asString(delta.role, "choice.delta.role") }
                : {}),
            content:
                delta.content == null
                    ? ""
                    : asString(delta.content, "choice.delta.content"),
        });
    }
    if (delta.tool_calls != null) {
        for (const rawCall of asArray(
            delta.tool_calls,
            "choice.delta.tool_calls",
        )) {
            const call = asRecord(rawCall, "choice.delta.tool_call");
            if (call.type != null && call.type !== "function") {
                throw new LintError(
                    `openai_chat stream tool call: unsupported type ${JSON.stringify(call.type)}`,
                );
            }
            const fn = asRecord(call.function ?? {}, "tool_call.function");
            program.push({
                op: "response.tool_call_delta",
                ...(call.index != null
                    ? { index: asNumber(call.index, "tool_call.index") }
                    : {}),
                ...(call.id != null
                    ? { id: asString(call.id, "tool_call.id") }
                    : {}),
                ...(fn.name != null
                    ? { name: asString(fn.name, "tool_call.function.name") }
                    : {}),
                ...(fn.arguments != null
                    ? {
                          arguments: asString(
                              fn.arguments,
                              "tool_call.function.arguments",
                          ),
                      }
                    : {}),
            });
        }
    }
    if (choice.finish_reason != null) {
        program.push({
            op: "openai_chat.finish_reason",
            value: asString(choice.finish_reason, "finish_reason"),
        });
    }
    return program;
}
