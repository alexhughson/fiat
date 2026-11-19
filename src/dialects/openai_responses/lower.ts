// core IR -> lower IR, as pipelines of stages. Requests are purely per-op:
// each core op becomes one input item. Responses need one cross-op stage,
// collectOutputItems, which reunites core text/tool-call ops with the
// output_meta residuals raise left behind. Extend by appending to the stage
// arrays.

import type { Op, OpOf, Program } from "../../core/ops.js";
import { opData } from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import {
    assertDocumentSource,
    dataUrlFromBase64,
    mediaDataUrlFromBase64,
} from "../../core/media.js";
import * as reasoning from "../../core/reasoning.js";
import { stagePipeline, type Stage, type Target } from "../../core/rewrite.js";
import { summaryFromText, summaryText } from "./raise.js";
import { messageItem } from "./wire.js";
import type {
    WireContentPart,
    WireFunctionCall,
    WireOutputItem,
    WireOutputMessage,
    WireReasoningItem,
} from "./ops.js";

export const lowerRequestStages: Stage[] = [
    lowerReasoning,
    rejectStructuredOutput,
    lowerRequestTexts,
    lowerRequestImages,
    lowerRequestDocuments,
    mergeAdjacentMessageInputs,
    lowerToolCalls,
    lowerToolResults,
];

export const lowerRequest: Stage = stagePipeline(lowerRequestStages);

export const lowerResponseStages: Stage[] = [
    lowerReasoning,
    lowerStopReasons,
    lowerUsageCounts,
    collectOutputItems,
];

export const lowerResponse: Stage = stagePipeline(lowerResponseStages);

export const lowerStreamResponseStages: Stage[] = [
    lowerReasoning,
    lowerStopReasons,
    lowerUsageCounts,
];

export const lowerStreamResponse: Stage = stagePipeline(
    lowerStreamResponseStages,
);

// One chunk of another provider's stream can hold a delta and a stop reason:
// Gemini's API sends text and finishReason "STOP" together. A Responses stream
// has no event that holds both, so the finish reason, and the usage beside it,
// become a terminal event after the delta event. A program without a finish
// reason stays one event.
export function splitStreamEvents(program: Program): Program[] {
    const hasDelta = program.some(
        (op) =>
            op.op === "response.text_delta" ||
            op.op === "response.tool_call_delta",
    );
    const hasFinishReason = program.some(
        (op) => op.op === "openai_responses.finish_reason",
    );
    if (!hasDelta || !hasFinishReason) return [program];
    return [
        program.filter((op) => !isTerminalEventOp(op)),
        program.filter(isTerminalEventOp),
    ];
}

function isTerminalEventOp(op: Op): boolean {
    return (
        op.op === "openai_responses.finish_reason" ||
        op.op === "openai_responses.usage"
    );
}

const REASONING_ITEM = "openai_responses.reasoning_item";

// A reasoning item is usable by OpenAI only with the id or encrypted_content
// OpenAI issued, so a reasoning op without the side op (one raised from
// another provider) is not written. The Responses stream events for reasoning
// are not implemented, so a stream drops every reasoning op.
export function lowerReasoning(program: Program, target?: Target): Program {
    const sideOps = reasoning.sideOpsOf(program, [REASONING_ITEM]);
    return program.flatMap((op): Op[] => {
        if (op.op === REASONING_ITEM) return [];
        if (op.op !== "llm.reasoning") return [op];
        const thought = op as reasoning.Reasoning;
        const side = sideOps.get(thought)![0];
        if (target?.kind === "response_stream") {
            reasoning.warnDropped(
                thought,
                target,
                "stream lowering has no reasoning events yet",
            );
            return [];
        }
        if (!side) {
            reasoning.warnDropped(
                thought,
                target,
                "accepts a reasoning item only with the id or encrypted_content OpenAI issued for it",
            );
            return [];
        }
        const { summary, ...fields } = opData<{
            fields: Record<string, unknown>;
        }>(side).fields as { summary?: WireReasoningItem["summary"] };
        const item: WireReasoningItem = {
            type: "reasoning",
            ...fields,
            summary:
                summary && summaryText(summary) === thought.content
                    ? summary
                    : summaryFromText(thought.content),
        };
        return [
            {
                op:
                    target?.kind === "request"
                        ? "openai_responses.input"
                        : "openai_responses.output",
                item,
            },
        ];
    });
}

export function rejectStructuredOutput(program: Program): Program {
    for (const op of program) {
        if (op.op === "llm.output") {
            throw new LintError(
                "openai_responses structured output is not implemented yet — map llm.output to a response text format residual or remove it",
            );
        }
    }
    return program;
}

