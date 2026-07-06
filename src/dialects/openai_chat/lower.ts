// core IR -> lower IR, as pipelines of stages. Per-op stages lower each core
// op to its own openai_chat.message op; the cross-op work (attaching
// message_meta, merging tool calls into their preceding assistant message,
// collecting a response into one choice message) lives in small named stages
// appended after them. Extend by appending to the stage arrays.

import { opData, type Op, type OpOf, type Program } from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import {
    assertAudioSource,
    assertDocumentSource,
    dataUrlFromBase64,
    mediaDataUrlFromBase64,
} from "../../core/media.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import { lowerFinishReason } from "./raise.js";
import type {
    OpenAIChatMessageMeta,
    WireMessage,
    WireToolCall,
} from "./ops.js";

export const lowerRequestStages: Stage[] = [
    lowerRequestTexts,
    lowerRequestImages,
    lowerRequestAudio,
    lowerRequestDocuments,
    lowerToolCalls,
    lowerToolResults,
    applyRequestMessageMeta,
    mergeAdjacentContentPartMessages,
    mergeToolCallMessages,
];

export const lowerRequest: Stage = stagePipeline(lowerRequestStages);

export const lowerResponseStages: Stage[] = [
    lowerStopReasons,
    lowerUsageCounts,
    collectAssistantMessage,
];

export const lowerResponse: Stage = stagePipeline(lowerResponseStages);

export const lowerStreamResponseStages: Stage[] = [
    lowerStopReasons,
    lowerUsageCounts,
];

export const lowerStreamResponse: Stage = stagePipeline(
    lowerStreamResponseStages,
);

export function lowerRequestTexts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.text") return [op];
        const text = op as OpOf<"llm.text">;
        return [
            {
                op: "openai_chat.message",
                message: {
                    role: text.role,
                    content: text.content,
                } satisfies WireMessage,
            },
        ];
    });
}

export function lowerRequestImages(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.image") return [op];
        const image = op as OpOf<"llm.image">;
        if (image.role !== "user") {
            throw new LintError(
                `openai_chat request lower: unsupported image role ${JSON.stringify(image.role)}`,
            );
        }
        return [
            {
                op: "openai_chat.message",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url:
                                    image.source.type === "url"
                                        ? image.source.url
                                        : dataUrlFromBase64(image.source),
                            },
                        },
                    ],
                } satisfies WireMessage,
            },
        ];
    });
}

export function lowerRequestAudio(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.audio") return [op];
        const audio = op as OpOf<"llm.audio">;
        assertAudioSource(audio.source, "openai_chat request lower llm.audio");
        return [
            {
                op: "openai_chat.message",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "input_audio",
                            input_audio: {
                                data: audio.source.data,
                                format: openAIChatAudioFormat(
                                    audio.source.mediaType,
                                ),
                            },
                        },
                    ],
                } satisfies WireMessage,
            },
        ];
    });
}

export function lowerRequestDocuments(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.document") return [op];
        const document = op as OpOf<"llm.document">;
        assertDocumentSource(
            document.source,
            "openai_chat request lower llm.document",
        );
        if (document.source.type !== "base64") {
            throw new LintError(
                "openai_chat request lower: llm.document URL sources are not supported by Chat Completions",
            );
        }
        if (!document.source.filename) {
            throw new LintError(
                "openai_chat request lower: llm.document base64 sources require filename",
            );
        }
        return [
            {
                op: "openai_chat.message",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "file",
                            file: {
                                filename: document.source.filename,
                                file_data: mediaDataUrlFromBase64(
                                    document.source,
                                    "document",
                                    "openai_chat request lower llm.document",
                                ),
                            },
                        },
                    ],
                } satisfies WireMessage,
            },
        ];
    });
}

// Each call becomes its own bare assistant message here; mergeToolCallMessages
// below folds it into the preceding assistant message so "text then call" and
// parallel calls end up as one wire message.
export function lowerToolCalls(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_call") return [op];
        return [
            {
                op: "openai_chat.message",
                message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [wireToolCall(op as OpOf<"llm.tool_call">)],
                } satisfies WireMessage,
            },
        ];
    });
}

