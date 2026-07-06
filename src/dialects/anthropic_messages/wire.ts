// wire <-> lower IR for anthropic_messages. Mechanical flattening only.

import {
    opData,
    type JsonSchema,
    type Op,
    type OpOf,
    type Program,
    type ServerToolKind,
    type ToolChoice,
} from "../../core/ops.js";
import { firstOp } from "../../core/program.js";
import { declaredToolsByName, type DeclaredTool } from "../../core/tools.js";
import { LintError } from "../../core/lint.js";
import {
    asArray,
    asBoolean,
    asNumber,
    asRecord,
    asString,
} from "../../core/wire.js";
import type {
    WireAnthropicMessage,
    WireAnthropicStreamEvent,
    WireAnthropicTool,
    WireBlock,
} from "./ops.js";

export function requestFromWire(wire: unknown): Program {
    const body = asRecord(wire, "anthropic_messages request body");
    const program: Program = [];
    const seen = new Set<string>();
    const emit = (key: string, value: unknown) => {
        seen.add(key);
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
            case "top_p":
            case "top_k":
                program.push({
                    op: "anthropic_messages.sampling",
                    key,
                    value: asNumber(value, key),
                });
                break;
            case "max_tokens":
                program.push({
                    op: "llm.max_output_tokens",
                    value: asNumber(value, "max_tokens"),
                });
                break;
            case "system":
                program.push(...systemFromWire(value));
                break;
            case "messages":
                for (const m of asArray(value, "messages")) {
                    program.push({
                        op: "anthropic_messages.message",
                        message: asRecord(
                            m,
                            "message",
                        ) as unknown as WireAnthropicMessage,
                    });
                }
                break;
            case "tools":
                for (const t of asArray(value, "tools")) {
                    const tool = asRecord(t, "tool");
                    program.push(...toolFromWire(tool));
                }
                break;
            case "tool_choice":
                program.push({
                    op: "llm.tool_choice",
                    value: toolChoiceFromWire(asRecord(value, "tool_choice")),
                });
                break;
            case "stream":
                program.push({
                    op: "request.stream",
                    value: asBoolean(value, "stream"),
                });
                break;
            case "stop_sequences":
                program.push({
                    op: "request.stop_sequences",
                    value: asArray(value, "stop_sequences").map((item) =>
                        asString(item, "stop_sequences[]"),
                    ),
                });
                break;
            case "metadata":
                program.push({
                    op: "anthropic_messages.metadata",
                    value: asRecord(value, "metadata"),
                });
                break;
            case "thinking":
                program.push({
                    op: "anthropic_messages.thinking_config",
                    value: asRecord(value, "thinking"),
                });
                break;
            case "output_config":
                program.push({
                    op: "anthropic_messages.output_config",
                    value: asRecord(value, "output_config"),
                });
                break;
            case "context_management":
                program.push({
                    op: "anthropic_messages.context_management",
                    value: asRecord(value, "context_management"),
                });
                break;
            default:
                program.push({
                    op: "anthropic_messages.body_field",
                    key,
                    value,
                });
        }
    };

    for (const key of [
        "model",
        "temperature",
        "top_p",
        "top_k",
        "max_tokens",
        "system",
        "messages",
        "tools",
        "tool_choice",
        "stream",
        "stop_sequences",
        "metadata",
        "thinking",
        "output_config",
        "context_management",
    ]) {
        if (Object.hasOwn(body, key)) emit(key, body[key]);
    }
    for (const [key, value] of Object.entries(body)) {
        if (!seen.has(key)) emit(key, value);
    }
    if (!firstOp(program, "llm.model"))
        throw new Error("anthropic_messages request body: missing model");
    return program;
}

