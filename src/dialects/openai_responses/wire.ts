import {
    opData,
    type JsonSchema,
    type Op,
    type OpOf,
    type Program,
    type ServerToolKind,
    type ThinkingEffort,
    type ToolChoice,
} from "../../core/ops";
import { firstOp } from "../../core/program";
import { declaredToolsByName, type DeclaredTool } from "../../core/tools";
import { LintError } from "../../core/lint";
import { asArray, asNumber, asRecord, asString } from "../../core/wire";
import type { WireInputItem, WireOutputItem, WireTool } from "./ops";

const RESPONSE_ENVELOPE_PARAM_KEYS = new Set([
    "id",
    "object",
    "created_at",
    "status",
    "output",
    "usage",
    "incomplete_details",
    "error",
]);

const REASONING_ENCRYPTED_CONTENT = "reasoning.encrypted_content";

export function requestFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_responses request body");
    const program: Program = [];
    let pendingToolChoice: unknown;
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "instructions":
                if (value != null)
                    program.push({
                        op: "llm.text",
                        role: "system",
                        content: asString(value, "instructions"),
                    });
                break;
            case "temperature":
                program.push({
                    op: "llm.temperature",
                    value: asNumber(value, "temperature"),
                });
                break;
            case "max_output_tokens":
                program.push({
                    op: "llm.max_output_tokens",
                    value: asNumber(value, "max_output_tokens"),
                });
                break;
            case "reasoning": {
                const reasoning = asRecord(value, "reasoning");
                if (reasoning.effort != null) {
                    program.push({
                        op: "llm.thinking",
                        effort: asString(
                            reasoning.effort,
                            "reasoning.effort",
                        ) as ThinkingEffort,
                    });
                }
                break;
            }
            case "include":
                if (!isReasoningEncryptedContentInclude(value)) {
                    program.push({
                        op: "openai_responses.body_field",
                        key,
                        value,
                    });
                }
                break;
            case "input":
                program.push(...inputFromWire(value));
                break;
            case "tools":
                for (const tool of asArray(value, "tools"))
                    program.push(...toolFromWire(asRecord(tool, "tool")));
                break;
            case "tool_choice":
                pendingToolChoice = value;
                break;
            default:
                program.push({ op: "openai_responses.body_field", key, value });
        }
    }
    if (pendingToolChoice !== undefined) {
        program.push(
            ...toolChoiceFromWire(
                pendingToolChoice,
                declaredToolsByName(
                    program,
                    "openai_responses request fromWire",
                ),
            ),
        );
    }
    if (!firstOp(program, "llm.model"))
        throw new Error("openai_responses request body: missing model");
    return program;
}

