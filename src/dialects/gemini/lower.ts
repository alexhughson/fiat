// core IR -> lower IR, as pipelines of stages. Per-op stages lower each core
// op to a single-part gemini.content op; mergeAdjacentContents then folds
// consecutive same-role contents into one part list (the wire alternates
// user/model turns). System text stays a core op — requestToWire serializes
// it into systemInstruction. Extend by appending to the stage arrays.

import { opData, type Op, type OpOf, type Program } from "../../core/ops.js";
import { LintError, lintOrWarn } from "../../core/lint.js";
import {
    assertAudioSource,
    assertDocumentSource,
    assertImageMediaType,
    assertVideoSource,
} from "../../core/media.js";
import type { Target } from "../../core/rewrite.js";
import { firstOp } from "../../core/program.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import { lowerFinishReason } from "./raise.js";
import type { GeminiPartMeta, WireContent, WirePart } from "./ops.js";

interface ResponsePartMeta {
    meta?: Record<string, unknown>;
    omitFunctionCallId?: boolean;
}

export const lowerRequestStages: Stage[] = [
    lintMidConversationSystem,
    lowerThinking,
    lowerStructuredOutput,
    lowerToolResults,
    lowerRequestTexts,
    lowerRequestImages,
    lowerRequestAudio,
    lowerRequestDocuments,
    lowerRequestVideos,
    lowerToolCalls,
    applyRequestPartMeta,
    mergeAdjacentContents,
];

export const lowerRequest: Stage = stagePipeline(lowerRequestStages);

export const lowerResponseStages: Stage[] = [
    lowerStopReasons,
    lowerUsageCounts,
    lowerResponseIds,
    collectModelContent,
];

export const lowerResponse: Stage = stagePipeline(lowerResponseStages);

export const lowerStreamResponseStages: Stage[] = [
    lowerStopReasons,
    lowerUsageCounts,
    lowerResponseIds,
    collectStreamModelContent,
];

export const lowerStreamResponse: Stage = stagePipeline(
    lowerStreamResponseStages,
);

// System text lowers into systemInstruction, which would silently reorder it
// ahead of the conversation — so a system op after the conversation has
// started is an error, not a hoist.
export function lintMidConversationSystem(program: Program): Program {
    let sawConversation = false;
    for (const op of program) {
        switch (op.op) {
            case "llm.text":
                if ((op as OpOf<"llm.text">).role === "system") {
                    if (sawConversation)
                        throw new LintError(
                            "gemini request lower: system text after contents cannot be hoisted",
                        );
                } else {
                    sawConversation = true;
                }
                break;
            case "llm.tool_call":
            case "llm.tool_result":
            case "llm.image":
            case "llm.audio":
            case "llm.document":
            case "llm.video":
            case "gemini.content":
                sawConversation = true;
                break;
        }
    }
    return program;
}

// Model-free: this only recognizes that thinking was requested and carries
// the effort forward as gemini.thinking. Everything about which models
// support thinkingLevel vs. thinkingBudget, the budget table, and the
// xhigh/max clamp lives in legalize.ts's gemini.thinking legalization, which
// runs after this (and after any llm.model rewriting the caller does via the
// afterLower hook).
export function lowerThinking(program: Program, target?: Target): Program {
    const thinkingOps = program.filter((op) => op.op === "llm.thinking");
    if (thinkingOps.length === 0) return program;
    if (thinkingOps.length > 1) {
        lintOrWarn(
            target?.strict,
            "gemini request lower: expected at most one llm.thinking op",
        );
    }

    const model = firstOp(program, "llm.model")?.model;
    if (!model) {
        lintOrWarn(
            target?.strict,
            "gemini request lower: llm.thinking requires llm.model",
        );
        return program.filter((op) => op.op !== "llm.thinking");
    }
    const thinking = thinkingOps[0] as OpOf<"llm.thinking">;
    let replaced = false;
    return program.flatMap((op) => {
        if (op.op !== "llm.thinking") return [op];
        if (replaced) return [];
        replaced = true;
        return [{ op: "gemini.thinking", effort: thinking.effort } as Op];
    });
}

