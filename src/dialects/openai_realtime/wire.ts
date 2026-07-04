import {
    opData,
    type JsonSchema,
    type Op,
    type OpOf,
    type Program,
    type ToolChoice,
} from "../../core/ops";
import { LintError } from "../../core/pass";
import { asArray, asNumber, asRecord, asString } from "../../core/wire";
import type {
    WireConversationItem,
    WireConversationItemCreateEvent,
    WireOutputItem,
} from "./ops";

interface RequestParseState {
    responseCreateCount: number;
    sawConversationItem: boolean;
    sawResponseInput: boolean;
}

export function requestFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_realtime request event body");
    const prefix: Program = [];
    const program: Program = [];
    const state: RequestParseState = {
        responseCreateCount: 0,
        sawConversationItem: false,
        sawResponseInput: false,
    };

    for (const [key, value] of Object.entries(body)) {
        if (key === "events") continue;
        if (key === "model") {
            program.push({
                op: "llm.model",
                model: asString(value, "model"),
            });
            continue;
        }
        program.push({ op: "openai_realtime.body_field", key, value });
    }

    for (const rawEvent of asArray(body.events, "events")) {
        parseRequestEvent(
            asRecord(rawEvent, "request event"),
            prefix,
            program,
            state,
        );
    }
    if (state.responseCreateCount !== 1) {
        throw new Error(
            `openai_realtime request event body: expected exactly one response.create event, got ${state.responseCreateCount}`,
        );
    }
    if (state.sawConversationItem && state.sawResponseInput) {
        throw new LintError(
            "openai_realtime request mixes conversation.item.create events with response.create.response.input context",
        );
    }
    return [...prefix, ...program];
}

export function requestToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const events: unknown[] = [];
    const response: Record<string, unknown> = {};
    const responseEvent: Record<string, unknown> = { type: "response.create" };
    const instructions: string[] = [];
    const tools: unknown[] = [];
    const toolsByName = new Map<string, Record<string, unknown>>();
    const pendingToolMeta = new Map<
        string,
        { fields: Record<string, unknown>; required: boolean }
    >();
    const responseInput: WireConversationItem[] = [];
    const useResponseInput = program.some(
        (op) => op.op === "openai_realtime.response_input_mode",
    );

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "system") {
                    throw new LintError(
                        `openai_realtime request toWire: ${text.role} text must lower to openai_realtime.item first`,
                    );
                }
                instructions.push(text.content);
                break;
            }
            case "llm.max_output_tokens":
                response.max_output_tokens = op.value;
                break;
            case "llm.tool":
                {
                    const toolOp = op as OpOf<"llm.tool">;
                    const tool = toolToWire(toolOp);
                    const pending = pendingToolMeta.get(toolOp.name);
                    if (pending) {
                        Object.assign(tool, pending.fields);
                        pendingToolMeta.delete(toolOp.name);
                    }
                    tools.push(tool);
                    toolsByName.set(toolOp.name, tool);
                }
                break;
            case "openai_realtime.tool_meta": {
                const meta = opData<{
                    name: string;
                    fields: Record<string, unknown>;
                    required?: boolean;
                }>(op);
                const tool = toolsByName.get(meta.name);
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
                response.tool_choice = toolChoiceToWire(
                    (op as OpOf<"llm.tool_choice">).value,
                );
                break;
            case "openai_realtime.item": {
                const event = opData<{
                    event: WireConversationItemCreateEvent;
                }>(op).event;
                if (useResponseInput) responseInput.push(event.item);
                else events.push(event);
                break;
            }
            case "openai_realtime.response_input_mode":
                break;
            case "openai_realtime.response_param": {
                const param = opData<{ key: string; value: unknown }>(op);
                response[param.key] = param.value;
                break;
            }
            case "openai_realtime.event_param": {
                const param = opData<{
                    eventType: string;
                    key: string;
                    value: unknown;
                }>(op);
                if (param.eventType === "response.create")
                    responseEvent[param.key] = param.value;
                break;
            }
            case "openai_realtime.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_realtime request toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (instructions.length > 0)
        response.instructions = instructions.join("\n\n");
    if (tools.length > 0) response.tools = tools;
    const unconsumedToolMeta = [...pendingToolMeta.entries()].filter(
        ([, meta]) => meta.required,
    );
    if (unconsumedToolMeta.length > 0) {
        throw new LintError(
            `openai_realtime request toWire: tool metadata for missing tool(s) ${unconsumedToolMeta
                .map(([name]) => JSON.stringify(name))
                .join(", ")}`,
        );
    }
    if (useResponseInput) response.input = responseInput;
    response.output_modalities ??= ["text"];
    assertTextModalities(response.output_modalities);
    responseEvent.response = response;
    events.push(responseEvent);
    body.events = events;
    return body;
}