export function lowerRequestTexts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.text") return [op];
        const text = op as OpOf<"llm.text">;
        if (text.role === "system") return [op];
        return [
            {
                op: "openai_responses.input",
                item: messageItem(text.role, text.content),
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
                `openai_responses request lower: unsupported image role ${JSON.stringify(image.role)}`,
            );
        }
        return [
            {
                op: "openai_responses.input",
                item: {
                    type: "message" as const,
                    role: "user" as const,
                    content: [
                        {
                            type: "input_image",
                            image_url:
                                image.source.type === "url"
                                    ? image.source.url
                                    : dataUrlFromBase64(image.source),
                        },
                    ],
                },
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
            "openai_responses request lower llm.document",
        );
        if (document.source.type === "base64" && !document.source.filename) {
            throw new LintError(
                "openai_responses request lower: llm.document base64 sources require filename",
            );
        }
        return [
            {
                op: "openai_responses.input",
                item: {
                    type: "message" as const,
                    role: "user" as const,
                    content: [
                        {
                            type: "input_file",
                            ...(document.source.filename
                                ? { filename: document.source.filename }
                                : {}),
                            ...(document.source.type === "url"
                                ? { file_url: document.source.url }
                                : {
                                      file_data: mediaDataUrlFromBase64(
                                          document.source,
                                          "document",
                                          "openai_responses request lower llm.document",
                                      ),
                                  }),
                        },
                    ],
                },
            },
        ];
    });
}

export function mergeAdjacentMessageInputs(program: Program): Program {
    const out: Program = [];
    for (const op of program) {
        const item =
            op.op === "openai_responses.input"
                ? opData<{
                      item: { type?: string; role?: string; content?: unknown };
                  }>(op).item
                : undefined;
        const previous = out[out.length - 1];
        const previousItem =
            previous?.op === "openai_responses.input"
                ? opData<{
                      item: { type?: string; role?: string; content?: unknown };
                  }>(previous).item
                : undefined;
        if (
            item?.type === "message" &&
            previousItem?.type === "message" &&
            item.role === previousItem.role &&
            Array.isArray(item.content) &&
            Array.isArray(previousItem.content)
        ) {
            out[out.length - 1] = {
                ...previous,
                item: {
                    ...previousItem,
                    content: [...previousItem.content, ...item.content],
                },
            } as Op;
            continue;
        }
        out.push(op);
    }
    return out;
}

const FUNCTION_CALL_ITEM = "openai_responses.function_call_item";

export function lowerToolCalls(program: Program): Program {
    const itemIds = functionCallItemIds(program);
    return program.flatMap((op, index) => {
        if (op.op === FUNCTION_CALL_ITEM) return [];
        if (op.op !== "llm.tool_call") return [op];
        const call = op as OpOf<"llm.tool_call">;
        const itemId = itemIds.get(index);
        return [
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call" as const,
                    call_id: call.id,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                    ...(itemId ? { id: itemId } : {}),
                },
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
                op: "openai_responses.input",
                item: {
                    type: "function_call_output" as const,
                    call_id: result.id,
                    output: result.content,
                },
            },
        ];
    });
}

function functionCallItemIds(program: Program): Map<number, string> {
    const latestIndexById = new Map<string, number>();
    const itemIds = new Map<number, string>();
    for (const [index, op] of program.entries()) {
        if (op.op === FUNCTION_CALL_ITEM) {
            const side = opData<{ of: string; itemId: string }>(op);
            const targetIndex = latestIndexById.get(side.of);
            if (
                targetIndex == null ||
                program[targetIndex]?.op !== "llm.tool_call"
            ) {
                throw new LintError(
                    `${FUNCTION_CALL_ITEM} references ${JSON.stringify(side.of)}, which does not resolve to an earlier llm.tool_call`,
                );
            }
            itemIds.set(targetIndex, side.itemId);
        }
        const id = opData<{ id?: unknown }>(op).id;
        if (typeof id === "string") latestIndexById.set(id, index);
    }
    return itemIds;
}

export function lowerStopReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "response.stop"
            ? [
                  {
                      op: "openai_responses.finish_reason",
                      reason: lowerStopReason(
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
                op: "openai_responses.usage",
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

interface PendingFunctionCall {
    call: OpOf<"llm.tool_call">;
    itemId?: string;
}

// Rebuilds the response's output array. output_meta residuals (present when
// the program was raised from a real Responses API response) act as
// templates that consume the pending core ops in order; core ops with no
// meta left over get synthesized items.
export function collectOutputItems(program: Program): Program {
    const out: Program = [];
    const pendingTexts: OpOf<"llm.text">[] = [];
    const pendingToolCalls: PendingFunctionCall[] = [];
    const itemIds = functionCallItemIds(program);
    const output: WireOutputItem[] = [];

    for (const [index, op] of program.entries()) {
        switch (op.op) {
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new Error(
                        `openai_responses response lower: unexpected ${text.role} text in a response program`,
                    );
                }
                pendingTexts.push(text);
                break;
            }
            case "llm.tool_call": {
                pendingToolCalls.push({
                    call: op as OpOf<"llm.tool_call">,
                    itemId: itemIds.get(index),
                });
                break;
            }
            case "llm.image":
                throw new LintError(
                    "openai_responses response lower: llm.image cannot be sent in a response program",
                );
            case "llm.audio":
                throw new LintError(
                    "openai_responses response lower: llm.audio cannot be sent in a response program",
                );
            case "llm.document":
                throw new LintError(
                    "openai_responses response lower: llm.document cannot be sent in a response program",
                );
            case "llm.video":
                throw new LintError(
                    "openai_responses response lower: llm.video cannot be sent in a response program",
                );
            case "openai_responses.output":
                output.push(opData<{ item: WireOutputItem }>(op).item);
                break;
            case FUNCTION_CALL_ITEM:
                break;
            case "openai_responses.output_meta": {
                const meta = opData<{ item: Partial<WireOutputItem> }>(op).item;
                output.push(
                    outputFromMeta(meta, pendingTexts, pendingToolCalls),
                );
                pendingTexts.length = 0;
                pendingToolCalls.length = 0;
                break;
            }
            default:
                out.push(op);
        }
    }

    if (pendingTexts.length > 0) {
        output.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
                {
                    type: "output_text",
                    text: pendingTexts.map((text) => text.content).join("\n"),
                    annotations: [],
                    logprobs: [],
                },
            ],
        });
    }
    for (const pending of pendingToolCalls) {
        output.push({
            type: "function_call",
            id: pending.itemId ?? newFunctionCallItemId(),
            status: "completed",
            call_id: pending.call.id,
            name: pending.call.name,
            arguments: JSON.stringify(pending.call.arguments),
        });
    }
    for (const item of output)
        out.push({ op: "openai_responses.output", item });
    return out;
}

