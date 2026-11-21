// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import {
    opData,
    type Op,
    type Program,
    type StopReason,
} from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import { base64Source, mediaKindForType } from "../../core/media.js";
import * as reasoning from "../../core/reasoning.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import { asNumber, asRecord, asString } from "../../core/wire.js";
import type { GeminiPartMeta, WireContent, WirePart } from "./ops.js";

export const raiseStages: Stage[] = [
    raiseFinishReasons,
    raiseContents,
    raiseThoughts,
    raiseUsage,
];

export const raise: Stage = stagePipeline(raiseStages);

export const raiseStreamResponseStages: Stage[] = [
    raiseFinishReasons,
    raiseStreamContents,
    raiseUsage,
];

export const raiseStreamResponse: Stage = stagePipeline(
    raiseStreamResponseStages,
);

export function raiseContents(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "gemini.content") return [op];
        const contentOp = opData<{
            content: WireContent;
            appliesTo?: "request" | "response";
        }>(op);
        return raiseContent(contentOp.content, contentOp.appliesTo);
    });
}

// raiseContents writes a `thought: true` part as assistant llm.text followed
// by a gemini.part_meta that holds `thought`. A thought part with fields other
// than thought and thoughtSignature keeps that shape.
export function raiseThoughts(program: Program): Program {
    const nextId = reasoning.reasoningIds();
    const out: Program = [];
    for (let i = 0; i < program.length; i++) {
        const op = program[i]!;
        const next = program[i + 1];
        const meta =
            op.op === "llm.text" && next?.op === "gemini.part_meta"
                ? opData<{ part: GeminiPartMeta }>(next).part
                : undefined;
        const { thought, thoughtSignature, ...rest } = meta?.meta ?? {};
        if (
            meta?.kind !== "text" ||
            thought !== true ||
            Object.keys(rest).length > 0 ||
            (thoughtSignature != null && typeof thoughtSignature !== "string")
        ) {
            out.push(op);
            continue;
        }
        out.push({
            op: "llm.reasoning",
            id: nextId(),
            content: (op as { content: string }).content,
            ...(typeof thoughtSignature === "string"
                ? { signature: { dialect: "gemini", value: thoughtSignature } }
                : {}),
        });
        i++;
    }
    return out;
}

export function raiseStreamContents(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "gemini.content") return [op];
        const contentOp = opData<{
            content: WireContent;
            appliesTo?: "request" | "response";
        }>(op);
        return raiseStreamContent(contentOp.content, contentOp.appliesTo);
    });
}

// Gemini sends finishReason "STOP" also when the candidate asks for a function
// call, so this stage runs before raiseContents and raiseStreamContents, while
// the response candidate's gemini.content still precedes its
// gemini.finish_reason, and reads each value together with the parts next to
// it: a call in request history does not count, and a stream chunk counts only
// its own parts. MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, and
// TOO_MANY_TOOL_CALLS say the model stopped around a tool call, so they raise
// `tool_use` when that content holds a functionCall part, as `STOP` does. A
// value with a core reason of the same meaning raises that reason, and one
// whose core reason does not lower back to it also keeps the exact value in a
// gemini.finish_reason side op that names the new response.stop id under `of`,
// so lowering to Gemini writes the value back. A value no core reason shares
// the meaning of passes through as a residual: Gemini's lowering writes it
// back, and lowering to another dialect warns and drops it, so that
// provider's client reads no stop reason.
export function raiseFinishReasons(program: Program): Program {
    const nextStopId = stopIds();
    let candidateCalls = false;
    const out: Program = [];
    for (const op of program) {
        if (op.op === "gemini.content") {
            if (opData<{ appliesTo?: string }>(op).appliesTo === "response") {
                candidateCalls = opData<{ content: WireContent }>(
                    op,
                ).content.parts.some((part) => part.functionCall != null);
            }
            out.push(op);
            continue;
        }
        if (
            op.op !== "gemini.finish_reason" ||
            opData<{ of?: string }>(op).of != null
        ) {
            out.push(op);
            continue;
        }
        const value = opData<{ value: string }>(op).value;
        const reason = finishReasonToStop(value, candidateCalls);
        candidateCalls = false;
        if (reason == null) {
            out.push(op);
            continue;
        }
        if (lowerFinishReason(reason) === value) {
            out.push({ op: "response.stop", reason } as Op);
            continue;
        }
        const id = nextStopId();
        out.push({ op: "response.stop", reason, id } as Op);
        out.push({
            op: "gemini.finish_reason",
            value,
            of: id,
            appliesTo: "response",
        } as Op);
    }
    return out;
}