export function responseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "openai_realtime response event body");
    const program: Program = [];
    let responseDoneCount = 0;

    for (const [key, value] of Object.entries(body)) {
        if (key === "events") continue;
        program.push({
            op: "openai_realtime.body_field",
            key,
            value,
            appliesTo: "response",
            required: false,
        });
    }

    for (const rawEvent of asArray(body.events, "events")) {
        const event = asRecord(rawEvent, "response event");
        const type = asString(event.type, "response event.type");
        if (type !== "response.done") {
            throwUnsupportedResponseEvent(type);
        }
        responseDoneCount++;
        for (const [key, value] of Object.entries(event)) {
            if (key === "type" || key === "response") continue;
            program.push({
                op: "openai_realtime.event_param",
                eventType: "response.done",
                key,
                value,
                appliesTo: "response",
                required: false,
            });
        }
        parseResponseDone(
            asRecord(event.response, "response.done.response"),
            program,
        );
    }

    if (responseDoneCount !== 1) {
        throw new Error(
            `openai_realtime response event body: expected exactly one response.done event, got ${responseDoneCount}`,
        );
    }
    return program;
}

export function responseToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const event: Record<string, unknown> = { type: "response.done" };
    const output: unknown[] = [];
    let usage: Record<string, unknown> | undefined;
    let finishReason: string | undefined;

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "openai_realtime.output":
                output.push(opData<{ item: WireOutputItem }>(op).item);
                break;
            case "openai_realtime.finish_reason":
                finishReason = opData<{ reason: string }>(op).reason;
                break;
            case "openai_realtime.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "openai_realtime.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            case "openai_realtime.event_param": {
                const param = opData<{
                    eventType: string;
                    key: string;
                    value: unknown;
                }>(op);
                if (param.eventType === "response.done")
                    event[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_realtime response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (output.length === 0)
        throw new Error(
            "openai_realtime response toWire: program has no output",
        );
    body.output = output;
    if (usage) body.usage = usage;
    body.id ??= `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    body.object ??= "realtime.response";
    applyStatus(body, finishReason);
    event.response = body;
    return { events: [event] };
}

export function streamResponseFromWire(wire: unknown): Program {
    const event = singleStreamEvent(wire);
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
        case "response.output_text.done":
        case "response.content_part.done":
            return streamEventParams(event, []);
        case "response.done":
            return streamDoneEvent(event);
        default:
            throwUnsupportedStreamResponseEvent(type);
    }
}

export function streamResponseToWire(program: Program): unknown {
    let text = "";
    const toolDeltas: OpOf<"response.tool_call_delta">[] = [];
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    const event: Record<string, unknown> = {};
    let eventType: string | undefined;
    let sawTextDelta = false;

    for (const op of program) {
        switch (op.op) {
            case "response.text_delta":
                sawTextDelta = true;
                text += (op as OpOf<"response.text_delta">).content;
                eventType ??= "response.output_text.delta";
                break;
            case "response.tool_call_delta":
                toolDeltas.push(op as OpOf<"response.tool_call_delta">);
                eventType ??= "response.function_call_arguments.delta";
                break;
            case "openai_realtime.finish_reason":
                finishReason = opData<{ reason: string }>(op).reason;
                eventType ??= "response.done";
                break;
            case "openai_realtime.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                eventType ??= "response.done";
                break;
            case "openai_realtime.event_param": {
                const param = opData<{
                    eventType: string;
                    key: string;
                    value: unknown;
                }>(op);
                eventType = param.eventType;
                if (param.key !== "type") event[param.key] = param.value;
                break;
            }
            case "openai_realtime.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                event[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `openai_realtime stream response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (sawTextDelta) {
        return {
            type: eventType ?? "response.output_text.delta",
            ...event,
            delta: text,
        };
    }
    if (toolDeltas.length > 0) {
        const tool = toolDeltas[0]!;
        if (tool.name != null || tool.id != null) {
            const itemTemplate = asRecord(
                event.item ?? {},
                "stream event.item",
            );
            return {
                type: eventType ?? "response.output_item.added",
                ...event,
                ...(tool.index != null ? { output_index: tool.index } : {}),
                item: {
                    ...itemTemplate,
                    type: "function_call",
                    call_id:
                        tool.id ??
                        itemTemplate.call_id ??
                        `call_${crypto.randomUUID()}`,
                    name: tool.name ?? itemTemplate.name ?? "",
                    arguments: tool.arguments ?? itemTemplate.arguments ?? "",
                },
            };
        }
        return {
            type: eventType ?? "response.function_call_arguments.delta",
            ...event,
            ...(tool.index != null ? { output_index: tool.index } : {}),
            delta: tool.arguments ?? "",
        };
    }

    if (
        eventType === "response.done" ||
        finishReason != null ||
        usage != null
    ) {
        const response = asRecord(
            event.response ?? {},
            "stream event.response",
        );
        applyStatus(response, finishReason);
        if (usage) response.usage = usage;
        return { type: "response.done", ...event, response };
    }
    return { type: eventType ?? "response.done", ...event };
}

function parseRequestEvent(
    event: Record<string, unknown>,
    prefix: Program,
    program: Program,
    state: RequestParseState,
): void {
    const type = asString(event.type, "request event.type");
    switch (type) {
        case "conversation.item.create":
            state.sawConversationItem = true;
            program.push({
                op: "openai_realtime.item",
                event: requestEventFromWire(event),
            });
            break;
        case "response.create":
            state.responseCreateCount++;
            for (const [key, value] of Object.entries(event)) {
                if (key === "type" || key === "response") continue;
                program.push({
                    op: "openai_realtime.event_param",
                    eventType: "response.create",
                    key,
                    value,
                    required: false,
                });
            }
            parseResponseCreate(
                event.response == null
                    ? {}
                    : asRecord(event.response, "response.create.response"),
                prefix,
                program,
                state,
            );
            break;
        default:
            throwUnsupportedRequestEvent(type);
    }
}

function singleStreamEvent(wire: unknown): Record<string, unknown> {
    const body = asRecord(wire, "openai_realtime stream response event");
    if (!Object.hasOwn(body, "events")) return body;
    const events = asArray(body.events, "events");
    if (events.length !== 1) {
        throw new Error(
            `openai_realtime stream response body: expected exactly one event, got ${events.length}`,
        );
    }
    return asRecord(events[0], "stream event");
}

function streamEventParams(
    event: Record<string, unknown>,
    skip: string[],
): Program {
    const skipped = new Set(skip);
    return Object.entries(event)
        .filter(([key]) => !skipped.has(key))
        .map(([key, value]) => ({
            op: "openai_realtime.event_param",
            eventType: asString(event.type, "stream event.type"),
            key,
            value,
            appliesTo: "response" as const,
            required: false,
        }));
}

function streamOutputItemEvent(
    event: Record<string, unknown>,
    type: string,
): Program {
    const program = streamEventParams(event, ["item"]);
    const item = asRecord(event.item, "stream event.item");
    program.push({
        op: "openai_realtime.event_param",
        eventType: asString(event.type, "stream event.type"),
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

function streamDoneEvent(event: Record<string, unknown>): Program {
    const program = streamEventParams(event, ["response"]);
    const response = asRecord(event.response, "stream event.response");
    const { usage: _usage, ...responseMeta } = response;
    if (Object.keys(responseMeta).length > 0) {
        program.push({
            op: "openai_realtime.event_param",
            eventType: "response.done",
            key: "response",
            value: responseMeta,
            appliesTo: "response",
            required: false,
        });
    }
    let status: string | undefined;
    let statusDetails: Record<string, unknown> | undefined;

    for (const [key, value] of Object.entries(response)) {
        switch (key) {
            case "status":
                status = asString(value, "response.status");
                break;
            case "status_details":
                statusDetails =
                    value == null
                        ? undefined
                        : asRecord(value, "response.status_details");
                break;
            case "usage":
                program.push({
                    op: "openai_realtime.usage",
                    usage: asRecord(value, "response.usage"),
                    appliesTo: "response",
                });
                break;
        }
    }

    const reason = finishReason(status, statusDetails, false);
    if (reason) program.push({ op: "openai_realtime.finish_reason", reason });
    return program;
}

function parseResponseCreate(
    response: Record<string, unknown>,
    prefix: Program,
    program: Program,
    state: RequestParseState,
): void {
    for (const [key, value] of Object.entries(response)) {
        switch (key) {
            case "instructions":
                if (value != null)
                    prefix.push({
                        op: "llm.text",
                        role: "system",
                        content: asString(value, "response.instructions"),
                    });
                break;
            case "input":
                state.sawResponseInput = true;
                program.push({
                    op: "openai_realtime.response_input_mode",
                    required: false,
                });
                for (const item of asArray(value, "response.input")) {
                    program.push({
                        op: "openai_realtime.item",
                        event: {
                            type: "conversation.item.create",
                            item: requestItemFromWire(item),
                        },
                    });
                }
                break;
            case "tools":
                for (const tool of asArray(value, "response.tools"))
                    program.push(
                        ...toolFromWire(asRecord(tool, "response.tool")),
                    );
                break;
            case "tool_choice":
                program.push({
                    op: "llm.tool_choice",
                    value: toolChoiceFromWire(value),
                });
                break;
            case "max_output_tokens":
                if (typeof value === "number")
                    program.push({
                        op: "llm.max_output_tokens",
                        value: asNumber(value, "response.max_output_tokens"),
                    });
                else
                    program.push({
                        op: "openai_realtime.response_param",
                        key,
                        value,
                    });
                break;
            case "output_modalities":
                assertTextModalities(value);
                break;
            default:
                program.push({
                    op: "openai_realtime.response_param",
                    key,
                    value,
                });
        }
    }
}

function parseResponseDone(
    response: Record<string, unknown>,
    program: Program,
): void {
    let status: string | undefined;
    let statusDetails: Record<string, unknown> | undefined;
    let hasFunctionCall = false;

    for (const [key, value] of Object.entries(response)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "response.model"),
                });
                break;
            case "output":
                for (const item of asArray(value, "response.output")) {
                    const output = asRecord(
                        item,
                        "response.output item",
                    ) as unknown as WireOutputItem;
                    if (output.type === "function_call") hasFunctionCall = true;
                    program.push({
                        op: "openai_realtime.output",
                        item: output,
                    });
                }
                break;
            case "usage":
                program.push({
                    op: "openai_realtime.usage",
                    usage: asRecord(value, "response.usage"),
                    appliesTo: "response",
                });
                break;
            case "status":
                status = asString(value, "response.status");
                program.push({
                    op: "openai_realtime.body_field",
                    key,
                    value,
                    appliesTo: "response",
                    required: false,
                });
                break;
            case "status_details":
                statusDetails =
                    value == null
                        ? undefined
                        : asRecord(value, "response.status_details");
                program.push({
                    op: "openai_realtime.body_field",
                    key,
                    value,
                    appliesTo: "response",
                    required: false,
                });
                break;
            default:
                program.push({
                    op: "openai_realtime.body_field",
                    key,
                    value,
                    appliesTo: "response",
                    required: false,
                });
        }
    }

    const reason = finishReason(status, statusDetails, hasFunctionCall);
    if (reason) program.push({ op: "openai_realtime.finish_reason", reason });
}

