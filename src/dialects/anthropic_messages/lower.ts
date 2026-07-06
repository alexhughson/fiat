// core IR -> lower IR, as pipelines of stages. The wire requires
// user/assistant turns to alternate, so per-op stages first lower each core
// op to a single-block message, then mergeAdjacentSameRole folds consecutive
// same-role messages into one block list (tool results are user-role
// blocks). System text stays a core op — requestToWire serializes it into
// the top-level system string. Extend by appending to the stage arrays.

import {
    isCoreOp,
    namespaceOf,
    opData,
    type Op,
    type OpOf,
    type Program,
} from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import {
    assertDocumentSource,
    assertImageMediaType,
} from "../../core/media.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import type {
    WireAnthropicMessage,
    WireAnthropicStreamEvent,
    WireBlock,
} from "./ops.js";

export const lowerRequestStages: Stage[] = [
    lintMidConversationSystem,
    lowerThinking,
    lowerStructuredOutput,
    applyRequestTextMeta,
    dropEmptyText,
    lowerRequestTexts,
    lowerRequestImages,
    lowerRequestDocuments,
    lowerToolCalls,
    applyRequestToolResultMeta,
    lowerToolResults,
    lowerRequestContentBlocks,
    mergeAdjacentSameRole,
];

export const lowerRequest: Stage = stagePipeline(lowerRequestStages);

export const lowerResponseStages: Stage[] = [
    dropEmptyText,
    lowerStopReasons,
    lowerUsageCounts,
    collectAssistantMessage,
];

export const lowerResponse: Stage = stagePipeline(lowerResponseStages);

export const lowerStreamResponseStages: Stage[] = [
    lowerCompleteResponseToStreamEvents,
    lowerStreamTextDeltas,
    lowerStreamToolCallDeltas,
    lowerStreamStopAndUsage,
];

export const lowerStreamResponse: Stage = stagePipeline(
    lowerStreamResponseStages,
);

export function lowerThinking(program: Program): Program {
    const hasRawThinking = program.some(
        (op) => op.op === "anthropic_messages.thinking_config",
    );

    return program.flatMap((op) => {
        if (op.op !== "llm.thinking") return [op];
        const thinking = op as OpOf<"llm.thinking">;
        if (hasRawThinking) {
            return [
                {
                    op: "anthropic_messages.output_config",
                    value: { effort: thinking.effort },
                },
            ];
        }
        return [
            {
                op: "anthropic_messages.thinking",
                adaptiveEffort: thinking.effort,
                display: "summarized",
            },
        ];
    });
}

