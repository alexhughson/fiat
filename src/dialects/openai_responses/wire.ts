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
import { mergeUsageObjects } from "../../core/usage.js";
import { asArray, asNumber, asRecord, asString } from "../../core/wire.js";
import type { WireInputItem, WireOutputItem, WireTool } from "./ops.js";

// The nested usage objects whose keys merge key-wise when several usage ops
// join into one wire usage object.
const USAGE_DETAILS_KEYS = ["input_tokens_details", "output_tokens_details"];

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
    let inputStart: number | undefined;
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            // JSON key order carries no meaning to OpenAI, so a body that
            // writes `input` before `instructions` still gets its system text
            // ahead of the conversation ops.
            case "instructions":
                if (value != null)
                    program.splice(inputStart ?? program.length, 0, {
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
                inputStart = program.length;
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
            case "id":
                program.push({
                    op: "response.id",
                    id: asString(value, "id"),
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
            case "response.id":
                body.id = (op as OpOf<"response.id">).id;
                break;
            case "openai_responses.output":
                output.push(opData<{ item: WireOutputItem }>(op).item);
                break;
            case "openai_responses.finish_reason":
                finishReason = opData<{ reason: string }>(op).reason;
                break;
            // Multiple usage ops merge: lower emits the counts computed from
            // the core parts, and a usage residual from raise carries the
            // write-by-lifetime breakdown, so the details objects merge
            // key-wise.
            case "openai_responses.usage":
                usage = mergeUsageObjects(
                    usage ?? {},
                    opData<{ usage: Record<string, unknown> }>(op).usage,
                    USAGE_DETAILS_KEYS,
                );
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

// Every event of an ordinary text stream or function-tool-call stream raises.
// A value that other providers also have raises to a core op: the response id
// and the model name of an envelope event, the usage and the stop reason of a
// terminal event, the text of a delta, the complete arguments of a done
// event. A value only this stream format has — the event `type`, the
// `sequence_number`, the `item_id` and `content_index` bookkeeping, the
// response envelope's own fields, a content part or item before its text —
// stays in `openai_responses.body_field` ops, which lower back to the event
// they came from.
export function streamResponseFromWire(wire: unknown): Program {
    const event = asRecord(wire, "openai_responses stream response event");
    const type = asString(event.type, "stream event.type");
    switch (type) {
        case "response.output_text.delta":
            return [
                ...streamEventParams(event, ["type", "output_index", "delta"]),
                {
                    op: "response.text_delta",
                    role: "assistant",
                    ...streamOutputIndex(event),
                    content: asString(event.delta, "stream event.delta"),
                },
            ];
        case "response.function_call_arguments.delta":
            return [
                ...streamEventParams(event, ["type", "output_index", "delta"]),
                {
                    op: "response.tool_call_delta",
                    ...streamOutputIndex(event),
                    arguments: asString(event.delta, "stream event.delta"),
                },
            ];
        case "response.function_call_arguments.done":
            return [
                // The event `type` stays a residual: no core op distinguishes
                // a done event from an output_item.done event, both of which
                // raise the same complete call onto the core op.
                ...streamEventParams(event, [
                    "output_index",
                    "name",
                    "arguments",
                ]),
                {
                    op: "response.tool_call_delta",
                    ...streamOutputIndex(event),
                    ...(event.name != null
                        ? {
                              name: asString(event.name, "stream event.name"),
                          }
                        : {}),
                    arguments: asString(
                        event.arguments,
                        "stream event.arguments",
                    ),
                },
            ];
        case "response.output_item.added":
        case "response.output_item.done":
            return streamOutputItemEvent(event, type);
        // A content part starting or ending, and the finalized text of a
        // part, have no core op yet: the text of the answer arrives through
        // `response.text_delta`, and no core op says where a part starts.
        // These events keep every key as a residual, so they round trip.
        case "response.content_part.added":
        case "response.content_part.done":
        case "response.output_text.done":
            return streamEventParams(event, []);
        case "response.created":
        case "response.in_progress":
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
            return streamEnvelopeEvent(event);
        default:
            throw new LintError(
                `openai_responses stream response: unsupported event type ${JSON.stringify(type)}`,
            );
    }
}

// The raised type decides the event: an event raised on this dialect carries
// its `type` as a body_field residual, and each event type has a field for
// its core ops. A program with no type residual (raised from another
// dialect) keeps the derivation on main.
export function streamResponseToWire(program: Program): unknown {
    let text = "";
    let textIndex: number | undefined;
    const toolDeltas: OpOf<"response.tool_call_delta">[] = [];
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let responseId: string | undefined;
    let modelName: string | undefined;
    const event: Record<string, unknown> = {};
    let sawTextDelta = false;
    let hasRaisedType = false;

    for (const op of program) {
        switch (op.op) {
            case "response.text_delta": {
                const textDelta = op as OpOf<"response.text_delta">;
                sawTextDelta = true;
                text += textDelta.content;
                textIndex ??= textDelta.index;
                event.type ??= "response.output_text.delta";
                break;
            }
            case "response.tool_call_delta":
                toolDeltas.push(op as OpOf<"response.tool_call_delta">);
                event.type ??= "response.function_call_arguments.delta";
                break;
            case "response.id":
                responseId = (op as OpOf<"response.id">).id;
                break;
            case "llm.model":
                modelName = (op as OpOf<"llm.model">).model;
                break;
            case "openai_responses.finish_reason":
                finishReason = opData<{ reason: string }>(op).reason;
                event.type ??= terminalEventType(finishReason);
                break;
            case "openai_responses.usage":
                usage = mergeUsageObjects(
                    usage ?? {},
                    opData<{ usage: Record<string, unknown> }>(op).usage,
                    USAGE_DETAILS_KEYS,
                );
                event.type ??= "response.completed";
                break;
            case "openai_responses.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                event[param.key] = param.value;
                if (param.key === "type") hasRaisedType = true;
                break;
            }
            default:
                throw new LintError(
                    `openai_responses stream response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    rejectDeltaWithFinishReason(
        sawTextDelta || toolDeltas.length > 0,
        finishReason,
    );

    const tool = toolDeltas[0];

    // A raised done event writes `arguments`, never `delta` and never an
    // item; the derived flows below cannot express it.
    if (
        hasRaisedType &&
        event.type === "response.function_call_arguments.done"
    ) {
        if (tool == null) {
            throw new LintError(
                'openai_responses stream response toWire: a "response.function_call_arguments.done" event requires a response.tool_call_delta op with the arguments',
            );
        }
        if (responseId != null || modelName != null) {
            throw unplaceableEnvelopeOps(
                responseId != null,
                modelName != null,
                "response.function_call_arguments.done",
            );
        }
        event.output_index ??= tool.index;
        if (tool.name != null) event.name ??= tool.name;
        event.arguments ??= tool.arguments;
        return event;
    }

    if (sawTextDelta) {
        if (responseId != null || modelName != null) {
            throw unplaceableEnvelopeOps(
                responseId != null,
                modelName != null,
                "response.output_text.delta",
            );
        }
        event.type ??= "response.output_text.delta";
        event.item_id ??= `msg_${crypto.randomUUID().replaceAll("-", "")}`;
        event.output_index ??= textIndex ?? 0;
        event.content_index ??= 0;
        event.delta = text;
        return event;
    }
    if (toolDeltas.length > 0 && (tool!.name != null || tool!.id != null)) {
        if (responseId != null || modelName != null) {
            throw unplaceableEnvelopeOps(
                responseId != null,
                modelName != null,
                "response.output_item.added",
            );
        }
        event.type ??= "response.output_item.added";
        event.output_index ??= tool!.index ?? 0;
        const itemTemplate = asRecord(event.item ?? {}, "stream event.item");
        event.item = {
            ...itemTemplate,
            type: "function_call",
            id:
                itemTemplate.id ??
                event.item_id ??
                `fc_${crypto.randomUUID().replaceAll("-", "")}`,
            call_id:
                tool!.id ??
                itemTemplate.call_id ??
                `call_${crypto.randomUUID().replaceAll("-", "")}`,
            name: tool!.name ?? itemTemplate.name ?? "",
            arguments: tool!.arguments ?? itemTemplate.arguments ?? "",
        };
        return event;
    }
    if (toolDeltas.length > 0) {
        if (responseId != null || modelName != null) {
            throw unplaceableEnvelopeOps(
                responseId != null,
                modelName != null,
                "response.function_call_arguments.delta",
            );
        }
        event.type ??= "response.function_call_arguments.delta";
        event.output_index ??= tool!.index ?? 0;
        event.delta = tool!.arguments ?? "";
        return event;
    }

    event.type ??= terminalEventType(finishReason);
    // Copy before merging: `event.response` holds the object of a
    // body_field op, and lowering writes into no object an input op holds.
    const response: Record<string, unknown> = {
        ...asRecord(event.response ?? {}, "stream event.response"),
    };
    if (responseId != null) response.id ??= responseId;
    if (modelName != null) response.model ??= modelName;
    if (usage || finishReason != null) {
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
    }
    if (Object.keys(response).length > 0) event.response = response;
    return event;
}

// The response id and the model name have a field only on an envelope event's
// `response` object, so they are a named reject everywhere else rather than a
// silent drop.
function unplaceableEnvelopeOps(
    hasId: boolean,
    hasModel: boolean,
    type: string,
): LintError {
    const ops = [
        ...(hasId ? ['"response.id"'] : []),
        ...(hasModel ? ['"llm.model"'] : []),
    ].join(", ");
    return new LintError(
        `openai_responses stream response toWire: ${ops} has no field on a ${JSON.stringify(type)} event`,
    );
}

// A Responses stream has no event that holds a delta and a stop reason, and
// this function returns one event. Writing the delta event alone would drop
// the stop reason, so the program is rejected. toStreamResponses splits such a
// program before it calls this function.
function rejectDeltaWithFinishReason(
    hasDelta: boolean,
    finishReason: string | undefined,
): void {
    if (!hasDelta || finishReason == null) return;
    throw new LintError(
        `openai_responses stream response toWire: the program holds a delta and the stop reason "${finishReason}", which a Responses stream sends as two events; toStreamResponses returns both`,
    );
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
        });
    }
    return program;
}

function streamOutputIndex(
    event: Record<string, unknown>,
): { index: number } | Record<string, never> {
    return event.output_index != null
        ? {
              index: asNumber(event.output_index, "stream event.output_index"),
          }
        : {};
}

function streamOutputItemEvent(
    event: Record<string, unknown>,
    type: string,
): Program {
    const item = asRecord(event.item, "stream event.item");
    // A function_call item raises its `output_index` onto the core
    // `response.tool_call_delta.index`, so the residual carries no copy of it.
    const isFunctionCall = item.type === "function_call";
    const program = streamEventParams(
        event,
        isFunctionCall ? ["item", "output_index"] : ["item"],
    );
    program.push({
        op: "openai_responses.body_field",
        key: "item",
        value: item,
        appliesTo: "response",
    });
    if (!isFunctionCall) return program;
    program.push({
        op: "response.tool_call_delta",
        ...streamOutputIndex(event),
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

// An envelope event carries the whole response object. The id, the model
// name, and a non-null usage raise to core ops; the stop reason is computed
// from the status, `incomplete_details`, and any function-call output item,
// as for a complete response body. Everything else — `object`, `created_at`,
// the `status` itself, the request echo, a null usage — stays in one
// `openai_responses.body_field` keyed `response`, which lowering merges back
// with the core values.
function streamEnvelopeEvent(event: Record<string, unknown>): Program {
    const program = streamEventParams(event, ["response"]);
    const response =
        event.response == null
            ? undefined
            : asRecord(event.response, "stream event.response");
    const responseMeta: Record<string, unknown> =
        response == null ? {} : { ...response };
    if (typeof responseMeta.id === "string") {
        program.push({ op: "response.id", id: responseMeta.id });
        delete responseMeta.id;
    }
    if (typeof responseMeta.model === "string") {
        program.push({
            op: "llm.model",
            model: responseMeta.model,
        });
        delete responseMeta.model;
    }
    if (responseMeta.usage != null) {
        // A non-null usage raises below; `usage: null` has no op, so it stays
        // in the residual and keeps the event exactly as it was.
        delete responseMeta.usage;
    }
    if (Object.keys(responseMeta).length > 0) {
        program.push({
            op: "openai_responses.body_field",
            key: "response",
            value: responseMeta,
            appliesTo: "response",
        });
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
    const output =
        response?.output == null
            ? []
            : asArray(response.output, "stream event.response.output");
    const hasFunctionCall = output
        .map((item) => asRecord(item, "stream event.response.output item"))
        .some((item) => item.type === "function_call");
    const reason = finishReason(
        status,
        incompleteReason,
        status === "completed" && hasFunctionCall,
    );
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

// An assistant message in `input` takes its text as a string: OpenAI's input
// schemas allow only input_* parts in a message list, and an output_text part
// only inside an output message, which requires `id` and `status`.
export function messageItem(
    role: "user" | "assistant",
    text: string,
): WireInputItem {
    return {
        type: "message",
        role,
        content: role === "assistant" ? text : [{ type: "input_text", text }],
    };
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