function toolFromWire(tool: Record<string, unknown>): Op[] {
    if (tool.type != null && tool.type !== "function") {
        throw new Error(
            `openai_realtime tool: unsupported tool type ${JSON.stringify(tool.type)}`,
        );
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
            op: "openai_realtime.tool_meta",
            name,
            fields,
            appliesTo: "request",
        });
    }
    return ops;
}

function requestItemFromWire(value: unknown): WireConversationItem {
    return asRecord(
        value,
        "conversation item",
    ) as unknown as WireConversationItem;
}

function requestEventFromWire(
    event: Record<string, unknown>,
): WireConversationItemCreateEvent {
    const { type, item, ...fields } = event;
    return {
        type: "conversation.item.create",
        ...fields,
        item: requestItemFromWire(item),
    };
}

function toolToWire(tool: OpOf<"llm.tool">): Record<string, unknown> {
    return {
        type: "function",
        name: tool.name,
        ...(tool.description != null ? { description: tool.description } : {}),
        parameters: tool.inputSchema,
    };
}

function toolChoiceFromWire(value: unknown): ToolChoice {
    if (value === "auto" || value === "none" || value === "required")
        return value;
    const choice = asRecord(value, "tool_choice");
    if (choice.type === "function")
        return { name: asString(choice.name, "tool_choice.name") };
    throw new Error(
        `openai_realtime tool_choice: unsupported value ${JSON.stringify(value)}`,
    );
}