// System text lowers into the request's top-level system field, which would
// silently reorder it ahead of the conversation — so a system op after the
// conversation has started is an error, not a hoist.
export function lintMidConversationSystem(program: Program): Program {
    let sawConversation = false;
    for (const op of program) {
        switch (op.op) {
            case "llm.text":
                if ((op as OpOf<"llm.text">).role === "system") {
                    if (sawConversation) {
                        throw new LintError(
                            "anthropic_messages request lower: system text after conversation start cannot be hoisted without reordering",
                        );
                    }
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
            case "anthropic_messages.message":
                sawConversation = true;
                break;
            case "anthropic_messages.content_block": {
                const residual = opData<{
                    role?: "user" | "assistant";
                    appliesTo?: "response";
                }>(op);
                if (residual.appliesTo !== "response" && residual.role) {
                    sawConversation = true;
                }
                break;
            }
            case "anthropic_messages.system_block":
                if (sawConversation) {
                    throw new LintError(
                        "anthropic_messages request lower: system block after conversation start cannot be hoisted without reordering",
                    );
                }
                break;
        }
    }
    return program;
}

export function lowerStructuredOutput(program: Program): Program {
    let output: OpOf<"llm.output"> | undefined;
    let outputConfigIndex = -1;
    const out: Program = [];

    for (const op of program) {
        if (op.op === "llm.output") {
            if (output) {
                throw new LintError(
                    "anthropic_messages request lower: expected at most one llm.output op",
                );
            }
            output = op as OpOf<"llm.output">;
            continue;
        }
        if (op.op === "anthropic_messages.output_config") {
            outputConfigIndex = out.length;
        }
        out.push(op);
    }

    if (!output) return program;

    const format = {
        type: "json_schema",
        schema: output.schema,
    };
    if (outputConfigIndex >= 0) {
        const param = opData<{ value: unknown }>(out[outputConfigIndex]!);
        const existing = param.value;
        if (
            !existing ||
            typeof existing !== "object" ||
            Array.isArray(existing)
        ) {
            throw new LintError(
                "anthropic_messages request lower: output_config must be an object to merge llm.output",
            );
        }
        const config = existing as Record<string, unknown>;
        if ("format" in config) {
            throw new LintError(
                "anthropic_messages request lower: llm.output conflicts with existing output_config.format",
            );
        }
        out[outputConfigIndex] = {
            ...out[outputConfigIndex]!,
            value: { ...config, format },
        };
        return out;
    }

    out.push({
        op: "anthropic_messages.output_config",
        value: { format },
    });
    return out;
}

export function applyRequestTextMeta(program: Program): Program {
    const out: Program = [];
    for (const op of program) {
        if (op.op !== "anthropic_messages.text_meta") {
            out.push(op);
            continue;
        }

        const previous = out[out.length - 1];
        if (previous?.op !== "llm.text") {
            throw new LintError(
                "anthropic_messages request lower: text_meta must immediately follow the llm.text it annotates",
            );
        }

        const text = previous as OpOf<"llm.text">;
        const fields = opData<{ fields: Record<string, unknown> }>(op).fields;
        const block = { type: "text", text: text.content, ...fields };
        out[out.length - 1] =
            text.role === "system"
                ? {
                      op: "anthropic_messages.system_block",
                      block,
                  }
                : {
                      op: "anthropic_messages.content_block",
                      role: text.role,
                      block,
                  };
    }
    return out;
}

// The Messages API rejects empty text blocks, and an empty llm.text carries
// no meaning — openai clients routinely send content: "" on tool-call turns,
// so this shows up on real cross-provider traffic.
export function dropEmptyText(program: Program): Program {
    return program.filter(
        (op) =>
            !(op.op === "llm.text" && (op as OpOf<"llm.text">).content === ""),
    );
}

export function lowerRequestTexts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.text") return [op];
        const text = op as OpOf<"llm.text">;
        if (text.role === "system") return [op];
        return [messageOp(text.role, { type: "text", text: text.content })];
    });
}

export function lowerRequestImages(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.image") return [op];
        const image = op as OpOf<"llm.image">;
        if (image.role !== "user") {
            throw new LintError(
                `anthropic_messages request lower: unsupported image role ${JSON.stringify(image.role)}`,
            );
        }
        return [
            messageOp("user", {
                type: "image",
                source: anthropicImageSource(image.source),
            }),
        ];
    });
}

export function lowerRequestDocuments(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.document") return [op];
        const document = op as OpOf<"llm.document">;
        assertDocumentSource(
            document.source,
            "anthropic_messages request lower llm.document",
        );
        return [
            messageOp("user", {
                type: "document",
                source: anthropicDocumentSource(document.source),
            }),
        ];
    });
}

function anthropicImageSource(image: OpOf<"llm.image">["source"]) {
    if (image.type === "url") return { type: "url", url: image.url };
    assertImageMediaType(
        image.mediaType,
        "anthropic_messages request lower llm.image",
    );
    return {
        type: "base64",
        media_type: image.mediaType,
        data: image.data,
    };
}

function anthropicDocumentSource(document: OpOf<"llm.document">["source"]) {
    if (document.type === "url") return { type: "url", url: document.url };
    return {
        type: "base64",
        media_type: document.mediaType,
        data: document.data,
    };
}

export function lowerToolCalls(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_call") return [op];
        const call = op as OpOf<"llm.tool_call">;
        return [
            messageOp("assistant", {
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: call.arguments,
            }),
        ];
    });
}