export function lowerToolResults(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_result") return [op];
        const result = op as OpOf<"llm.tool_result">;
        return [
            {
                op: "openai_chat.message",
                message: {
                    role: "tool",
                    tool_call_id: chatToolCallId(result.id),
                    content: result.content,
                } satisfies WireMessage,
            },
        ];
    });
}

// message_meta annotates the message op it immediately follows (any other op
// in between breaks the association, matching how raise emits it). Message
// ops can be caller-owned residuals, so annotation replaces the op with a
// copy instead of writing into the caller's object.
export function applyRequestMessageMeta(program: Program): Program {
    const out: Program = [];
    let lastMessage: WireMessage | undefined;
    for (const op of program) {
        if (op.op === "openai_chat.message_meta") {
            const annotated = applyMetaToMessage(
                lastMessage,
                opData<{ message: OpenAIChatMessageMeta }>(op).message,
            );
            if (annotated && annotated !== lastMessage) {
                // lastMessage being set means out ends with its message op.
                out[out.length - 1] = {
                    ...out[out.length - 1],
                    message: annotated,
                } as Op;
                lastMessage = annotated;
            }
            continue;
        }
        if (op.op === "openai_chat.message") {
            lastMessage = opData<{ message: WireMessage }>(op).message;
            out.push(op);
            continue;
        }
        lastMessage = undefined;
        out.push(op);
    }
    return out;
}

function applyMetaToMessage(
    message: WireMessage | undefined,
    meta: OpenAIChatMessageMeta,
): WireMessage | undefined {
    const { role, content, refusal, annotations, audio } = meta;
    if (
        content !== undefined ||
        refusal !== undefined ||
        annotations !== undefined ||
        audio !== undefined
    ) {
        throw new LintError(
            "openai_chat request lower: response-only message metadata cannot be sent in a request",
        );
    }
    if (role === undefined) return message;
    if (role !== "developer")
        throw new LintError(
            `openai_chat request lower: unsupported message role metadata ${JSON.stringify(role)}`,
        );
    if (!message)
        throw new LintError(
            "openai_chat request lower: message metadata has no message to annotate",
        );
    if (message.role !== "system") {
        throw new LintError(
            `openai_chat request lower: developer metadata cannot annotate ${JSON.stringify(message.role)} message`,
        );
    }
    return { ...message, role: "developer" };
}

// A tool-calls-only assistant message merges into the assistant message op
// immediately before it, keeping "text then call" one wire message and
// parallel calls together. Any intervening op breaks adjacency, so config
// residuals placed mid-conversation still split messages. Merging builds a
// new op — the previous one may be a caller-owned residual, and mutating it
// would corrupt the caller's program (and compound on repeated lowering).
export function mergeToolCallMessages(program: Program): Program {
    const out: Program = [];
    for (const op of program) {
        const message =
            op.op === "openai_chat.message"
                ? opData<{ message: WireMessage }>(op).message
                : undefined;
        const previous = out[out.length - 1];
        const previousMessage =
            previous?.op === "openai_chat.message"
                ? opData<{ message: WireMessage }>(previous).message
                : undefined;
        if (
            message?.role === "assistant" &&
            message.content === null &&
            message.tool_calls &&
            previousMessage?.role === "assistant"
        ) {
            out[out.length - 1] = {
                ...previous,
                message: {
                    ...previousMessage,
                    tool_calls: [
                        ...(previousMessage.tool_calls ?? []),
                        ...message.tool_calls,
                    ],
                },
            } as Op;
            continue;
        }
        out.push(op);
    }
    return out;
}

export function mergeAdjacentContentPartMessages(program: Program): Program {
    const out: Program = [];
    for (const op of program) {
        const message =
            op.op === "openai_chat.message"
                ? opData<{ message: WireMessage }>(op).message
                : undefined;
        const previous = out[out.length - 1];
        const previousMessage =
            previous?.op === "openai_chat.message"
                ? opData<{ message: WireMessage }>(previous).message
                : undefined;
        if (
            canMergeContentParts(previousMessage) &&
            canMergeContentParts(message) &&
            previousMessage.role === message.role &&
            (Array.isArray(previousMessage.content) ||
                Array.isArray(message.content))
        ) {
            out[out.length - 1] = {
                ...previous,
                message: {
                    ...previousMessage,
                    content: [
                        ...messageContentParts(previousMessage),
                        ...messageContentParts(message),
                    ],
                },
            } as Op;
            continue;
        }
        out.push(op);
    }
    return out;
}