// Ids restart on every raise call; a side op belongs to the nearest earlier
// response.stop with the id it names in `of`.
function stopIds(): () => string {
    let count = 0;
    return () => `stop_${++count}`;
}

// Maps the cross-provider counts onto response.usage; any vendor-specific
// fields stay behind as a droppable residual.
export function raiseUsage(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "gemini.usage") return [op];
        const usageOp = opData<{
            usage: Record<string, unknown>;
            appliesTo?: "request" | "response";
        }>(op);
        const { promptTokenCount, candidatesTokenCount, ...rest } =
            usageOp.usage;
        const out: Op[] = [
            {
                op: "response.usage",
                ...(promptTokenCount != null
                    ? {
                          inputTokens: asNumber(
                              promptTokenCount,
                              "usageMetadata.promptTokenCount",
                          ),
                      }
                    : {}),
                ...(candidatesTokenCount != null
                    ? {
                          outputTokens: asNumber(
                              candidatesTokenCount,
                              "usageMetadata.candidatesTokenCount",
                          ),
                      }
                    : {}),
            },
        ];
        if (Object.keys(rest).length > 0) {
            out.push({
                op: "gemini.usage",
                usage: rest,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
            });
        }
        return out;
    });
}

function raiseContent(
    content: WireContent,
    appliesTo?: "request" | "response",
): Op[] {
    const role = content.role;
    if (role == null && appliesTo !== "response") {
        return [{ op: "gemini.content", content }];
    }
    if (role !== "user" && role !== "model") {
        throw new LintError(
            `gemini content: unsupported role ${JSON.stringify(role)}`,
        );
    }

    const coreRole = role === "model" ? "assistant" : "user";
    const out: Op[] = [];
    content.parts.forEach((part, index) => {
        const media = mediaPart(part, coreRole, appliesTo);
        if (media) {
            out.push(media);
            return;
        }
        const kind = partKind(part, appliesTo);
        if (!kind) {
            out.push({
                op: "gemini.content",
                content: { role, parts: [part] },
                ...(appliesTo ? { appliesTo } : {}),
                ...(isMediaLikePart(part) ? { preservesContent: true } : {}),
            });
            return;
        }
        switch (kind) {
            case "text": {
                out.push({
                    op: "llm.text",
                    role: coreRole,
                    content: asString(part.text, "gemini part.text"),
                });
                pushPartMeta(out, part, { kind, index }, appliesTo);
                break;
            }
            case "functionCall": {
                if (role !== "model")
                    throw new LintError(
                        'gemini functionCall part: expected role "model"',
                    );
                const call = asRecord(part.functionCall, "gemini functionCall");
                assertOnlyKeys(
                    call,
                    ["name", "args", "id"],
                    "gemini functionCall",
                );
                const id =
                    call.id == null
                        ? `gemini_call_${index}`
                        : asString(call.id, "gemini functionCall.id");
                out.push({
                    op: "llm.tool_call",
                    id,
                    name: asString(call.name, "gemini functionCall.name"),
                    arguments:
                        call.args == null
                            ? {}
                            : asRecord(call.args, "gemini functionCall.args"),
                });
                pushPartMeta(
                    out,
                    part,
                    {
                        kind,
                        index,
                        id,
                        ...(call.id == null ? { idSource: "synthesized" } : {}),
                    },
                    appliesTo,
                );
                break;
            }
            case "functionResponse": {
                if (role !== "user")
                    throw new LintError(
                        'gemini functionResponse part: expected role "user"',
                    );
                const response = asRecord(
                    part.functionResponse,
                    "gemini functionResponse",
                );
                assertOnlyKeys(
                    response,
                    ["name", "response", "id"],
                    "gemini functionResponse",
                );
                const id = asString(response.id, "gemini functionResponse.id");
                const name = asString(
                    response.name,
                    "gemini functionResponse.name",
                );
                const responseBody =
                    response.response == null
                        ? undefined
                        : asRecord(
                              response.response,
                              "gemini functionResponse.response",
                          );
                out.push({
                    op: "llm.tool_result",
                    id,
                    content:
                        responseBody == null
                            ? "{}"
                            : toolResultContent(responseBody),
                });
                // Only the function name stays in the dialect op, with the
                // tool result's id under `of` so lowering can find the
                // result whatever sits between the two ops — unless a
                // second result reuses the id, in which case each part_meta
                // must sit after its own result and before the next result
                // with that id. The call id lives in the llm.tool_result,
                // and lowering rebuilds the response object from its
                // content.
                pushPartMeta(out, part, { kind, of: id, name }, appliesTo);
                break;
            }
        }
    });
    return out;
}

