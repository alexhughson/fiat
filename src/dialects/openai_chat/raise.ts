// lower IR -> core IR. A pipeline of stages, each raising one kind of
// openai_chat op into core ops; everything a stage doesn't claim passes
// through, so a partially raised program is still a valid program. Extend by
// appending a stage to `raiseStages`, not by editing existing ones. Shared
// between requests and responses — the ops are the same shapes in both
// directions.

import { opData, type Op, type Program, type StopReason } from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import type {
    OpenAIChatMessageMeta,
    WireContentPart,
    WireMessage,
} from "./ops.js";

export const raiseStages: Stage[] = [
    raiseMessages,
    raiseFinishReasons,
    raiseUsage,
];

export const raise: Stage = stagePipeline(raiseStages);

export function raiseMessages(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_chat.message"
            ? raiseMessage(opData<{ message: WireMessage }>(op).message)
            : [op],
    );
}

export function raiseFinishReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_chat.finish_reason"
            ? [
                  {
                      op: "response.stop",
                      reason: raiseFinishReason(
                          opData<{ value: string }>(op).value,
                      ),
                  } as Op,
              ]
            : [op],
    );
}

// Maps the cross-provider counts onto response.usage; any vendor-specific
// fields stay behind as a droppable openai_chat.usage residual.
export function raiseUsage(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "openai_chat.usage") return [op];
        const usageOp = opData<{
            usage: Record<string, unknown>;
            appliesTo?: "request" | "response";
        }>(op);
        const { prompt_tokens, completion_tokens, ...rest } = usageOp.usage;
        const out: Op[] = [
            {
                op: "response.usage",
                ...(prompt_tokens != null
                    ? { inputTokens: prompt_tokens as number }
                    : {}),
                ...(completion_tokens != null
                    ? { outputTokens: completion_tokens as number }
                    : {}),
            },
        ];
        if (Object.keys(rest).length > 0) {
            out.push({
                op: "openai_chat.usage",
                usage: rest,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
            });
        }
        return out;
    });
}

function raiseMessage(message: WireMessage): Op[] {
    const ops: Op[] = [];
    switch (message.role) {
        case "system":
        case "developer":
        case "user":
        case "assistant": {
            const texts = textOps(
                message.role === "developer" ? "system" : message.role,
                message.content,
            );
            const requestMeta = requestMessageMeta(message);
            if (Object.keys(requestMeta).length > 0 && texts.length > 0) {
                // A multi-part developer message raises to several llm.text ops, and
                // lower re-associates meta with the single message op it follows —
                // so the role meta repeats after every text op, not once at the end.
                for (const text of texts) {
                    ops.push(text, {
                        op: "openai_chat.message_meta",
                        message: requestMeta,
                        appliesTo: "request",
                    });
                }
            } else {
                ops.push(...texts);
                if (Object.keys(requestMeta).length > 0) {
                    ops.push({
                        op: "openai_chat.message_meta",
                        message: requestMeta,
                        appliesTo: "request",
                    });
                }
            }
            if (
                message.role === "assistant" &&
                message.content == null &&
                typeof message.refusal === "string"
            ) {
                ops.push({
                    op: "llm.text",
                    role: "assistant",
                    content: message.refusal,
                });
            }
            for (const call of message.tool_calls ?? []) {
                ops.push({
                    op: "llm.tool_call",
                    id: call.id,
                    name: call.function.name,
                    arguments: parseArguments(call.function.arguments, call.id),
                });
            }
            break;
        }
        case "tool": {
            if (!message.tool_call_id)
                throw new Error(
                    "openai_chat tool message: missing tool_call_id",
                );
            ops.push({
                op: "llm.tool_result",
                id: message.tool_call_id,
                content: flattenText(message.content),
            });
            break;
        }
        default:
            throw new LintError(
                `openai_chat message: unsupported role ${JSON.stringify(message.role)}`,
            );
    }
    const meta = responseMessageMeta(message);
    if (Object.keys(meta).length > 0) {
        ops.push({
            op: "openai_chat.message_meta",
            message: meta,
            appliesTo: "response",
        });
    }
    return ops;
}

function textOps(
    role: "system" | "user" | "assistant",
    content: WireMessage["content"],
): Op[] {
    if (content == null) return [];
    if (typeof content === "string") {
        return [{ op: "llm.text", role, content }];
    }
    return content.map((part) => {
        if (part.type !== "text" || typeof part.text !== "string") {
            throw new LintError(
                `openai_chat message: unsupported content part type ${JSON.stringify(part.type)}`,
            );
        }
        return { op: "llm.text", role, content: part.text };
    });
}

function flattenText(content: string | WireContentPart[] | null): string {
    if (content == null) return "";
    if (typeof content === "string") return content;
    return content
        .map((part) => {
            if (part.type !== "text" || typeof part.text !== "string") {
                throw new LintError(
                    `openai_chat tool result: unsupported content part type ${JSON.stringify(part.type)}`,
                );
            }
            return part.text;
        })
        .join("\n");
}

function parseArguments(raw: string, callId: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = raw === "" ? {} : JSON.parse(raw);
    } catch {
        throw new Error(
            `openai_chat tool call ${callId}: arguments are not valid JSON: ${raw}`,
        );
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            `openai_chat tool call ${callId}: arguments must be a JSON object, got ${raw}`,
        );
    }
    return parsed as Record<string, unknown>;
}

const FINISH_REASON_TO_STOP: Record<string, StopReason> = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    content_filter: "content_filter",
};

export function raiseFinishReason(value: string): StopReason {
    const reason = FINISH_REASON_TO_STOP[value];
    if (!reason)
        throw new LintError(
            `openai_chat finish_reason "${value}" has no core stop reason mapping`,
        );
    return reason;
}

export function lowerFinishReason(reason: StopReason): string {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
            return "stop";
        case "max_tokens":
            return "length";
        case "tool_use":
            return "tool_calls";
        case "content_filter":
        case "refusal":
            return "content_filter";
        case "model_context_window_exceeded":
        case "pause_turn":
            throw new LintError(
                `openai_chat stop reason "${reason}" has no finish_reason mapping`,
            );
    }
}

function requestMessageMeta(message: WireMessage): OpenAIChatMessageMeta {
    const meta: OpenAIChatMessageMeta = {};
    if (message.role === "developer") meta.role = "developer";
    return meta;
}

function responseMessageMeta(message: WireMessage): OpenAIChatMessageMeta {
    const meta: OpenAIChatMessageMeta = {};
    if (Object.prototype.hasOwnProperty.call(message, "refusal"))
        meta.refusal = message.refusal;
    if (Object.prototype.hasOwnProperty.call(message, "annotations"))
        meta.annotations = message.annotations;
    if (Object.prototype.hasOwnProperty.call(message, "audio"))
        meta.audio = message.audio;
    if (message.content == null && typeof message.refusal === "string")
        meta.content = null;
    return meta;
}