function toolChoiceToWire(value: ToolChoice): unknown {
    if (typeof value === "string") return value;
    return { type: "function", name: value.name };
}

function assertTextModalities(value: unknown): void {
    const modalities = asArray(value, "output_modalities");
    if (modalities.length !== 1 || modalities[0] !== "text") {
        throw new LintError(
            `openai_realtime supports text output only, got output_modalities ${JSON.stringify(value)}`,
        );
    }
}

function finishReason(
    status: string | undefined,
    statusDetails: Record<string, unknown> | undefined,
    hasFunctionCall: boolean,
): "end_turn" | "max_tokens" | "tool_use" | "content_filter" | undefined {
    if (hasFunctionCall) return "tool_use";
    if (status === "completed") return "end_turn";
    if (
        status === "incomplete" &&
        statusDetails?.reason === "max_output_tokens"
    )
        return "max_tokens";
    if (status === "incomplete" && statusDetails?.reason === "content_filter")
        return "content_filter";
    return undefined;
}

function applyStatus(
    body: Record<string, unknown>,
    finishReason: string | undefined,
): void {
    if (body.status != null) return;
    switch (finishReason) {
        case "max_tokens":
            body.status = "incomplete";
            body.status_details ??= {
                type: "incomplete",
                reason: "max_output_tokens",
            };
            break;
        case "content_filter":
            body.status = "incomplete";
            body.status_details ??= {
                type: "incomplete",
                reason: "content_filter",
            };
            break;
        default:
            body.status = "completed";
            body.status_details ??= null;
    }
}