function mediaPart(
    part: WirePart,
    role: "user" | "assistant",
    appliesTo?: "request" | "response",
): Op | undefined {
    if (appliesTo === "response") return undefined;
    // Gemini's reference names these fields `inlineData` and `mimeType`, and
    // its curl examples write `inline_data` and `mime_type`. Proto3 JSON
    // parsing accepts either name for each field on its own.
    const key = part.inline_data != null ? "inline_data" : "inlineData";
    const inlineData = part[key];
    if (
        typeof inlineData !== "object" ||
        inlineData === null ||
        Array.isArray(inlineData)
    ) {
        return undefined;
    }
    if (role !== "user") return undefined;
    const data = inlineData as Record<string, unknown>;
    const mimeKey =
        data.mime_type != null
            ? "mime_type"
            : data.mimeType != null || key === "inlineData"
              ? "mimeType"
              : "mime_type";
    const mediaType = asString(data[mimeKey], `gemini ${key}.${mimeKey}`);
    const kind = mediaKindForType(mediaType);
    if (!kind) return undefined;
    // Gemini's Part sets one member of a union that holds the inline and file
    // keys, text, and function calls, so a part with two of them is ambiguous.
    const conflicts = [
        key === "inline_data" ? "inlineData" : "inline_data",
        "file_data",
        "fileData",
        "text",
        "functionCall",
        "functionResponse",
    ].filter((field) => part[field] != null);
    if (conflicts.length > 0) {
        throw new LintError(
            `gemini inline media part: unsupported fields ${conflicts.join(", ")}`,
        );
    }
    // A part or blob with other fields, such as `videoMetadata` or
    // `mediaResolution`, stays a gemini.content residual.
    if (!hasOnlyKeys(data, [mimeKey, "data"]) || !hasOnlyKeys(part, [key])) {
        return undefined;
    }
    const source = base64Source(
        mediaType,
        asString(data.data, `gemini ${key}.data`),
        kind,
        `gemini ${key}`,
    );
    switch (kind) {
        case "image":
            return { op: "llm.image", role: "user", source };
        case "audio":
            return { op: "llm.audio", role: "user", source };
        case "document":
            return { op: "llm.document", role: "user", source };
        case "video":
            return { op: "llm.video", role: "user", source };
    }
}

function isMediaLikePart(part: WirePart): boolean {
    return (
        part.inline_data != null ||
        part.inlineData != null ||
        part.file_data != null ||
        part.fileData != null
    );
}

function raiseStreamContent(
    content: WireContent,
    appliesTo?: "request" | "response",
): Op[] {
    const role = content.role;
    if (role !== "model") {
        throw new LintError(
            `gemini stream content: expected role "model", got ${JSON.stringify(role)}`,
        );
    }

    const out: Op[] = [];
    content.parts.forEach((part, index) => {
        const kind = partKind(part, appliesTo);
        switch (kind) {
            case "text":
                out.push({
                    op: "response.text_delta",
                    role: "assistant",
                    content: asString(part.text, "gemini part.text"),
                });
                pushPartMeta(out, part, { kind, index }, appliesTo);
                break;
            case "functionCall": {
                const call = asRecord(part.functionCall, "gemini functionCall");
                assertOnlyKeys(
                    call,
                    ["name", "args", "id"],
                    "gemini functionCall",
                );
                out.push({
                    op: "response.tool_call_delta",
                    index,
                    ...(call.id == null
                        ? {}
                        : { id: asString(call.id, "gemini functionCall.id") }),
                    name: asString(call.name, "gemini functionCall.name"),
                    arguments: JSON.stringify(
                        call.args == null
                            ? {}
                            : asRecord(call.args, "gemini functionCall.args"),
                    ),
                });
                pushPartMeta(
                    out,
                    part,
                    {
                        kind,
                        index,
                        ...(call.id == null
                            ? {}
                            : {
                                  id: asString(
                                      call.id,
                                      "gemini functionCall.id",
                                  ),
                              }),
                    },
                    appliesTo,
                );
                break;
            }
            case "functionResponse":
                throw new LintError(
                    "gemini stream functionResponse part has no response stream mapping",
                );
            case undefined:
                throw new LintError(
                    "gemini stream response part: unsupported native part without a core mapping",
                );
        }
    });
    return out;
}