export function lowerStructuredOutput(program: Program): Program {
    let output: OpOf<"llm.output"> | undefined;
    const generationConfigIndexes: number[] = [];
    const out: Program = [];

    for (const op of program) {
        if (op.op === "llm.output") {
            if (output) {
                throw new LintError(
                    "gemini request lower: expected at most one llm.output op",
                );
            }
            output = op as OpOf<"llm.output">;
            continue;
        }
        if (op.op === "gemini.generation_config") {
            generationConfigIndexes.push(out.length);
        }
        out.push(op);
    }

    if (!output) return program;

    const structuredOutputConfig = {
        responseMimeType: "application/json",
        responseSchema: output.schema,
    };
    if (generationConfigIndexes.length === 0) {
        out.push({
            op: "gemini.generation_config",
            value: structuredOutputConfig,
        });
        return out;
    }

    for (const index of generationConfigIndexes) {
        const existing = opData<{ value: unknown }>(out[index]!).value;
        if (!isRecord(existing)) {
            throw new LintError(
                "gemini request lower: generationConfig must be an object to merge llm.output",
            );
        }
        if ("responseMimeType" in existing || "responseSchema" in existing) {
            throw new LintError(
                "gemini request lower: llm.output conflicts with existing generationConfig.responseMimeType or responseSchema",
            );
        }
    }

    const lastIndex =
        generationConfigIndexes[generationConfigIndexes.length - 1]!;
    const last = out[lastIndex]!;
    out[lastIndex] = {
        ...last,
        value: {
            ...opData<{ value: Record<string, unknown> }>(last).value,
            ...structuredOutputConfig,
        },
    };
    return out;
}

// functionResponse needs the tool's name, which the core op doesn't carry —
// it comes from the matching llm.tool_call earlier in the program, or from a
// gemini.part_meta residual when the program was raised from gemini wire.
// Whole-program stage for that reason; it also consumes (deletes) the
// functionResponse part_meta residuals it reads. Runs before lowerToolCalls
// so the llm.tool_call ops it scans for names are still present.
export function lowerToolResults(program: Program): Program {
    const metaById = new Map<string, GeminiPartMeta>();
    const callNames = new Map<string, string>();
    for (const op of program) {
        if (op.op === "llm.tool_call") {
            const call = op as OpOf<"llm.tool_call">;
            callNames.set(call.id, call.name);
        }
        if (op.op === "gemini.part_meta") {
            const meta = opData<{ part: GeminiPartMeta }>(op).part;
            if (meta.kind === "functionResponse" && meta.id)
                metaById.set(meta.id, meta);
        }
    }

    return program.flatMap((op) => {
        if (op.op === "gemini.part_meta") {
            return opData<{ part: GeminiPartMeta }>(op).part.kind ===
                "functionResponse"
                ? []
                : [op];
        }
        if (op.op !== "llm.tool_result") return [op];
        const result = op as OpOf<"llm.tool_result">;
        const meta = metaById.get(result.id);
        const name = meta?.name ?? callNames.get(result.id);
        if (!name) {
            throw new LintError(
                `gemini tool_result ${result.id}: cannot serialize without a functionResponse.name`,
            );
        }
        const response = meta?.response ?? parseToolResultObject(result);
        return [
            contentOp("user", {
                functionResponse: { name, response, id: result.id },
            }),
        ];
    });
}

export function lowerRequestTexts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.text") return [op];
        const text = op as OpOf<"llm.text">;
        if (text.role === "system") return [op];
        return [
            contentOp(text.role === "assistant" ? "model" : "user", {
                text: text.content,
            }),
        ];
    });
}

export function lowerRequestImages(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.image") return [op];
        const image = op as OpOf<"llm.image">;
        if (image.role !== "user") {
            throw new LintError(
                `gemini request lower: unsupported image role ${JSON.stringify(image.role)}`,
            );
        }
        if (image.source.type !== "base64") {
            throw new LintError(
                "gemini request lower: llm.image URL sources require provider file upload before generateContent",
            );
        }
        assertImageMediaType(
            image.source.mediaType,
            "gemini request lower llm.image",
        );
        return [
            contentOp("user", {
                inline_data: {
                    mime_type: image.source.mediaType,
                    data: image.source.data,
                },
            }),
        ];
    });
}

export function lowerRequestAudio(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.audio") return [op];
        const audio = op as OpOf<"llm.audio">;
        assertAudioSource(audio.source, "gemini request lower llm.audio");
        return [
            contentOp("user", {
                inline_data: {
                    mime_type: audio.source.mediaType,
                    data: audio.source.data,
                },
            }),
        ];
    });
}