export function applyRequestToolResultMeta(program: Program): Program {
    const metaById = new Map<
        string,
        {
            fields?: Record<string, unknown>;
            is_error?: boolean;
        }
    >();
    const resultCounts = new Map<string, number>();

    for (const op of program) {
        if (op.op === "llm.tool_result") {
            const result = op as OpOf<"llm.tool_result">;
            resultCounts.set(result.id, (resultCounts.get(result.id) ?? 0) + 1);
        }
        if (op.op === "anthropic_messages.tool_result_meta") {
            const meta = opData<{
                id: string;
                fields?: Record<string, unknown>;
                is_error?: boolean;
            }>(op);
            if (metaById.has(meta.id)) {
                throw new LintError(
                    `anthropic_messages request lower: duplicate tool_result_meta for ${JSON.stringify(meta.id)}`,
                );
            }
            metaById.set(meta.id, meta);
        }
    }

    for (const id of metaById.keys()) {
        if ((resultCounts.get(id) ?? 0) !== 1) {
            throw new LintError(
                `anthropic_messages request lower: tool_result_meta references missing or ambiguous llm.tool_result ${JSON.stringify(id)}`,
            );
        }
    }

    const out: Program = [];
    for (const op of program) {
        if (op.op === "anthropic_messages.tool_result_meta") {
            continue;
        }

        if (op.op !== "llm.tool_result") {
            out.push(op);
            continue;
        }

        const result = op as OpOf<"llm.tool_result">;
        const meta = metaById.get(result.id);
        if (!meta) {
            out.push(op);
            continue;
        }

        out.push({
            op: "anthropic_messages.content_block",
            role: "user",
            block: {
                type: "tool_result",
                tool_use_id: result.id,
                content: result.content,
                ...(meta.is_error ? { is_error: true } : {}),
                ...(meta.fields ?? {}),
            },
        });
    }
    return out;
}

export function lowerToolResults(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_result") return [op];
        const result = op as OpOf<"llm.tool_result">;
        return [
            messageOp("user", {
                type: "tool_result",
                tool_use_id: result.id,
                content: result.content,
            }),
        ];
    });
}

export function lowerRequestContentBlocks(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "anthropic_messages.content_block") return [op];
        const residual = opData<{
            block: WireBlock;
            role?: "user" | "assistant";
            appliesTo?: "response";
        }>(op);
        if (residual.appliesTo === "response") return [op];
        if (!residual.role) {
            throw new LintError(
                "anthropic_messages request lower: content block residual requires a role",
            );
        }
        return [messageOp(residual.role, residual.block)];
    });
}

// Adjacent-only on purpose: an op between two same-role messages (a config
// residual, a system op) keeps them separate messages, exactly like the
// wire would have carried them. Merging builds a new op — the previous one
// may be a caller-owned residual, and mutating it would corrupt the caller's
// program (and compound on repeated lowering).
export function mergeAdjacentSameRole(program: Program): Program {
    const out: Program = [];
    for (const op of program) {
        const message =
            op.op === "anthropic_messages.message"
                ? opData<{ message: WireAnthropicMessage }>(op).message
                : undefined;
        const previous = out[out.length - 1];
        const previousMessage =
            previous?.op === "anthropic_messages.message"
                ? opData<{ message: WireAnthropicMessage }>(previous).message
                : undefined;
        if (
            message &&
            previousMessage &&
            message.role === previousMessage.role &&
            Array.isArray(message.content) &&
            Array.isArray(previousMessage.content)
        ) {
            out[out.length - 1] = {
                ...previous,
                message: {
                    ...previousMessage,
                    content: [...previousMessage.content, ...message.content],
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
                      op: "anthropic_messages.stop_reason",
                      value: lowerStopReason(
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
                op: "anthropic_messages.usage",
                usage: {
                    ...(counts.inputTokens != null
                        ? { input_tokens: counts.inputTokens }
                        : {}),
                    ...(counts.outputTokens != null
                        ? { output_tokens: counts.outputTokens }
                        : {}),
                },
            },
        ];
    });
}

export function lowerCompleteResponseToStreamEvents(program: Program): Program {
    const hasCompleteBlocks = program.some(
        (op) =>
            op.op === "llm.text" ||
            op.op === "llm.tool_call" ||
            op.op === "anthropic_messages.content_block",
    );
    if (!hasCompleteBlocks) return program;

    if (
        program.some(
            (op) =>
                op.op === "response.text_delta" ||
                op.op === "response.tool_call_delta",
        )
    ) {
        throw new LintError(
            "anthropic_messages stream lower: cannot mix complete response blocks with stream delta ops",
        );
    }

    const events: WireAnthropicStreamEvent[] = [];
    let model: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let stopReason: string | undefined;
    let index = 0;
    const passthrough: Program = [];

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                model = (op as OpOf<"llm.model">).model;
                break;
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new LintError(
                        `anthropic_messages stream lower: unexpected ${text.role} text in a response program`,
                    );
                }
                if (text.content === "") break;
                pushStreamBlockEvents(
                    events,
                    { type: "text", text: text.content },
                    index++,
                );
                break;
            }
            case "llm.tool_call": {
                const call = op as OpOf<"llm.tool_call">;
                pushStreamBlockEvents(
                    events,
                    {
                        type: "tool_use",
                        id: call.id,
                        name: call.name,
                        input: call.arguments,
                    },
                    index++,
                );
                break;
            }
            case "response.stop":
                stopReason = lowerStopReason(
                    (op as OpOf<"response.stop">).reason,
                );
                break;
            case "response.usage": {
                const counts = op as OpOf<"response.usage">;
                usage = {
                    ...usage,
                    ...(counts.inputTokens != null
                        ? { input_tokens: counts.inputTokens }
                        : {}),
                    ...(counts.outputTokens != null
                        ? { output_tokens: counts.outputTokens }
                        : {}),
                };
                break;
            }
            case "anthropic_messages.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "anthropic_messages.stop_reason":
                stopReason = opData<{ value: string }>(op).value;
                break;
            case "anthropic_messages.content_block": {
                const block = opData<{ block: WireBlock }>(op).block;
                pushRawStreamBlockEvents(events, block, index++);
                break;
            }
            default:
                if (!isCoreOp(op) && namespaceOf(op) !== "anthropic_messages") {
                    passthrough.push(op);
                    break;
                }
                throw new LintError(
                    `anthropic_messages stream lower: no complete response stream mapping for op "${op.op}"`,
                );
        }
    }

    if (!model) {
        throw new LintError(
            "anthropic_messages stream lower: complete response stream requires llm.model",
        );
    }

    const out: Program = [
        streamEvent({
            type: "message_start",
            message: {
                id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: usage ?? {},
            },
        }),
        ...events.map(streamEvent),
    ];

    if (stopReason !== undefined || usage !== undefined) {
        out.push(
            streamEvent({
                type: "message_delta",
                delta:
                    stopReason !== undefined
                        ? { stop_reason: stopReason, stop_sequence: null }
                        : {},
                ...(usage !== undefined ? { usage } : {}),
            }),
        );
    }
    out.push(streamEvent({ type: "message_stop" }));
    return [...out, ...passthrough];
}