function partKind(
    part: WirePart,
    appliesTo?: "request" | "response",
): GeminiPartMeta["kind"] | undefined {
    const kinds = ["text", "functionCall", "functionResponse"].filter(
        (key) => part[key] != null,
    );
    if (kinds.length === 0) {
        if (appliesTo === "response") {
            throw new LintError(
                "gemini response part: unsupported native part without a core mapping",
            );
        }
        return undefined;
    }
    if (kinds.length !== 1) {
        throw new LintError(
            `gemini part: expected exactly one known part field, got ${JSON.stringify(kinds)}`,
        );
    }
    return kinds[0] as GeminiPartMeta["kind"];
}

// Gemini requires functionResponse.response to be a JSON object, so lowering
// wraps tool result text that is not a JSON object under the "output" key,
// which Gemini's docs name for function output. A response body whose only
// key is "output" raises back to the wrapped value: a string as text,
// anything else as JSON.
function toolResultContent(responseBody: Record<string, unknown>): string {
    const keys = Object.keys(responseBody);
    if (keys.length !== 1 || keys[0] !== "output") {
        return JSON.stringify(responseBody);
    }
    const value = responseBody.output;
    return typeof value === "string" ? value : JSON.stringify(value);
}

function pushPartMeta(
    out: Op[],
    part: WirePart,
    base: GeminiPartMeta,
    appliesTo?: "request" | "response",
): void {
    const meta = partExtras(part);
    const hasIdSource = base.kind === "functionCall" && base.idSource != null;
    if (
        Object.keys(meta).length > 0 ||
        base.kind === "functionResponse" ||
        hasIdSource
    ) {
        out.push({
            op: "gemini.part_meta",
            part: {
                ...base,
                ...(Object.keys(meta).length > 0 ? { meta } : {}),
            },
        });
    }
}

function partExtras(part: WirePart): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(part)) {
        if (
            key !== "text" &&
            key !== "functionCall" &&
            key !== "functionResponse"
        )
            extras[key] = value;
    }
    return extras;
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

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

// Every finishReason value a core reason shares the meaning of. STOP,
// MAX_TOKENS, and SAFETY lower back to their own value, so they raise without
// a side op. A value missing here has no core reason of the same meaning: it
// stays in its gemini.finish_reason op instead of borrowing a nearby reason.
const FINISH_REASON_TO_STOP: Record<string, StopReason> = {
    STOP: "end_turn",
    MAX_TOKENS: "max_tokens",
    // The content the model generated was flagged by a filter: the shared
    // reason is content_filter, which OpenAI writes as
    // incomplete_details.reason and Anthropic as stop_reason "refusal".
    SAFETY: "content_filter",
    RECITATION: "content_filter",
    LANGUAGE: "content_filter",
    BLOCKLIST: "content_filter",
    PROHIBITED_CONTENT: "content_filter",
    SPII: "content_filter",
    IMAGE_SAFETY: "content_filter",
    IMAGE_PROHIBITED_CONTENT: "content_filter",
    IMAGE_RECITATION: "content_filter",
    ESCALATION: "content_filter",
    // The response reached the per-request token limit, continuable with the
    // continuation token the candidate_meta residual carries.
    CONTINUATION: "max_tokens",
};

const TOOL_CALL_FINISH_REASONS = new Set([
    "STOP",
    "MALFORMED_FUNCTION_CALL",
    "UNEXPECTED_TOOL_CALL",
    "TOO_MANY_TOOL_CALLS",
]);

function finishReasonToStop(
    value: string,
    candidateCalls: boolean,
): StopReason | undefined {
    if (candidateCalls && TOOL_CALL_FINISH_REASONS.has(value))
        return "tool_use";
    return FINISH_REASON_TO_STOP[value];
}

export function lowerFinishReason(reason: StopReason): string {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
        case "tool_use":
            return "STOP";
        case "max_tokens":
            return "MAX_TOKENS";
        case "content_filter":
        case "refusal":
            return "SAFETY";
        case "pause_turn":
        case "model_context_window_exceeded":
            throw new LintError(
                `gemini response.stop ${reason} has no finishReason mapping`,
            );
    }
}