export function lowerRequestDocuments(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.document") return [op];
        const document = op as OpOf<"llm.document">;
        assertDocumentSource(document.source, "gemini request lower llm.document");
        if (document.source.type !== "base64") {
            throw new LintError(
                "gemini request lower: llm.document URL sources require provider file upload before generateContent",
            );
        }
        return [
            contentOp("user", {
                inline_data: {
                    mime_type: document.source.mediaType,
                    data: document.source.data,
                },
            }),
        ];
    });
}

export function lowerRequestVideos(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.video") return [op];
        const video = op as OpOf<"llm.video">;
        assertVideoSource(video.source, "gemini request lower llm.video");
        return [
            contentOp("user", {
                inline_data: {
                    mime_type: video.source.mediaType,
                    data: video.source.data,
                },
            }),
        ];
    });
}

export function lowerToolCalls(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_call") return [op];
        const call = op as OpOf<"llm.tool_call">;
        return [
            contentOp("model", {
                functionCall: {
                    name: call.name,
                    args: call.arguments,
                    id: call.id,
                },
            }),
        ];
    });
}

const INJECTED_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// Gemini 3 thinking models require thoughtSignature on the first functionCall in
// each step of the current turn — from the last user text message through the
// tool loop. Round-tripped Gemini responses carry the real signature in
// gemini.part_meta; core-originated or cross-provider history does not, so we
// inject Google's documented dummy bypass. Older turns are not validated. See:
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
export function applyRequestPartMeta(program: Program): Program {
    return injectCurrentTurnThoughtSignatures(reapplyAdjacentPartMeta(program));
}

function reapplyAdjacentPartMeta(program: Program): Program {
    const out: Program = [];
    let attachable: { outIndex: number; partIndex: number } | undefined;

    for (const op of program) {
        if (op.op === "gemini.content") {
            out.push(op);
            const content = opData<{ content: WireContent }>(op).content;
            const partIndex = content.parts.length - 1;
            attachable =
                partIndex >= 0 && wirePartKind(content.parts[partIndex]!)
                    ? { outIndex: out.length - 1, partIndex }
                    : undefined;
            continue;
        }

        if (op.op === "gemini.part_meta") {
            const meta = opData<{ part: GeminiPartMeta }>(op).part;
            if (meta.kind === "functionResponse") {
                throw new LintError(
                    "gemini request lower: unconsumed functionResponse part_meta",
                );
            }
            if (!partMetaHasWireEffect(meta)) {
                attachable = undefined;
                continue;
            }
            if (!attachable) {
                throw new LintError(
                    `gemini request lower: cannot reapply ${meta.kind} part_meta without an adjacent lowered part`,
                );
            }
            const contentOp = out[attachable.outIndex]!;
            const content = opData<{ content: WireContent }>(contentOp).content;
            const part = content.parts[attachable.partIndex]!;
            const kind = wirePartKind(part);
            if (kind !== meta.kind) {
                throw new LintError(
                    `gemini request lower: cannot apply ${meta.kind} part_meta to ${kind ?? "native"} part`,
                );
            }
            assertPartMetaMatchesPart(meta, part);
            out[attachable.outIndex] = {
                ...contentOp,
                content: {
                    ...content,
                    parts: content.parts.map((existing, index) =>
                        index === attachable!.partIndex
                            ? applyPartMeta(existing, meta)
                            : existing,
                    ),
                },
            } as Op;
            attachable = undefined;
            continue;
        }

        out.push(op);
        attachable = undefined;
    }

    return out;
}

function injectCurrentTurnThoughtSignatures(program: Program): Program {
    const contents = program.flatMap((op, opIndex) =>
        op.op === "gemini.content"
            ? [
                  {
                      opIndex,
                      content: opData<{ content: WireContent }>(op).content,
                  },
              ]
            : [],
    );
    if (contents.length === 0) return program;

    let turnFrom = 0;
    for (let index = 0; index < contents.length; index++) {
        const { content } = contents[index]!;
        if (
            content.role === "user" &&
            content.parts.some((part) => part.text != null)
        ) {
            turnFrom = index;
        }
    }

    const patches = new Map<number, number>();
    for (let index = turnFrom; index < contents.length; index++) {
        const { opIndex, content } = contents[index]!;
        if (content.role !== "model") continue;
        const partIndex = content.parts.findIndex(
            (part) => part.functionCall != null,
        );
        if (partIndex < 0) continue;
        if (typeof content.parts[partIndex]!.thoughtSignature === "string")
            continue;
        patches.set(opIndex, partIndex);
    }
    if (patches.size === 0) return program;

    return program.map((op, opIndex) => {
        const partIndex = patches.get(opIndex);
        if (partIndex == null) return op;
        const content = opData<{ content: WireContent }>(op).content;
        return {
            ...op,
            content: {
                ...content,
                parts: content.parts.map((part, index) =>
                    index === partIndex
                        ? {
                              ...part,
                              thoughtSignature: INJECTED_THOUGHT_SIGNATURE,
                          }
                        : part,
                ),
            },
        } as Op;
    });
}