export function lowerStreamTextDeltas(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "response.text_delta") return [op];
        const delta = op as OpOf<"response.text_delta">;
        return [
            streamEvent({
                type: "content_block_delta",
                index: requiredIndex(delta, "response.text_delta"),
                delta: { type: "text_delta", text: delta.content },
            }),
        ];
    });
}

export function lowerStreamToolCallDeltas(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "response.tool_call_delta") return [op];
        const delta = op as OpOf<"response.tool_call_delta">;
        const hasStart = delta.id != null || delta.name != null;
        const hasArguments = delta.arguments != null;
        if (hasStart && hasArguments) {
            throw new LintError(
                "anthropic_messages stream lower: tool call start metadata and input_json_delta fragments must be separate ops",
            );
        }
        if (hasStart) {
            if (!delta.id || !delta.name) {
                throw new LintError(
                    "anthropic_messages stream lower: tool call start requires both id and name",
                );
            }
            return [
                streamEvent({
                    type: "content_block_start",
                    index: requiredIndex(delta, "response.tool_call_delta"),
                    content_block: {
                        type: "tool_use",
                        id: delta.id,
                        name: delta.name,
                        input: {},
                    },
                }),
            ];
        }
        if (hasArguments) {
            return [
                streamEvent({
                    type: "content_block_delta",
                    index: requiredIndex(delta, "response.tool_call_delta"),
                    delta: {
                        type: "input_json_delta",
                        partial_json: delta.arguments,
                    },
                }),
            ];
        }
        throw new LintError(
            "anthropic_messages stream lower: tool call delta requires start metadata or arguments",
        );
    });
}