export function requestToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const systemParts: string[] = [];
    const systemBlocks: WireBlock[] = [];
    let hasComplexSystem = false;
    const messages: unknown[] = [];
    const tools: WireAnthropicTool[] = [];
    const declaredTools = declaredToolsByName(
        program,
        "anthropic_messages request lower",
    );
    const residualToolNames = new Set<string>();
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
            case "request.user":
                mergeMetadata(body, { user_id: op.value });
                break;
            case "request.stream":
                body.stream = op.value;
                break;
            case "request.stop_sequences":
                body.stop_sequences = op.value;
                break;
            case "llm.text":
                // Lowering turns user/assistant text into message ops; only system
                // text remains a core op, because the wire has no system message —
                // just the top-level system string.
                if (op.role !== "system") {
                    throw new LintError(
                        `anthropic_messages request toWire: unlowered llm.text with role "${op.role}"`,
                    );
                }
                systemParts.push((op as OpOf<"llm.text">).content);
                systemBlocks.push({
                    type: "text",
                    text: (op as OpOf<"llm.text">).content,
                });
                break;
            case "anthropic_messages.system_block":
                hasComplexSystem = true;
                systemBlocks.push(opData<{ block: WireBlock }>(op).block);
                break;
            case "anthropic_messages.message":
                messages.push(op.message);
                break;
            case "llm.tool":
                {
                    const tool = op as OpOf<"llm.tool">;
                    upsertTool(tools, {
                        name: tool.name,
                        ...(tool.description != null
                            ? { description: tool.description }
                            : {}),
                        input_schema: tool.inputSchema,
                    });
                }
                break;
            case "llm.server_tool": {
                tools.push(serverToolToWire(op as OpOf<"llm.server_tool">));
                break;
            }
            case "anthropic_messages.tool":
                {
                    const tool = opData<{ tool: WireAnthropicTool }>(op).tool;
                    tools.push(tool);
                    if (typeof tool.name === "string") {
                        if (declaredTools.has(tool.name)) {
                            throw new LintError(
                                `anthropic_messages request lower: duplicate tool name ${JSON.stringify(tool.name)}`,
                            );
                        }
                        residualToolNames.add(tool.name);
                    }
                }
                break;
            case "anthropic_messages.tool_meta": {
                const meta = opData<{
                    name: string;
                    fields: Record<string, unknown>;
                }>(op);
                const tool = tools.find(
                    (candidate) => candidate.name === meta.name,
                );
                if (!tool) {
                    tools.push({ name: meta.name, ...meta.fields });
                } else {
                    Object.assign(tool, meta.fields);
                }
                break;
            }
            case "llm.tool_choice":
                body.tool_choice = toolChoiceToWire(
                    (op as OpOf<"llm.tool_choice">).value,
                    declaredTools,
                    residualToolNames,
                    "anthropic_messages request lower",
                );
                break;
            case "anthropic_messages.metadata": {
                mergeMetadata(
                    body,
                    opData<{ value: Record<string, unknown> }>(op).value,
                );
                break;
            }
            case "anthropic_messages.sampling": {
                const sampling = opData<{
                    key: "top_p" | "top_k";
                    value: number;
                }>(op);
                body[sampling.key] = sampling.value;
                break;
            }
            case "anthropic_messages.thinking_config":
                body.thinking = opData<{ value: Record<string, unknown> }>(
                    op,
                ).value;
                break;
            case "anthropic_messages.output_config":
                body.output_config = opData<{ value: Record<string, unknown> }>(
                    op,
                ).value;
                break;
            case "anthropic_messages.context_management":
                body.context_management = opData<{
                    value: Record<string, unknown>;
                }>(op).value;
                break;
            case "anthropic_messages.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `anthropic_messages request toWire: no serialization for op "${op.op}"`,
                );
        }
    }
    if (hasComplexSystem) {
        body.system = systemBlocks;
    } else if (systemParts.length > 0) {
        body.system = systemParts.join("\n\n");
    }
    body.messages = messages;
    if (tools.length > 0) body.tools = tools;
    if (!body.model)
        throw new Error(
            "anthropic_messages request toWire: program has no llm.model op",
        );
    if (body.max_tokens == null) {
        throw new Error(
            "anthropic_messages request toWire: max_tokens is required by the API — " +
                "set llm.max_output_tokens or enable the default-max-tokens legalization",
        );
    }
    return body;
}

function mergeMetadata(
    body: Record<string, unknown>,
    fields: Record<string, unknown>,
): void {
    const current = body.metadata;
    if (current == null) {
        body.metadata = fields;
        return;
    }
    if (typeof current !== "object" || Array.isArray(current)) {
        throw new LintError(
            "anthropic_messages request toWire: metadata must be an object",
        );
    }
    body.metadata = { ...(current as Record<string, unknown>), ...fields };
}

function upsertTool(tools: WireAnthropicTool[], tool: WireAnthropicTool): void {
    const existing = tools.find((candidate) => candidate.name === tool.name);
    if (!existing) {
        tools.push(tool);
        return;
    }
    Object.assign(existing, { ...tool, ...existing });
}

function toolFromWire(tool: Record<string, unknown>): Program {
    const serverTool = serverToolFromWire(tool);
    if (serverTool) return [serverTool];
    const isUserDefined =
        tool.type == null && tool.name != null && tool.input_schema != null;
    if (!isUserDefined) {
        return [
            {
                op: "anthropic_messages.tool",
                tool: tool as WireAnthropicTool,
            },
        ];
    }

    const { name, description, input_schema, ...fields } = tool;
    const out: Program = [
        {
            op: "llm.tool",
            name: asString(name, "tool.name"),
            ...(description != null
                ? { description: asString(description, "tool.description") }
                : {}),
            inputSchema: (input_schema ?? {}) as JsonSchema,
        },
    ];
    if (Object.keys(fields).length > 0) {
        out.push({
            op: "anthropic_messages.tool_meta",
            name: asString(name, "tool.name"),
            fields,
        });
    }
    return out;
}

function serverToolFromWire(tool: Record<string, unknown>): Op | undefined {
    const type = typeof tool.type === "string" ? tool.type : undefined;
    const kind = type ? serverToolKindFromAnthropicType(type) : undefined;
    if (!kind) return undefined;
    const { type: _type, name, ...fields } = tool;
    if (Object.keys(fields).length > 0) return undefined;
    return {
        op: "llm.server_tool",
        name: asString(name, "tool.name"),
        kind,
    };
}

function serverToolToWire(op: OpOf<"llm.server_tool">): WireAnthropicTool {
    return {
        type: anthropicServerToolType(op.kind),
        name: op.name,
    };
}