function outputFromMeta(
    meta: Partial<WireOutputItem>,
    pendingTexts: OpOf<"llm.text">[],
    pendingToolCalls: PendingFunctionCall[],
): WireOutputItem {
    switch (meta.type) {
        case "message":
            if (pendingToolCalls.length > 0) {
                throw new LintError(
                    "openai_responses response lower: message output metadata cannot consume tool calls",
                );
            }
            return messageFromMeta(meta, pendingTexts);
        case "function_call":
            if (pendingTexts.length > 0) {
                throw new LintError(
                    "openai_responses response lower: function_call output metadata cannot consume text",
                );
            }
            const item = functionCallFromMeta(meta, pendingToolCalls);
            if (pendingToolCalls.length > 0) {
                throw new LintError(
                    "openai_responses response lower: more core tool call ops than output metadata",
                );
            }
            return item;
        default:
            throw new LintError(
                `openai_responses response lower: output metadata has unsupported type ${JSON.stringify(meta.type)}`,
            );
    }
}

function messageFromMeta(
    meta: Partial<WireOutputMessage>,
    texts: OpOf<"llm.text">[],
): WireOutputMessage {
    const content = meta.content
        ? contentFromTemplate(meta.content, texts)
        : synthesizedContent(texts);
    return {
        ...meta,
        type: "message",
        role: "assistant",
        status: meta.status ?? "completed",
        content,
    };
}

function contentFromTemplate(
    content: WireContentPart[],
    texts: OpOf<"llm.text">[],
): WireContentPart[] {
    let textIndex = 0;
    const updated = content.map((part) => {
        if (
            (part.type !== "input_text" && part.type !== "output_text") ||
            typeof part.text !== "string"
        ) {
            throw new LintError(
                `openai_responses response lower: unsupported content part type ${JSON.stringify(part.type)}`,
            );
        }
        const text = texts[textIndex];
        if (!text) {
            throw new LintError(
                "openai_responses response lower: fewer core text ops than output content parts",
            );
        }
        textIndex += 1;
        return { ...part, text: text.content };
    });
    if (textIndex !== texts.length) {
        throw new LintError(
            "openai_responses response lower: more core text ops than output content parts",
        );
    }
    return updated;
}

function synthesizedContent(texts: OpOf<"llm.text">[]): WireContentPart[] {
    if (texts.length === 0) return [];
    return [
        {
            type: "output_text",
            text: texts.map((text) => text.content).join("\n"),
            annotations: [],
            logprobs: [],
        },
    ];
}

function functionCallFromMeta(
    meta: Partial<WireFunctionCall>,
    toolCalls: PendingFunctionCall[],
): WireFunctionCall {
    const index = meta.call_id
        ? toolCalls.findIndex((pending) => pending.call.id === meta.call_id)
        : toolCalls.length === 1
          ? 0
          : -1;
    if (index < 0) {
        throw new LintError(
            `openai_responses response lower: no core tool call for output metadata ${JSON.stringify(meta.call_id)}`,
        );
    }
    const [pending] = toolCalls.splice(index, 1);
    if (!pending) {
        throw new LintError(
            `openai_responses response lower: no core tool call for output metadata ${JSON.stringify(meta.call_id)}`,
        );
    }
    return {
        ...meta,
        type: "function_call",
        id: pending.itemId ?? newFunctionCallItemId(),
        status: meta.status ?? "completed",
        call_id: pending.call.id,
        name: pending.call.name,
        arguments: JSON.stringify(pending.call.arguments),
    };
}

function newFunctionCallItemId(): string {
    return `fc_${crypto.randomUUID().replaceAll("-", "")}`;
}

function lowerStopReason(
    reason: OpOf<"response.stop">["reason"],
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
                `openai_responses stop reason "${reason}" has no finish reason mapping`,
            );
    }
}
