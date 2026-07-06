// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import { opData, type Op, type Program, type StopReason } from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import type {
    WireContentPart,
    WireConversationItemCreateEvent,
    WireConversationItem,
    WireFunctionCallItem,
    WireFunctionCallOutputItem,
    WireMessageItem,
    WireOutputItem,
} from "./ops.js";

export const raiseStages: Stage[] = [
    raiseItems,
    raiseOutputs,
    raiseFinishReasons,
    raiseUsage,
];

export const raise: Stage = stagePipeline(raiseStages);

export function raiseItems(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_realtime.item"
            ? raiseRequestEvent(
                  opData<{ event: WireConversationItemCreateEvent }>(op).event,
              )
            : [op],
    );
}

export function raiseOutputs(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_realtime.output"
            ? raiseOutput(opData<{ item: WireOutputItem }>(op).item)
            : [op],
    );
}

export function raiseFinishReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_realtime.finish_reason"
            ? [
                  {
                      op: "response.stop",
                      reason: raiseFinishReason(
                          opData<{ reason: string }>(op).reason,
                      ),
                  } as Op,
              ]
            : [op],
    );
}

// Maps the cross-provider counts onto response.usage; any vendor-specific
// fields stay behind as a droppable residual.
export function raiseUsage(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "openai_realtime.usage") return [op];
        const usageOp = opData<{
            usage: Record<string, unknown>;
            appliesTo?: "request" | "response";
        }>(op);
        const { input_tokens, output_tokens, ...rest } = usageOp.usage;
        const out: Op[] = [
            {
                op: "response.usage",
                ...(input_tokens != null
                    ? { inputTokens: input_tokens as number }
                    : {}),
                ...(output_tokens != null
                    ? { outputTokens: output_tokens as number }
                    : {}),
            },
        ];
        if (Object.keys(rest).length > 0) {
            out.push({
                op: "openai_realtime.usage",
                usage: rest,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
            });
        }
        return out;
    });
}

function raiseItem(item: WireConversationItem): Op[] {
    switch (item.type) {
        case "message":
            return raiseMessage(item);
        case "function_call":
            return [raiseFunctionCall(item)];
        case "function_call_output":
            return [raiseFunctionCallOutput(item)];
        default:
            throw new LintError(
                `openai_realtime item: unsupported item type ${JSON.stringify((item as { type?: string }).type)}`,
            );
    }
}

function raiseRequestEvent(event: WireConversationItemCreateEvent): Op[] {
    const raised = raiseRequestItem(event.item);
    if (raised.length === 0) return [{ op: "openai_realtime.item", event }];
    const required = hasRequiredRequestTemplate(event);
    return required
        ? [
              ...raised,
              {
                  op: "openai_realtime.item_meta",
                  event,
                  appliesTo: "request",
              },
          ]
        : raised;
}

function raiseRequestItem(item: WireConversationItem): Op[] {
    switch (item.type) {
        case "message":
            return raiseMessage(item, false);
        case "function_call":
            return [raiseFunctionCall(item)];
        case "function_call_output":
            return [raiseFunctionCallOutput(item)];
        default:
            return [];
    }
}

function raiseOutput(item: WireOutputItem): Op[] {
    switch (item.type) {
        case "message": {
            const required = hasUnsupportedOutputContent(item);
            return [
                ...raiseMessage({ ...item, role: "assistant" }, false),
                {
                    op: "openai_realtime.output_meta",
                    item: needsOutputTemplate(item)
                        ? item
                        : simpleOutputMeta(item),
                    appliesTo: "response",
                },
            ];
        }
        case "function_call": {
            return [
                raiseFunctionCall(item),
                {
                    op: "openai_realtime.output_meta",
                    item: needsOutputTemplate(item)
                        ? item
                        : simpleOutputMeta(item),
                    appliesTo: "response",
                },
            ];
        }
        default:
            throw new LintError(
                `openai_realtime output: unsupported item type ${JSON.stringify((item as { type?: string }).type)}`,
            );
    }
}

function simpleOutputMeta(item: WireOutputItem): Partial<WireOutputItem> {
    switch (item.type) {
        case "message":
            return {
                type: "message",
                ...(item.id != null ? { id: item.id } : {}),
                ...(item.object != null ? { object: item.object } : {}),
                ...(item.status != null ? { status: item.status } : {}),
            };
        case "function_call":
            return {
                type: "function_call",
                ...(item.call_id != null ? { call_id: item.call_id } : {}),
                ...(item.id != null ? { id: item.id } : {}),
                ...(item.object != null ? { object: item.object } : {}),
                ...(item.status != null ? { status: item.status } : {}),
            };
    }
}