// Adjacent-only on purpose: an op between two same-role contents (a config
// residual, a system op) keeps them separate contents. Merging builds a new
// op — the previous one may be a caller-owned residual, and mutating it
// would corrupt the caller's program (and compound on repeated lowering).
export function mergeAdjacentContents(program: Program): Program {
    const out: Program = [];
    for (const op of program) {
        const content =
            op.op === "gemini.content"
                ? opData<{ content: WireContent }>(op).content
                : undefined;
        const previous = out[out.length - 1];
        const previousContent =
            previous?.op === "gemini.content"
                ? opData<{ content: WireContent }>(previous).content
                : undefined;
        if (
            content &&
            previousContent &&
            content.role === previousContent.role
        ) {
            out[out.length - 1] = {
                ...previous,
                content: {
                    ...previousContent,
                    parts: [...previousContent.parts, ...content.parts],
                },
            } as Op;
            continue;
        }
        out.push(op);
    }
    return out;
}

export function lowerStopReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "response.stop"
            ? [
                  {
                      op: "gemini.finish_reason",
                      value: lowerFinishReason(
                          (op as OpOf<"response.stop">).reason,
                      ),
                  } as Op,
              ]
            : [op],
    );
}

export function lowerUsageCounts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "response.usage") return [op];
        const counts = op as OpOf<"response.usage">;
        return [
            {
                op: "gemini.usage",
                usage: {
                    ...(counts.inputTokens != null
                        ? { promptTokenCount: counts.inputTokens }
                        : {}),
                    ...(counts.outputTokens != null
                        ? { candidatesTokenCount: counts.outputTokens }
                        : {}),
                    ...(counts.cacheReadTokens != null
                        ? { cachedContentTokenCount: counts.cacheReadTokens }
                        : {}),
                },
            },
        ];
    });
}

export function lowerResponseIds(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "response.id") return [op];
        return [
            {
                op: "gemini.body_field",
                key: "responseId",
                value: (op as OpOf<"response.id">).id,
                appliesTo: "response",
            },
        ];
    });
}

// A response is one model content; text and functionCall parts collapse into
// its part list, appended at the end. Response part_meta residuals re-apply
// vendor extras by part index, then are consumed.
export function collectModelContent(program: Program): Program {
    return collectModelContentForResponse(program, true);
}

export function collectStreamModelContent(program: Program): Program {
    const out: Program = [];
    const parts: WirePart[] = [];

    for (const op of program) {
        switch (op.op) {
            case "response.text_delta": {
                const text = op as OpOf<"response.text_delta">;
                if (text.role != null && text.role !== "assistant") {
                    throw new Error(
                        `gemini stream response lower: unexpected ${text.role} text delta`,
                    );
                }
                parts.push({ text: text.content });
                break;
            }
            case "response.tool_call_delta": {
                const call = op as OpOf<"response.tool_call_delta">;
                if (!call.name) {
                    throw new LintError(
                        "gemini stream response lower: tool_call_delta requires a function name",
                    );
                }
                parts.push({
                    functionCall: {
                        name: call.name,
                        args: parseToolCallDeltaArguments(call),
                        ...(call.id == null ? {} : { id: call.id }),
                    },
                });
                break;
            }
            default:
                out.push(op);
        }
    }

    if (parts.length > 0) {
        out.push({
            op: "gemini.content",
            content: { role: "model", parts },
            appliesTo: "response",
        });
    }
    return out;
}

