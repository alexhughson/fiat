import {
    opData,
    type JsonSchema,
    type Op,
    type OpOf,
    type Program,
    type ServerToolKind,
    type ThinkingEffort,
    type ToolChoice,
} from "../../core/ops.js";
import { firstOp } from "../../core/program.js";
import { declaredToolsByName, type DeclaredTool } from "../../core/tools.js";
import { LintError } from "../../core/lint.js";
import { asArray, asNumber, asRecord, asString } from "../../core/wire.js";
import type { WireInputItem, WireOutputItem, WireTool } from "./ops.js";

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
        { fields: Record<string, unknown> }
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
                }>(op);
                const tool = functionToolsByName.get(meta.name);
                if (tool) {
                    Object.assign(tool, meta.fields);
                } else {
                    const pending = pendingToolMeta.get(meta.name);
                    pendingToolMeta.set(meta.name, {
                        fields: { ...pending?.fields, ...meta.fields },
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
    const unconsumedToolMeta = [...pendingToolMeta.entries()];
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
                });
                break;
            }
            default:
                program.push({
                    op: "openai_responses.body_field",
                    key,
                    value,
                    appliesTo: "response",
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
        // The fields beside the delta (item_id, content_index,
        // sequence_number, logprobs) stay together in one meta op beside the
        // core op; output_index is the core op's index, and `type` repeats
        // what the core op already says.
        case "response.output_text.delta":
            return [
                streamEventMeta(event, ["type", "delta", "output_index"]),
                {
                    op: "response.text_delta",
                    ...(event.output_index != null
                        ? {
                              index: asNumber(
                                  event.output_index,
                                  "stream event.output_index",
                              ),
                          }
                        : {}),
                    role: "assistant",
                    content: asString(event.delta, "stream event.delta"),
                },
            ];
        case "response.function_call_arguments.delta":
            return [
                streamEventMeta(event, ["type", "delta", "output_index"]),
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
        // output_text.done repeats the text the text_delta ops already
        // carried, and function_call_arguments.done repeats the arguments the
        // tool_call_delta ops already carried; neither states a new fact, so
        // the whole event stays in the meta op.
        case "response.output_text.done":
        case "response.function_call_arguments.done":
            return [streamEventMeta(event, [])];
        case "response.output_item.added":
        case "response.output_item.done":
            return streamOutputItemEvent(event, type);
        // response.created states the model once, so the model raises to
        // llm.model after the event's meta op; the envelope's constant fields
        // do not raise (lowering writes them back) and the rest of the
        // envelope stays in the meta op. response.in_progress only repeats
        // facts and stays whole.
        case "response.created":
            return streamCreatedEvent(event);
        case "response.in_progress":
            return [streamEventMeta(event, [])];
        // The part opens empty and its text arrives as output_text.delta
        // events, so the meta op drops part.type (the core op names the text
        // block) and the empty part.text; the keys only openai_responses has
        // stay in the meta op. output_index raises to the core op's index.
        // A part other than output_text still throws, like on main, until
        // a refusal has a core op.
        case "response.content_part.added": {
            const part = asRecord(event.part, "stream event.part");
            if (part.type !== "output_text") {
                throw unsupportedStreamPartType(part.type);
            }
            const { type: _type, text: _text, ...partMeta } = part;
            return [
                streamEventMeta({ ...event, part: partMeta }, ["output_index"]),
                {
                    op: "response.text_start",
                    index: asNumber(
                        event.output_index,
                        "stream event.output_index",
                    ),
                },
            ];
        }
        // part.type repeats what the core op already says, so the meta op
        // drops it; the full part.text repeats the output_text.delta events,
        // but stream lowering holds no state, so without the text in the meta
        // op the done event would return from a round trip without its text.
        // A part other than output_text still throws, like on main.
        case "response.content_part.done": {
            const part = asRecord(event.part, "stream event.part");
            if (part.type !== "output_text") {
                throw unsupportedStreamPartType(part.type);
            }
            const { type: _type, ...partMeta } = part;
            return [
                streamEventMeta({ ...event, part: partMeta }, ["output_index"]),
                {
                    op: "response.block_stop",
                    index: asNumber(
                        event.output_index,
                        "stream event.output_index",
                    ),
                },
            ];
        }
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

// A part other than output_text, such as a refusal, has no core op yet; it
// throws here rather than hiding its content inside a metadata op.
function unsupportedStreamPartType(partType: unknown): LintError {
    return new LintError(
        `openai_responses stream response: unsupported part type ${JSON.stringify(partType)}`,
    );
}

export function streamResponseToWire(program: Program): unknown {
    let text = "";
    const toolDeltas: OpOf<"response.tool_call_delta">[] = [];
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let model: string | undefined;
    const event: Record<string, unknown> = {};
    let sawTextDelta = false;

    for (const op of program) {
        switch (op.op) {
            case "response.text_delta": {
                const delta = op as OpOf<"response.text_delta">;
                sawTextDelta = true;
                text += delta.content;
                event.type ??= "response.output_text.delta";
                if (delta.index != null) event.output_index = delta.index;
                break;
            }
            case "response.text_start":
                event.type ??= "response.content_part.added";
                event.output_index = (op as OpOf<"response.text_start">).index;
                // The meta op holds the part without type and text; lowering
                // writes both back, with defaults when no meta op came.
                event.part = {
                    type: "output_text",
                    text: "",
                    annotations: [],
                    logprobs: [],
                    ...asRecord(event.part ?? {}, "stream event.part"),
                };
                break;
            case "response.block_stop": {
                event.type ??= "response.content_part.done";
                event.output_index = (op as OpOf<"response.block_stop">).index;
                // The done event's part keeps its text in the meta op; its
                // type repeats the core op, so lowering writes it back.
                if (event.part != null) {
                    event.part = {
                        type: "output_text",
                        ...asRecord(event.part, "stream event.part"),
                    };
                }
                break;
            }
            case "response.tool_call_delta":
                toolDeltas.push(op as OpOf<"response.tool_call_delta">);
                event.type ??= "response.function_call_arguments.delta";
                break;
            case "llm.model":
                model = (op as OpOf<"llm.model">).model;
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
            case "openai_responses.stream_event_meta": {
                const meta = opData<{ event: Record<string, unknown> }>(op);
                Object.assign(event, meta.event);
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

    // A finish reason closes the response; the model raised from
    // response.created folds back into the envelope the same way.
    event.type ??= terminalEventType(finishReason);
    // The created event's constant envelope fields were dropped on raise
    // when they held the expected value; lowering writes them back. A field
    // the meta op kept (its value differed) is already present, so the
    // defaults do not overwrite it.
    if (event.type === "response.created" && event.response != null) {
        const created = asRecord(event.response, "stream event.response");
        for (const [key, value] of Object.entries(CREATED_RESPONSE_CONSTANTS)) {
            created[key] ??= structuredClone(value);
        }
        event.response = created;
    }
    if (usage || finishReason != null || model != null) {
        const response = asRecord(
            event.response ?? {},
            "stream event.response",
        );
        if (model != null) response.model = model;
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

function streamEventMeta(event: Record<string, unknown>, skip: string[]): Op {
    const skipped = new Set(skip);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
        if (skipped.has(key)) continue;
        rest[key] = value;
    }
    return {
        op: "openai_responses.stream_event_meta",
        event: rest,
        appliesTo: "response",
    };
}

// Deletes keys whose value is undefined, which rest destructuring leaves
// behind when it removes a key, so JSON comparisons stay exact.
function omitEmptyKeys(
    value: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        out[key] = entry;
    }
    return out;
}

function streamOutputItemEvent(
    event: Record<string, unknown>,
    type: string,
): Program {
    const item = asRecord(event.item, "stream event.item");
    if (item.type !== "function_call") {
        // A message item has no core op yet, so the whole event stays in the
        // meta op and round-trips.
        return [streamEventMeta(event, [])];
    }
    if (type === "response.output_item.done") {
        // The done event repeats the call id, name, and full arguments that
        // the added and delta events already stated, so it adds only the
        // block's ending: the whole event stays in the meta op beside the
        // core block_stop op, and a transform that edits the tool_call_delta
        // ops does not change this copy.
        return [
            streamEventMeta(event, []),
            {
                op: "response.block_stop",
                index: asNumber(
                    event.output_index,
                    "stream event.output_index",
                ),
            },
        ];
    }
    // The added event states the call id and name once, so they raise to the
    // tool_call_delta op; the meta op keeps the item without them, and
    // lowering rebuilds the item from the two ops. output_index raises to
    // the core op's index.
    const { call_id: _callId, name: _name, ...itemMeta } = item;
    return [
        streamEventMeta({ ...event, item: itemMeta }, ["output_index"]),
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
            ...(item.call_id != null
                ? { id: asString(item.call_id, "stream event.item.call_id") }
                : {}),
            ...(item.name != null
                ? { name: asString(item.name, "stream event.item.name") }
                : {}),
        },
    ];
}

// A created response opens with a fixed envelope whose values OpenAI always
// sends the same way; the raiser drops each only when it holds exactly the
// expected value, and lowering writes the dropped values back.
const CREATED_RESPONSE_CONSTANTS: Record<string, unknown> = {
    status: "in_progress",
    output: [],
    usage: null,
    object: "response",
    error: null,
    incomplete_details: null,
};

// The envelope states the model once, so the model raises to llm.model. The
// id stays in the meta op until the response.id op's row merges (row 46),
// raised there in this branch's rebase. created_at and the echoed request
// settings (temperature, instructions, tools, and the rest) are data only
// openai_responses has in a stream, so they stay in the meta op. The constant
// envelope fields do not raise; lowering writes them back. The meta op sits
// directly before the core op it belongs to.
function streamCreatedEvent(event: Record<string, unknown>): Program {
    const response =
        event.response == null
            ? undefined
            : asRecord(event.response, "stream event.response");
    const out: Program = [];
    if (response != null) {
        const rest: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(response)) {
            if (key === "model" && value != null) continue;
            if (
                Object.hasOwn(CREATED_RESPONSE_CONSTANTS, key) &&
                JSON.stringify(CREATED_RESPONSE_CONSTANTS[key]) ===
                    JSON.stringify(value)
            ) {
                continue;
            }
            rest[key] = value;
        }
        out.push(streamEventMeta({ ...event, response: rest }, []));
        if (response.model != null) {
            out.push({
                op: "llm.model",
                model: asString(response.model, "stream event.response.model"),
            });
        }
    } else {
        out.push(streamEventMeta(event, []));
    }
    return out;
}

// A terminal event closes the stream: its finish reason raises to
// openai_responses.finish_reason (response.stop after the raise stages)
// and its usage object to openai_responses.usage, which the raise stages
// split into response.usage plus any extras. Everything else stays whole
// in one stream_event_meta op, the same shape as the other events, so
// lowering folds the ops back into the same wire event.
function streamTerminalEvent(event: Record<string, unknown>): Program {
    const response =
        event.response == null
            ? undefined
            : asRecord(event.response, "stream event.response");
    const meta =
        response == null
            ? event
            : {
                  ...event,
                  response: omitEmptyKeys({ ...response, usage: undefined }),
              };
    const program: Program = [streamEventMeta(meta, [])];
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
}): boolean {
    return (
        param.appliesTo === "response" ||
        RESPONSE_ENVELOPE_PARAM_KEYS.has(param.key)
    );
}