function raiseMessage(item: WireMessageItem, failOnUnsupported = true): Op[] {
    const ops: Op[] = [];
    for (const part of item.content) {
        if (
            (part.type !== "input_text" && part.type !== "output_text") ||
            typeof part.text !== "string"
        ) {
            if (failOnUnsupported) {
                throw new LintError(
                    `openai_realtime message: unsupported content part type ${JSON.stringify(part.type)}`,
                );
            }
            continue;
        }
        ops.push({ op: "llm.text", role: item.role, content: part.text });
    }
    return ops;
}

function raiseFunctionCall(item: WireFunctionCallItem): Op {
    const callId = item.call_id;
    if (!callId)
        throw new Error("openai_realtime function_call item: missing call_id");
    return {
        op: "llm.tool_call",
        id: callId,
        name: item.name,
        arguments: parseArguments(item.arguments, callId),
    };
}

function raiseFunctionCallOutput(item: WireFunctionCallOutputItem): Op {
    return { op: "llm.tool_result", id: item.call_id, content: item.output };
}

function hasRequiredRequestTemplate(
    event: WireConversationItemCreateEvent,
): boolean {
    return (
        hasExtraKeys(event, ["type", "item"]) ||
        hasRequiredItemTemplate(event.item)
    );
}

function needsOutputTemplate(item: WireOutputItem): boolean {
    return hasRequiredItemTemplate(item);
}

function hasUnsupportedOutputContent(item: WireOutputItem): boolean {
    return (
        item.type === "message" &&
        item.content.some((part) => isUnsupportedTextPart(part))
    );
}

function hasRequiredItemTemplate(item: WireConversationItem): boolean {
    switch (item.type) {
        case "message":
            return (
                hasExtraKeys(item, [
                    "type",
                    "role",
                    "content",
                    "id",
                    "object",
                    "status",
                ]) ||
                item.content.length !== 1 ||
                item.content.some(
                    (part) =>
                        isUnsupportedTextPart(part) ||
                        hasExtraKeys(part, ["type", "text"]),
                )
            );
        case "function_call":
            return hasExtraKeys(item, [
                "type",
                "call_id",
                "name",
                "arguments",
                "id",
                "object",
                "status",
            ]);
        case "function_call_output":
            return hasExtraKeys(item, [
                "type",
                "call_id",
                "output",
                "id",
                "object",
                "status",
            ]);
        default:
            return true;
    }
}

function isUnsupportedTextPart(part: WireContentPart): boolean {
    return (
        (part.type !== "input_text" && part.type !== "output_text") ||
        typeof part.text !== "string"
    );
}

function hasExtraKeys(
    record: Record<string, unknown>,
    allowed: string[],
): boolean {
    const allowedSet = new Set(allowed);
    return Object.keys(record).some((key) => !allowedSet.has(key));
}

function parseArguments(raw: string, callId: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = raw === "" ? {} : JSON.parse(raw);
    } catch {
        throw new Error(
            `openai_realtime function call ${callId}: arguments are not valid JSON: ${raw}`,
        );
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            `openai_realtime function call ${callId}: arguments must be a JSON object, got ${raw}`,
        );
    }
    return parsed as Record<string, unknown>;
}

function raiseFinishReason(reason: string): StopReason {
    switch (reason) {
        case "end_turn":
        case "max_tokens":
        case "tool_use":
        case "content_filter":
            return reason;
        default:
            throw new LintError(
                `openai_realtime finish reason "${reason}" has no core stop reason mapping`,
            );
    }
}

export function lowerStopReason(
    reason: StopReason,
): "end_turn" | "max_tokens" | "tool_use" | "content_filter" {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
            return "end_turn";
        case "max_tokens":
            return "max_tokens";
        case "tool_use":
            return "tool_use";
        case "content_filter":
        case "refusal":
            return "content_filter";
        case "pause_turn":
        case "model_context_window_exceeded":
            throw new LintError(
                `openai_realtime response.stop ${reason} has no finish reason mapping`,
            );
    }
}