function collectModelContentForResponse(
    program: Program,
    requireContent: boolean,
): Program {
    const out: Program = [];
    const partMeta = collectResponsePartMeta(program);
    const parts: WirePart[] = [];

    for (const op of program) {
        switch (op.op) {
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new Error(
                        `gemini response lower: unexpected ${text.role} text in a response program`,
                    );
                }
                parts.push(
                    withPartMeta(
                        { text: text.content },
                        partMeta.get(parts.length),
                    ),
                );
                break;
            }
            case "llm.tool_call": {
                const call = op as OpOf<"llm.tool_call">;
                const meta = partMeta.get(parts.length);
                parts.push(
                    withPartMeta(
                        {
                            functionCall: {
                                name: call.name,
                                args: call.arguments,
                                ...(meta?.omitFunctionCallId
                                    ? {}
                                    : { id: call.id }),
                            },
                        },
                        meta,
                    ),
                );
                break;
            }
            case "llm.image":
                throw new LintError(
                    "gemini response lower: llm.image cannot be sent in a response program",
                );
            case "llm.audio":
                throw new LintError(
                    "gemini response lower: llm.audio cannot be sent in a response program",
                );
            case "llm.document":
                throw new LintError(
                    "gemini response lower: llm.document cannot be sent in a response program",
                );
            case "llm.video":
                throw new LintError(
                    "gemini response lower: llm.video cannot be sent in a response program",
                );
            case "gemini.part_meta":
                break;
            default:
                out.push(op);
        }
    }

    if (requireContent || parts.length > 0) {
        out.push({
            op: "gemini.content",
            content: { role: "model", parts },
            appliesTo: "response",
        });
    }
    return out;
}

function contentOp(role: "user" | "model", part: WirePart): Op {
    return {
        op: "gemini.content",
        content: { role, parts: [part] } satisfies WireContent,
    };
}

// Fragile by design: extras are keyed by the part's ORIGINAL wire index and
// re-applied by REBUILT index, so a core-IR transform that inserts or drops an
// assistant text/tool-call op between raise and lower shifts every later
// index and misattaches extras silently. Fine for pass-through proxying;
// a durable fix would key extras to the op itself.
function collectResponsePartMeta(
    program: Program,
): Map<number, ResponsePartMeta> {
    const byIndex = new Map<number, ResponsePartMeta>();
    for (const op of program) {
        if (op.op !== "gemini.part_meta") continue;
        const meta = opData<{
            part: GeminiPartMeta;
            appliesTo?: "request" | "response";
        }>(op);
        if (meta.appliesTo === "request" || meta.part.index == null) continue;
        if (!meta.part.meta && meta.part.idSource !== "synthesized") continue;
        byIndex.set(meta.part.index, {
            ...(meta.part.meta ? { meta: meta.part.meta } : {}),
            ...(meta.part.idSource === "synthesized"
                ? { omitFunctionCallId: true }
                : {}),
        });
    }
    return byIndex;
}

function withPartMeta(
    part: WirePart,
    meta: ResponsePartMeta | undefined,
): WirePart {
    return meta?.meta ? { ...part, ...meta.meta } : part;
}

function applyPartMeta(part: WirePart, meta: GeminiPartMeta): WirePart {
    const withMeta = meta.meta ? { ...part, ...meta.meta } : { ...part };
    if (meta.idSource !== "synthesized") return withMeta;
    if (!withMeta.functionCall) return withMeta;
    const { id: _id, ...functionCall } = withMeta.functionCall;
    return { ...withMeta, functionCall };
}

function assertPartMetaMatchesPart(meta: GeminiPartMeta, part: WirePart): void {
    if (meta.kind !== "functionCall" || !meta.id) return;
    const id = part.functionCall?.id;
    if (id !== meta.id) {
        throw new LintError(
            `gemini request lower: cannot apply functionCall part_meta for ${meta.id} to ${id ?? "a functionCall without id"}`,
        );
    }
}

function partMetaHasWireEffect(meta: GeminiPartMeta): boolean {
    return !!meta.meta || meta.idSource === "synthesized";
}

function wirePartKind(part: WirePart): GeminiPartMeta["kind"] | undefined {
    if (part.text != null) return "text";
    if (part.functionCall != null) return "functionCall";
    if (part.functionResponse != null) return "functionResponse";
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolResultObject(
    result: OpOf<"llm.tool_result">,
): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(result.content);
    } catch {
        throw new LintError(
            `gemini tool_result ${result.id}: content must be a JSON object`,
        );
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new LintError(
            `gemini tool_result ${result.id}: content must be a JSON object`,
        );
    }
    return parsed as Record<string, unknown>;
}

function parseToolCallDeltaArguments(
    call: OpOf<"response.tool_call_delta">,
): Record<string, unknown> {
    if (call.arguments == null) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(call.arguments);
    } catch {
        throw new LintError(
            "gemini stream response lower: tool_call_delta arguments must be a JSON object",
        );
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new LintError(
            "gemini stream response lower: tool_call_delta arguments must be a JSON object",
        );
    }
    return parsed as Record<string, unknown>;
}