function throwUnsupportedRequestEvent(type: string): never {
    if (type.startsWith("input_audio_buffer.") || type.includes("audio")) {
        throw new LintError(
            `openai_realtime request event ${JSON.stringify(type)} is audio; audio is out of scope`,
        );
    }
    if (type.includes(".delta")) {
        throw new LintError(
            `openai_realtime request event ${JSON.stringify(type)} is streaming; deltas are out of scope`,
        );
    }
    throw new LintError(
        `openai_realtime request event: unsupported event type ${JSON.stringify(type)}`,
    );
}

function throwUnsupportedResponseEvent(type: string): never {
    if (type.includes("audio")) {
        throw new LintError(
            `openai_realtime response event ${JSON.stringify(type)} is audio; audio is out of scope`,
        );
    }
    if (
        type.includes(".delta") ||
        type === "response.output_item.done" ||
        type === "response.output_text.done"
    ) {
        throw new LintError(
            `openai_realtime response event ${JSON.stringify(type)} is streaming detail; parse response.done instead`,
        );
    }
    throw new LintError(
        `openai_realtime response event: unsupported event type ${JSON.stringify(type)}`,
    );
}

function throwUnsupportedStreamResponseEvent(type: string): never {
    if (type.includes("audio")) {
        throw new LintError(
            `openai_realtime stream response event ${JSON.stringify(type)} is audio; audio is out of scope`,
        );
    }
    throw new LintError(
        `openai_realtime stream response event: unsupported event type ${JSON.stringify(type)}`,
    );
}