export function lowerStreamStopAndUsage(program: Program): Program {
    const out: Program = [];
    let stopReason: string | undefined;
    let usage: Record<string, unknown> | undefined;

    for (const op of program) {
        switch (op.op) {
            case "response.stop":
                if (stopReason !== undefined) {
                    throw new LintError(
                        "anthropic_messages stream lower: expected at most one response.stop op",
                    );
                }
                stopReason = lowerStopReason(
                    (op as OpOf<"response.stop">).reason,
                );
                break;
            case "response.usage": {
                const counts = op as OpOf<"response.usage">;
                usage = {
                    ...usage,
                    ...(counts.inputTokens != null
                        ? { input_tokens: counts.inputTokens }
                        : {}),
                    ...(counts.outputTokens != null
                        ? { output_tokens: counts.outputTokens }
                        : {}),
                };
                break;
            }
            case "anthropic_messages.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            default:
                out.push(op);
        }
    }

    if (stopReason !== undefined || usage !== undefined) {
        out.push(
            streamEvent({
                type: "message_delta",
                delta:
                    stopReason !== undefined ? { stop_reason: stopReason } : {},
                ...(usage !== undefined ? { usage } : {}),
            }),
        );
    }
    return out;
}

// A response is one assistant message; all text, tool-call, and preserved
// provider content blocks collapse into its block list in stream order.
export function collectAssistantMessage(program: Program): Program {
    const out: Program = [];
    const blocks: WireBlock[] = [];

    for (const op of program) {
        switch (op.op) {
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new Error(
                        `anthropic_messages response lower: unexpected ${text.role} text in a response program`,
                    );
                }
                blocks.push({ type: "text", text: text.content });
                break;
            }
            case "llm.tool_call": {
                const call = op as OpOf<"llm.tool_call">;
                blocks.push({
                    type: "tool_use",
                    id: call.id,
                    name: call.name,
                    input: call.arguments,
                });
                break;
            }
            case "llm.image":
                throw new LintError(
                    "anthropic_messages response lower: llm.image cannot be sent in a response program",
                );
            case "llm.audio":
                throw new LintError(
                    "anthropic_messages response lower: llm.audio cannot be sent in a response program",
                );
            case "llm.document":
                throw new LintError(
                    "anthropic_messages response lower: llm.document cannot be sent in a response program",
                );
            case "llm.video":
                throw new LintError(
                    "anthropic_messages response lower: llm.video cannot be sent in a response program",
                );
            case "anthropic_messages.content_block":
                blocks.push(opData<{ block: WireBlock }>(op).block);
                break;
            default:
                out.push(op);
        }
    }

    out.push({
        op: "anthropic_messages.message",
        message: { role: "assistant", content: blocks },
    });
    return out;
}

function messageOp(role: "user" | "assistant", block: WireBlock): Op {
    return {
        op: "anthropic_messages.message",
        message: { role, content: [block] } satisfies WireAnthropicMessage,
    };
}

function streamEvent(event: WireAnthropicStreamEvent): Op {
    return {
        op: "anthropic_messages.stream_event",
        event,
        appliesTo: "response",
    };
}

function pushStreamBlockEvents(
    events: WireAnthropicStreamEvent[],
    block: WireBlock,
    index: number,
): void {
    if (block.type === "text") {
        events.push(
            {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
            },
            {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: block.text ?? "" },
            },
            { type: "content_block_stop", index },
        );
        return;
    }
    if (block.type === "tool_use") {
        events.push(
            {
                type: "content_block_start",
                index,
                content_block: {
                    type: "tool_use",
                    id: block.id,
                    name: block.name,
                    input: {},
                },
            },
            {
                type: "content_block_delta",
                index,
                delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(block.input ?? {}),
                },
            },
            { type: "content_block_stop", index },
        );
        return;
    }
    throw new LintError(
        `anthropic_messages stream lower: unsupported complete response block type ${JSON.stringify(block.type)}`,
    );
}

function pushRawStreamBlockEvents(
    events: WireAnthropicStreamEvent[],
    block: WireBlock,
    index: number,
): void {
    events.push(
        {
            type: "content_block_start",
            index,
            content_block: block,
        },
        { type: "content_block_stop", index },
    );
}

function requiredIndex(
    delta: { index?: number },
    opName: "response.text_delta" | "response.tool_call_delta",
): number {
    if (typeof delta.index !== "number") {
        throw new LintError(
            `anthropic_messages stream lower: ${opName} requires numeric index`,
        );
    }
    return delta.index;
}

function lowerStopReason(reason: OpOf<"response.stop">["reason"]): string {
    switch (reason) {
        case "end_turn":
        case "max_tokens":
        case "tool_use":
        case "stop_sequence":
        case "refusal":
        case "pause_turn":
        case "model_context_window_exceeded":
            return reason;
        case "content_filter":
            return "refusal";
    }
}