function serverToolKindFromAnthropicType(
    type: string,
): ServerToolKind | undefined {
    if (type === "web_search_20260318") return "web_search";
    if (type === "code_execution_20260521") return "code_execution";
    return undefined;
}

function anthropicServerToolType(kind: ServerToolKind): string {
    switch (kind) {
        case "web_search":
            return "web_search_20260318";
        case "code_execution":
            return "code_execution_20260521";
    }
}

export function responseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "anthropic_messages response body");
    const program: Program = [];
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "role":
            case "content":
                // Handled together below via role+content; skip here.
                break;
            case "stop_reason":
                if (value != null) {
                    program.push({
                        op: "anthropic_messages.stop_reason",
                        value: asString(value, "stop_reason"),
                    });
                }
                break;
            case "usage":
                program.push({
                    op: "anthropic_messages.usage",
                    usage: asRecord(value, "usage"),
                    appliesTo: "response",
                });
                break;
            default:
                program.push({
                    op: "anthropic_messages.body_field",
                    key,
                    value,
                    appliesTo: "response",
                });
        }
    }
    program.unshift({
        op: "anthropic_messages.message",
        message: {
            role: asString(body.role ?? "assistant", "role") as "assistant",
            content: asArray(
                body.content,
                "content",
            ) as WireAnthropicMessage["content"],
        },
    });
    return program;
}

export function responseToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    let message: WireAnthropicMessage | undefined;
    let usage: Record<string, unknown> | undefined;
    const residualContentBlocks: WireBlock[] = [];
    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "anthropic_messages.message":
                if (message)
                    throw new Error(
                        "anthropic_messages response toWire: expected a single message op",
                    );
                message = op.message as WireAnthropicMessage;
                break;
            case "anthropic_messages.content_block":
                residualContentBlocks.push(
                    opData<{ block: WireBlock }>(op).block,
                );
                break;
            case "anthropic_messages.stop_reason":
                body.stop_reason = opData<{ value: string }>(op).value;
                break;
            // Mapped counts from lower plus any vendor detail residual merge
            // into one wire usage object.
            case "anthropic_messages.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "anthropic_messages.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `anthropic_messages response toWire: no serialization for op "${op.op}"`,
                );
        }
    }
    if (!message)
        throw new Error(
            "anthropic_messages response toWire: program has no message",
        );
    if (usage) body.usage = usage;
    body.id ??= `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    body.type ??= "message";
    body.role = message.role;
    const messageContent =
        typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content;
    body.content = [...residualContentBlocks, ...messageContent];
    body.stop_reason ??= null;
    return body;
}

export function streamResponseFromWire(wire: unknown): Program {
    return [
        {
            op: "anthropic_messages.stream_event",
            event: asRecord(
                wire,
                "anthropic_messages stream event",
            ) as unknown as WireAnthropicStreamEvent,
            appliesTo: "response",
        },
    ];
}

export function streamResponseToWire(program: Program): unknown {
    if (program.length !== 1) {
        throw new Error(
            `anthropic_messages stream response toWire: expected exactly 1 event op, got ${program.length}`,
        );
    }
    const [op] = program;
    if (op?.op !== "anthropic_messages.stream_event") {
        throw new LintError(
            `anthropic_messages stream response toWire: no serialization for op "${op?.op}"`,
        );
    }
    return opData<{ event: WireAnthropicStreamEvent }>(op).event;
}

function systemFromWire(value: unknown): Op[] {
    if (typeof value === "string") {
        return [{ op: "llm.text", role: "system", content: value }];
    }
    return asArray(value, "system").flatMap((block) => {
        const b = asRecord(block, "system block");
        if (b.type !== "text") {
            return [
                {
                    op: "anthropic_messages.system_block",
                    block: b as WireBlock,
                },
            ];
        }
        const { type, text, cache_control, ...rest } = b;
        if (Object.keys(rest).length > 0) {
            return [
                {
                    op: "anthropic_messages.system_block",
                    block: b as WireBlock,
                },
            ];
        }
        const out: Op[] = [
            {
                op: "llm.text",
                role: "system",
                content: asString(text, "system block text"),
            },
        ];
        if (cache_control != null) {
            out.push({
                op: "anthropic_messages.text_meta",
                fields: { cache_control },
            });
        }
        return out;
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
            throw new Error(
                `anthropic_messages tool_choice: unsupported type ${JSON.stringify(choice.type)}`,
            );
    }
}

function toolChoiceToWire(
    value: ToolChoice,
    toolsByName: Map<string, DeclaredTool>,
    residualToolNames: Set<string>,
    context: string,
): unknown {
    if (typeof value !== "string") {
        if (
            !toolsByName.has(value.name) &&
            !residualToolNames.has(value.name)
        ) {
            throw new LintError(
                `${context}: tool_choice references undeclared tool ${JSON.stringify(value.name)}`,
            );
        }
        return { type: "tool", name: value.name };
    }
    switch (value) {
        case "auto":
            return { type: "auto" };
        case "required":
            return { type: "any" };
        case "none":
            return { type: "none" };
    }
}
