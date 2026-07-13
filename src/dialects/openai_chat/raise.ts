// lower IR -> core IR. A pipeline of stages, each raising one kind of
// openai_chat op into core ops; everything a stage doesn't claim passes
// through, so a partially raised program is still a valid program. Extend by
// appending a stage to `raiseStages`, not by editing existing ones. Shared
// between requests and responses — the ops are the same shapes in both
// directions.

import {
    opData,
    type Op,
    type Program,
    type StopReason,
} from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import {
    base64Source,
    documentSourceFromUrl,
    imageSourceFromUrl,
} from "../../core/media.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import { asNumber, asRecord } from "../../core/wire.js";
import type {
    OpenAIChatMessageMeta,
    WireContentPart,
    WireMessage,
} from "./ops.js";

export const raiseStages: Stage[] = [
    raiseMessages,
    raiseFinishReasons,
    raiseUsage,
    raiseResponseIds,
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
        const usage = { ...usageOp.usage };
        const prompt_tokens = usage.prompt_tokens;
        const completion_tokens = usage.completion_tokens;
        delete usage.prompt_tokens;
        delete usage.completion_tokens;

        let cacheReadTokens: number | undefined;
        if (usage.prompt_tokens_details != null) {
            const details = asRecord(
                usage.prompt_tokens_details,
                "usage.prompt_tokens_details",
            );
            if (details.cached_tokens != null) {
                cacheReadTokens = asNumber(
                    details.cached_tokens,
                    "usage.prompt_tokens_details.cached_tokens",
                );
            }
            const { cached_tokens: _cached, ...detailRest } = details;
            if (Object.keys(detailRest).length > 0) {
                usage.prompt_tokens_details = detailRest;
            } else {
                delete usage.prompt_tokens_details;
            }
        }

        const out: Op[] = [
            {
                op: "response.usage",
                ...(prompt_tokens != null
                    ? { inputTokens: prompt_tokens as number }
                    : {}),
                ...(completion_tokens != null
                    ? { outputTokens: completion_tokens as number }
                    : {}),
                ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
            },
        ];
        if (Object.keys(usage).length > 0) {
            out.push({
                op: "openai_chat.usage",
                usage,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
            });
        }
        return out;
    });
}

export function raiseResponseIds(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "openai_chat.body_field") return [op];
        const field = opData<{
            key: string;
            value: unknown;
            appliesTo?: "request" | "response";
        }>(op);
        if (field.key === "id" && typeof field.value === "string") {
            return [{ op: "response.id", id: field.value }];
        }
        return [op];
    });
}

function raiseMessage(message: WireMessage): Op[] {
    if (hasUnportableContentPart(message.content)) {
        return [
            {
                op: "openai_chat.message",
                message,
                preservesContent: true,
                appliesTo: "request",
            },
        ];
    }
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
        switch (part.type) {
            case "text":
                if (typeof part.text !== "string") {
                    throw new LintError(
                        "openai_chat message text part: missing text",
                    );
                }
                return { op: "llm.text", role, content: part.text };
            case "image_url":
                return raiseImagePart(role, part);
            case "input_audio":
                return raiseAudioPart(role, part);
            case "file":
                return raiseFilePart(role, part);
            default:
                throw new LintError(
                    `openai_chat message: unsupported content part type ${JSON.stringify(part.type)}`,
                );
        }
    });
}

function hasUnportableContentPart(content: WireMessage["content"]): boolean {
    return (
        Array.isArray(content) &&
        content.some(
            (part) =>
                (part.type === "file" &&
                    typeof part.file?.file_id === "string") ||
                (part.type === "file" &&
                    typeof part.file?.file_data !== "string") ||
                (part.type === "input_audio" &&
                    typeof part.input_audio?.data !== "string"),
        )
    );
}

function raiseImagePart(
    role: "system" | "user" | "assistant",
    part: WireContentPart,
): Op {
    if (role !== "user") {
        throw new LintError(
            `openai_chat image_url part: unsupported role ${JSON.stringify(role)}`,
        );
    }
    assertOnlyKeys(part, ["type", "image_url"], "openai_chat image_url part");
    const image = part.image_url;
    if (!image || typeof image !== "object" || Array.isArray(image)) {
        throw new LintError("openai_chat image_url part: missing image_url");
    }
    assertOnlyKeys(image, ["url"], "openai_chat image_url");
    if (typeof image.url !== "string") {
        throw new LintError("openai_chat image_url.url: expected a string");
    }
    return {
        op: "llm.image",
        role: "user",
        source: imageSourceFromUrl(image.url, "openai_chat image_url.url"),
    };
}

function raiseAudioPart(
    role: "system" | "user" | "assistant",
    part: WireContentPart,
): Op {
    if (role !== "user") {
        throw new LintError(
            `openai_chat input_audio part: unsupported role ${JSON.stringify(role)}`,
        );
    }
    assertOnlyKeys(part, ["type", "input_audio"], "openai_chat input_audio part");
    const audio = part.input_audio;
    if (!audio || typeof audio !== "object" || Array.isArray(audio)) {
        throw new LintError("openai_chat input_audio part: missing input_audio");
    }
    assertOnlyKeys(audio, ["data", "format"], "openai_chat input_audio");
    if (typeof audio.data !== "string") {
        throw new LintError("openai_chat input_audio.data: expected a string");
    }
    const mediaType = openAIChatAudioMediaType(audio.format);
    return {
        op: "llm.audio",
        role: "user",
        source: base64Source(
            mediaType,
            audio.data,
            "audio",
            "openai_chat input_audio",
        ),
    };
}

function raiseFilePart(
    role: "system" | "user" | "assistant",
    part: WireContentPart,
): Op {
    if (role !== "user") {
        throw new LintError(
            `openai_chat file part: unsupported role ${JSON.stringify(role)}`,
        );
    }
    assertOnlyKeys(part, ["type", "file"], "openai_chat file part");
    const file = part.file;
    if (!file || typeof file !== "object" || Array.isArray(file)) {
        throw new LintError("openai_chat file part: missing file");
    }
    assertOnlyKeys(file, ["filename", "file_data"], "openai_chat file");
    if (typeof file.file_data !== "string") {
        throw new LintError("openai_chat file.file_data: expected a string");
    }
    const source = documentSourceFromUrl(file.file_data, "openai_chat file.file_data");
    return {
        op: "llm.document",
        role: "user",
        source:
            source.type === "base64"
                ? { ...source, filename: stringOrUndefined(file.filename) }
                : source,
    };
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

function openAIChatAudioMediaType(format: unknown): string {
    switch (format) {
        case "wav":
            return "audio/wav";
        case "mp3":
            return "audio/mp3";
        default:
            throw new LintError(
                `openai_chat input_audio.format: unsupported format ${JSON.stringify(format)}`,
            );
    }
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function assertOnlyKeys(
    value: Record<string, unknown>,
    keys: string[],
    what: string,
): void {
    const allowed = new Set(keys);
    const extra = Object.keys(value).filter((key) => !allowed.has(key));
    if (extra.length > 0)
        throw new LintError(`${what}: unsupported fields ${extra.join(", ")}`);
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