function canMergeContentParts(
    message: WireMessage | undefined,
): message is WireMessage {
    return (
        message != null &&
        message.role === "user" &&
        message.tool_calls == null &&
        message.tool_call_id == null &&
        message.name == null &&
        (typeof message.content === "string" || Array.isArray(message.content))
    );
}

function messageContentParts(message: WireMessage) {
    return typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
}

export function lowerStopReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "response.stop"
            ? [
                  {
                      op: "openai_chat.finish_reason",
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
                op: "openai_chat.usage",
                usage: {
                    ...(counts.inputTokens != null
                        ? { prompt_tokens: counts.inputTokens }
                        : {}),
                    ...(counts.outputTokens != null
                        ? { completion_tokens: counts.outputTokens }
                        : {}),
                },
            },
        ];
    });
}

// A chat completion carries exactly one choice, so the whole response's
// assistant output collapses into a single wire message appended at the end.
export function collectAssistantMessage(program: Program): Program {
    const out: Program = [];
    const texts: string[] = [];
    const toolCalls: WireToolCall[] = [];
    let messageMeta: OpenAIChatMessageMeta = {};

    for (const op of program) {
        switch (op.op) {
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new Error(
                        `openai_chat response lower: unexpected ${text.role} text in a response program`,
                    );
                }
                texts.push(text.content);
                break;
            }
            case "llm.tool_call":
                toolCalls.push(wireToolCall(op as OpOf<"llm.tool_call">));
                break;
            case "llm.image":
                throw new LintError(
                    "openai_chat response lower: llm.image cannot be sent in a response program",
                );
            case "llm.audio":
                throw new LintError(
                    "openai_chat response lower: llm.audio cannot be sent in a response program",
                );
            case "llm.document":
                throw new LintError(
                    "openai_chat response lower: llm.document cannot be sent in a response program",
                );
            case "llm.video":
                throw new LintError(
                    "openai_chat response lower: llm.video cannot be sent in a response program",
                );
            case "openai_chat.message_meta":
                messageMeta = mergeResponseMessageMeta(
                    messageMeta,
                    opData<{ message: OpenAIChatMessageMeta }>(op).message,
                );
                break;
            default:
                out.push(op);
        }
    }

    const textContent = texts.length > 0 ? texts.join("\n") : null;
    const { content: contentMarker, ...wireMeta } = messageMeta;
    if (
        contentMarker === null &&
        typeof wireMeta.refusal === "string" &&
        textContent != null &&
        textContent !== wireMeta.refusal
    ) {
        throw new LintError(
            "openai_chat response lower: refusal metadata does not match assistant text",
        );
    }
    const message: WireMessage = {
        role: "assistant",
        content:
            contentMarker === null && typeof wireMeta.refusal === "string"
                ? null
                : textContent,
        ...wireMeta,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    out.push({ op: "openai_chat.message", message });
    return out;
}

function mergeResponseMessageMeta(
    current: OpenAIChatMessageMeta,
    next: OpenAIChatMessageMeta,
): OpenAIChatMessageMeta {
    if (next.role !== undefined) {
        throw new LintError(
            "openai_chat response lower: request-only role metadata cannot be sent in a response",
        );
    }
    return { ...current, ...next };
}

function wireToolCall(op: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}): WireToolCall {
    return {
        id: chatToolCallId(op.id),
        type: "function",
        function: { name: op.name, arguments: JSON.stringify(op.arguments) },
    };
}

function chatToolCallId(id: string): string {
    return id.split("|", 1)[0]!.slice(0, 40);
}

function openAIChatAudioFormat(mediaType: string): string {
    switch (mediaType) {
        case "audio/wav":
        case "audio/wave":
        case "audio/x-wav":
            return "wav";
        case "audio/mp3":
        case "audio/mpeg":
            return "mp3";
        default:
            throw new LintError(
                `openai_chat request lower: unsupported llm.audio media type ${JSON.stringify(mediaType)}`,
            );
    }
}