export function requestToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const instructions: string[] = [];
    const input: unknown[] = [];
    const tools: unknown[] = [];
    const declaredTools = declaredToolsByName(
        program,
        "openai_responses request lower",
    );
    const functionToolsByName = new Map<string, Record<string, unknown>>();
    const pendingToolMeta = new Map<
        string,
        { fields: Record<string, unknown>; required: boolean }
    >();
    let toolChoice: ToolChoice | undefined;
    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "llm.temperature":
                body.temperature = op.value;
                break;
            case "llm.max_output_tokens":
                body.max_output_tokens = op.value;
                break;
            case "llm.thinking":
                body.reasoning = {
                    effort: (op as OpOf<"llm.thinking">).effort,
                    summary: "auto",
                };
                body.include = [REASONING_ENCRYPTED_CONTENT];
                break;
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role === "system") instructions.push(text.content);
                else input.push(messageItem(text.role, text.content));
                break;
            }
            case "llm.tool_call": {
                const call = op as OpOf<"llm.tool_call">;
                input.push({
                    type: "function_call",
                    call_id: call.id,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                });
                break;
            }
            case "llm.tool_result": {
                const result = op as OpOf<"llm.tool_result">;
                input.push({
                    type: "function_call_output",
                    call_id: result.id,
                    output: result.content,
                });
                break;
            }
            case "llm.tool": {
                const toolOp = op as OpOf<"llm.tool">;
                const tool: Record<string, unknown> = {
                    type: "function",
                    name: toolOp.name,
                    ...(toolOp.description != null
                        ? { description: toolOp.description }
                        : {}),
                    parameters: toolOp.inputSchema,
                };
                const pending = pendingToolMeta.get(toolOp.name);
                if (pending) {
                    Object.assign(tool, pending.fields);
                    pendingToolMeta.delete(toolOp.name);
                }
                tools.push(tool);
                functionToolsByName.set(toolOp.name, tool);
                break;
            }
            case "llm.server_tool": {
                const tool = serverToolToWire(op as OpOf<"llm.server_tool">);
                tools.push(tool);
                break;
            }
            case "openai_responses.tool_meta": {
                const meta = opData<{
                    name: string;
                    fields: Record<string, unknown>;
                    required?: boolean;
                }>(op);
                const tool = functionToolsByName.get(meta.name);
                if (tool) {
                    Object.assign(tool, meta.fields);
                } else {
                    const pending = pendingToolMeta.get(meta.name);
                    pendingToolMeta.set(meta.name, {
                        fields: { ...pending?.fields, ...meta.fields },
                        required: pending?.required ?? meta.required !== false,
                    });
                }
                break;
            }
            case "llm.tool_choice":
                toolChoice = (op as OpOf<"llm.tool_choice">).value;
                break;
            case "openai_responses.input":
                input.push(opData<{ item: WireInputItem }>(op).item);
                break;
            case "openai_responses.tool":
                tools.push(opData<{ tool: WireTool }>(op).tool);
                break;
            case "openai_responses.tool_choice":
                body.tool_choice = opData<{ value: unknown }>(op).value;
                break;
            case "openai_responses.body_field": {
                const param = opData<{
                    key: string;
                    value: unknown;
                    appliesTo?: "request" | "response";
                    required?: boolean;
                }>(op);
                if (skipRequestParam(param)) break;
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_responses request toWire: no serialization for op "${op.op}"`,
                );
        }
    }
    if (instructions.length > 0) body.instructions = instructions.join("\n\n");
    if (input.length > 0) body.input = input;
    if (tools.length > 0) body.tools = tools;
    if (toolChoice !== undefined) {
        body.tool_choice = toolChoiceToWire(
            toolChoice,
            declaredTools,
            "openai_responses request lower",
        );
    }
    const unconsumedToolMeta = [...pendingToolMeta.entries()].filter(
        ([, meta]) => meta.required,
    );
    if (unconsumedToolMeta.length > 0) {
        throw new LintError(
            `openai_responses request toWire: tool metadata for missing tool(s) ${unconsumedToolMeta
                .map(([name]) => JSON.stringify(name))
                .join(", ")}`,
        );
    }
    if (!body.model)
        throw new Error(
            "openai_responses request toWire: program has no llm.model op",
        );
    return body;
}

function isReasoningEncryptedContentInclude(value: unknown): boolean {
    return (
        Array.isArray(value) &&
        value.length === 1 &&
        value[0] === REASONING_ENCRYPTED_CONTENT
    );
}

export function responseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_responses response body");
    const program: Program = [];
    let hasFunctionCall = false;
    let status: string | undefined;
    let incompleteReason: string | undefined;
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "output":
                for (const item of asArray(value, "output")) {
                    const output = asRecord(
                        item,
                        "output item",
                    ) as unknown as WireOutputItem;
                    if (output.type === "function_call") hasFunctionCall = true;
                    program.push({
                        op: "openai_responses.output",
                        item: output,
                    });
                }
                break;
            case "usage":
                program.push({
                    op: "openai_responses.usage",
                    usage: asRecord(value, "usage"),
                    appliesTo: "response",
                });
                break;
            case "status":
                status = asString(value, "status");
                program.push({
                    op: "openai_responses.body_field",
                    key,
                    value,
                    appliesTo: "response",
                    required: false,
                });
                break;
            case "incomplete_details": {
                const details =
                    value == null
                        ? undefined
                        : asRecord(value, "incomplete_details");
                if (details?.reason != null)
                    incompleteReason = asString(
                        details.reason,
                        "incomplete_details.reason",
                    );
                program.push({
                    op: "openai_responses.body_field",
                    key,
                    value,
                    appliesTo: "response",
                    required: false,
                });
                break;
            }
            default:
                program.push({
                    op: "openai_responses.body_field",
                    key,
                    value,
                    appliesTo: "response",
                    required: false,
                });
        }
    }
    const reason = finishReason(status, incompleteReason, hasFunctionCall);
    if (reason) program.push({ op: "openai_responses.finish_reason", reason });
    return program;
}

export function responseToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const output: unknown[] = [];
    let usage: Record<string, unknown> | undefined;
    let finishReason: string | undefined;
    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "openai_responses.output":
                output.push(opData<{ item: WireOutputItem }>(op).item);
                break;
            case "openai_responses.finish_reason":
                finishReason = opData<{ reason: string }>(op).reason;
                break;
            case "openai_responses.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "openai_responses.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_responses response toWire: no serialization for op "${op.op}"`,
                );
        }
    }
    if (output.length === 0)
        throw new Error(
            "openai_responses response toWire: program has no output",
        );
    body.output = output;
    if (usage) body.usage = usage;
    body.id ??= `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    body.object ??= "response";
    body.created_at ??= Math.floor(Date.now() / 1000);
    body.status ??=
        finishReason === "max_tokens" || finishReason === "content_filter"
            ? "incomplete"
            : "completed";
    if (body.incomplete_details === undefined) {
        if (finishReason === "max_tokens")
            body.incomplete_details = { reason: "max_output_tokens" };
        if (finishReason === "content_filter")
            body.incomplete_details = { reason: "content_filter" };
    }
    return body;
}

export function streamResponseFromWire(wire: unknown): Program {
    const event = asRecord(wire, "openai_responses stream response event");
    const type = asString(event.type, "stream event.type");
    switch (type) {
        case "response.output_text.delta":
            return [
                ...streamEventParams(event, ["delta"]),
                {
                    op: "response.text_delta",
                    role: "assistant",
                    content: asString(event.delta, "stream event.delta"),
                },
            ];
        case "response.function_call_arguments.delta":
            return [
                ...streamEventParams(event, ["delta"]),
                {
                    op: "response.tool_call_delta",
                    ...(event.output_index != null
                        ? {
                              index: asNumber(
                                  event.output_index,
                                  "stream event.output_index",
                              ),
                          }
                        : {}),
                    arguments: asString(event.delta, "stream event.delta"),
                },
            ];
        case "response.output_item.added":
        case "response.output_item.done":
            return streamOutputItemEvent(event, type);
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
            return streamTerminalEvent(event);
        default:
            throw new LintError(
                `openai_responses stream response: unsupported event type ${JSON.stringify(type)}`,
            );
    }
}

export function streamResponseToWire(program: Program): unknown {
    let text = "";
    const toolDeltas: OpOf<"response.tool_call_delta">[] = [];
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    const event: Record<string, unknown> = {};
    let sawTextDelta = false;

    for (const op of program) {
        switch (op.op) {
            case "response.text_delta":
                sawTextDelta = true;
                text += (op as OpOf<"response.text_delta">).content;
                event.type ??= "response.output_text.delta";
                break;
            case "response.tool_call_delta":
                toolDeltas.push(op as OpOf<"response.tool_call_delta">);
                event.type ??= "response.function_call_arguments.delta";
                break;
            case "openai_responses.finish_reason":
                finishReason = opData<{ reason: string }>(op).reason;
                event.type ??= terminalEventType(finishReason);
                break;
            case "openai_responses.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                event.type ??= "response.completed";
                break;
            case "openai_responses.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                event[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_responses stream response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (sawTextDelta) {
        event.type ??= "response.output_text.delta";
        event.item_id ??= `msg_${crypto.randomUUID().replaceAll("-", "")}`;
        event.output_index ??= 0;
        event.content_index ??= 0;
        event.delta = text;
        return event;
    }
    if (toolDeltas.length > 0) {
        const tool = toolDeltas[0]!;
        if (tool.name != null || tool.id != null) {
            event.type ??= "response.output_item.added";
            event.output_index ??= tool.index ?? 0;
            const itemTemplate = asRecord(
                event.item ?? {},
                "stream event.item",
            );
            event.item = {
                ...itemTemplate,
                type: "function_call",
                id:
                    itemTemplate.id ??
                    event.item_id ??
                    `fc_${crypto.randomUUID().replaceAll("-", "")}`,
                call_id:
                    tool.id ??
                    itemTemplate.call_id ??
                    `call_${crypto.randomUUID().replaceAll("-", "")}`,
                name: tool.name ?? itemTemplate.name ?? "",
                arguments: tool.arguments ?? itemTemplate.arguments ?? "",
            };
            return event;
        }
        event.type ??= "response.function_call_arguments.delta";
        event.output_index ??= tool.index ?? 0;
        event.delta = tool.arguments ?? "";
        return event;
    }

    event.type ??= terminalEventType(finishReason);
    if (usage || finishReason != null) {
        const response = asRecord(
            event.response ?? {},
            "stream event.response",
        );
        response.status ??=
            finishReason === "max_tokens" || finishReason === "content_filter"
                ? "incomplete"
                : "completed";
        if (
            finishReason === "max_tokens" &&
            response.incomplete_details === undefined
        ) {
            response.incomplete_details = { reason: "max_output_tokens" };
        }
        if (
            finishReason === "content_filter" &&
            response.incomplete_details === undefined
        ) {
            response.incomplete_details = { reason: "content_filter" };
        }
        if (usage) response.usage = usage;
        event.response = response;
    }
    return event;
}

function inputFromWire(input: unknown): Program {
    if (typeof input === "string")
        return [{ op: "llm.text", role: "user", content: input }];
    return asArray(input, "input").map((item) => ({
        op: "openai_responses.input",
        item: asRecord(item, "input item") as unknown as WireInputItem,
    }));
}

function streamEventParams(
    event: Record<string, unknown>,
    skip: string[],
): Program {
    const skipped = new Set(skip);
    const program: Program = [];
    for (const [key, value] of Object.entries(event)) {
        if (skipped.has(key)) continue;
        program.push({
            op: "openai_responses.body_field",
            key,
            value,
            appliesTo: "response",
            required: false,
        });
    }
    return program;
}

function streamOutputItemEvent(
    event: Record<string, unknown>,
    type: string,
): Program {
    const program = streamEventParams(event, ["item"]);
    const item = asRecord(event.item, "stream event.item");
    program.push({
        op: "openai_responses.body_field",
        key: "item",
        value: item,
        appliesTo: "response",
        required: false,
    });
    if (item.type !== "function_call") return program;
    program.push({
        op: "response.tool_call_delta",
        ...(event.output_index != null
            ? {
                  index: asNumber(
                      event.output_index,
                      "stream event.output_index",
                  ),
              }
            : {}),
        ...(item.call_id != null
            ? { id: asString(item.call_id, "stream event.item.call_id") }
            : {}),
        ...(item.name != null
            ? { name: asString(item.name, "stream event.item.name") }
            : {}),
        ...(item.arguments != null && type === "response.output_item.done"
            ? {
                  arguments: asString(
                      item.arguments,
                      "stream event.item.arguments",
                  ),
              }
            : {}),
    });
    return program;
}

function streamTerminalEvent(event: Record<string, unknown>): Program {
    const program = streamEventParams(event, ["response"]);
    const isFailed = event.type === "response.failed";
    if (isFailed) {
        for (let i = 0; i < program.length; i++) {
            const op = program[i]!;
            if (
                op.op === "openai_responses.body_field" &&
                opData<{ key: string }>(op).key === "type"
            ) {
                program[i] = { ...op, required: true };
            }
        }
    }
    const response =
        event.response == null
            ? undefined
            : asRecord(event.response, "stream event.response");
    if (response != null) {
        const { usage: _usage, ...responseMeta } = response;
        if (Object.keys(responseMeta).length > 0) {
            program.push({
                op: "openai_responses.body_field",
                key: "response",
                value: responseMeta,
                appliesTo: "response",
                required: isFailed,
            });
        }
    }
    const status =
        response?.status == null
            ? undefined
            : asString(response.status, "stream event.response.status");
    const incompleteDetails =
        response?.incomplete_details == null
            ? undefined
            : asRecord(
                  response.incomplete_details,
                  "stream event.response.incomplete_details",
              );
    const incompleteReason =
        incompleteDetails?.reason == null
            ? undefined
            : asString(
                  incompleteDetails.reason,
                  "stream event.response.incomplete_details.reason",
              );
    const reason = finishReason(status, incompleteReason, false);
    if (reason) program.push({ op: "openai_responses.finish_reason", reason });
    if (response?.usage != null) {
        program.push({
            op: "openai_responses.usage",
            usage: asRecord(response.usage, "stream event.response.usage"),
            appliesTo: "response",
        });
    }
    return program;
}

function terminalEventType(finishReason: string | undefined): string {
    return finishReason === "max_tokens" || finishReason === "content_filter"
        ? "response.incomplete"
        : "response.completed";
}

function messageItem(role: "user" | "assistant", text: string): WireInputItem {
    return { type: "message", role, content: [{ type: "input_text", text }] };
}

function toolFromWire(tool: Record<string, unknown>): Op[] {
    const serverTool = serverToolFromWire(tool);
    if (serverTool) return [serverTool];
    if (tool.type !== "function") {
        return [
            {
                op: "openai_responses.tool",
                tool,
                appliesTo: "request",
            },
        ];
    }
    const name = asString(tool.name, "tool.name");
    const { type, name: _name, description, parameters, ...fields } = tool;
    const ops: Op[] = [
        {
            op: "llm.tool",
            name,
            ...(description != null
                ? { description: asString(description, "tool.description") }
                : {}),
            inputSchema: (parameters ?? {}) as JsonSchema,
        },
    ];
    if (Object.keys(fields).length > 0) {
        ops.push({
            op: "openai_responses.tool_meta",
            name,
            fields,
            appliesTo: "request",
        });
    }
    return ops;
}

function toolChoiceFromWire(
    value: unknown,
    toolsByName: Map<string, DeclaredTool>,
): Op[] {
    if (value === "auto" || value === "none" || value === "required")
        return [{ op: "llm.tool_choice", value }];
    const choice = asRecord(value, "tool_choice");
    if (choice.type === "function")
        return [
            {
                op: "llm.tool_choice",
                value: { name: asString(choice.name, "tool_choice.name") },
            },
        ];
    if (choice.type === "web_search_preview") {
        return toolsByName.get("web_search")?.type === "server"
            ? [{ op: "llm.tool_choice", value: { name: "web_search" } }]
            : [{ op: "openai_responses.tool_choice", value }];
    }
    if (choice.type === "code_interpreter") {
        return toolsByName.get("code_execution")?.type === "server"
            ? [{ op: "llm.tool_choice", value: { name: "code_execution" } }]
            : [{ op: "openai_responses.tool_choice", value }];
    }
    return [
        {
            op: "openai_responses.tool_choice",
            value,
        },
    ];
}

function toolChoiceToWire(
    value: ToolChoice,
    toolsByName: Map<string, DeclaredTool>,
    context: string,
): unknown {
    if (typeof value === "string") return value;
    const tool = toolsByName.get(value.name);
    if (!tool) {
        throw new LintError(
            `${context}: tool_choice references undeclared tool ${JSON.stringify(value.name)}`,
        );
    }
    if (tool.type === "function") return { type: "function", name: value.name };
    return { type: openAIServerToolType(tool.kind) };
}

function serverToolFromWire(tool: Record<string, unknown>): Op | undefined {
    const kind = serverToolKindFromOpenAIType(tool.type);
    if (!kind) return undefined;
    const { type, ...fields } = tool;
    if (Object.keys(fields).length > 0) return undefined;
    return {
        op: "llm.server_tool",
        name: defaultServerToolName(kind),
        kind,
    };
}

function serverToolToWire(op: OpOf<"llm.server_tool">): WireTool {
    const expectedName = defaultServerToolName(op.kind);
    if (op.name !== expectedName) {
        throw new LintError(
            `openai_responses server tool ${op.kind}: expected canonical name ${JSON.stringify(expectedName)}, got ${JSON.stringify(op.name)}`,
        );
    }
    return { type: openAIServerToolType(op.kind) };
}

function serverToolKindFromOpenAIType(
    type: unknown,
): ServerToolKind | undefined {
    switch (type) {
        case "web_search_preview":
            return "web_search";
        case "code_interpreter":
            return "code_execution";
        default:
            return undefined;
    }
}

function defaultServerToolName(kind: ServerToolKind): string {
    switch (kind) {
        case "web_search":
            return "web_search";
        case "code_execution":
            return "code_execution";
    }
}

function openAIServerToolType(kind: ServerToolKind): string {
    switch (kind) {
        case "web_search":
            return "web_search_preview";
        case "code_execution":
            return "code_interpreter";
    }
}

function finishReason(
    status: string | undefined,
    incompleteReason: string | undefined,
    hasFunctionCall: boolean,
) {
    if (hasFunctionCall) return "tool_use";
    if (status === "incomplete" && incompleteReason === "max_output_tokens")
        return "max_tokens";
    if (status === "incomplete" && incompleteReason === "content_filter")
        return "content_filter";
    if (status === "incomplete") {
        throw new LintError(
            `openai_responses incomplete reason ${JSON.stringify(incompleteReason)} has no core stop reason mapping`,
        );
    }
    if (status === "completed") return "end_turn";
    return undefined;
}

function skipRequestParam(param: {
    key: string;
    appliesTo?: "request" | "response";
    required?: boolean;
}): boolean {
    if (param.appliesTo === "response") return true;
    return (
        param.required === false && RESPONSE_ENVELOPE_PARAM_KEYS.has(param.key)
    );
}
