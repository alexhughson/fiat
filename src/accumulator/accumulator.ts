import type { Op, OpOf, Program } from "../core/ops.js";
import { inferStopReason, stopReasonFromFiat } from "./stop-reason.js";
import type {
    AssistantAccumulator,
    AssistantAccumulatorOptions,
    AssistantMessage,
    AssistantTextBlock,
    AssistantToolCall,
    AssistantUsage,
    AccumulatorEvent,
} from "./types.js";

type InternalToolCall = AssistantToolCall & { partialJson: string };

function emptyUsage(): AssistantUsage {
    return { inputTokens: 0, outputTokens: 0 };
}

function createInitialMessage(model?: string): AssistantMessage {
    return {
        content: [],
        model,
        stopReason: "stop",
        usage: emptyUsage(),
    };
}

function parseToolArguments(
    raw: string,
    callId: string,
): Record<string, unknown> {
    if (raw.trim().length === 0) {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(
            `Tool call ${callId} arguments are not valid JSON: ${raw}`,
        );
    }
    if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
    ) {
        throw new Error(`Tool call ${callId} arguments must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

function foldUsage(
    op: OpOf<"response.usage">,
    current: AssistantUsage,
): AssistantUsage {
    const next: AssistantUsage = {
        inputTokens: op.inputTokens ?? current.inputTokens,
        outputTokens: op.outputTokens ?? current.outputTokens,
    };
    const cacheRead = op.cacheReadTokens ?? current.cacheReadTokens;
    const cacheWrite = op.cacheWriteTokens ?? current.cacheWriteTokens;
    if (cacheRead !== undefined) {
        next.cacheReadTokens = cacheRead;
    }
    if (cacheWrite !== undefined) {
        next.cacheWriteTokens = cacheWrite;
    }
    return next;
}

/**
 * Folds a sequence of raised Fiat programs into a canonical assistant message.
 *
 * **Input contract:** feed programs produced by `Translator.fromStreamResponse` /
 * `Translator.fromResponse` (raised ops). Dialect residual ops (e.g.
 * `openai_chat.body_field`) are deliberately ignored, so folding raw wire
 * programs loses usage, response id, and other metadata that only appears after
 * raise.
 *
 * **Event ownership:** the accumulator emits `done` from `finish()`. Transport-
 * level start / error / aborted events belong to the caller.
 */
export function createAssistantAccumulator(
    options: AssistantAccumulatorOptions = {},
): AssistantAccumulator {
    const output = createInitialMessage(options.model);
    const emit = options.onEvent;

    let currentTextBlock: AssistantTextBlock | null = null;
    const toolCallsByIndex = new Map<number, InternalToolCall>();
    const toolCallsById = new Map<string, InternalToolCall>();

    const contentIndex = (block: AssistantTextBlock | InternalToolCall): number =>
        output.content.indexOf(block);

    const ensureTextBlock = (): AssistantTextBlock => {
        if (currentTextBlock === null) {
            currentTextBlock = { type: "text", text: "" };
            output.content.push(currentTextBlock);
            emit?.({
                contentIndex: contentIndex(currentTextBlock),
                partial: output,
                type: "text_start",
            });
        }
        return currentTextBlock;
    };

    const finishTextBlock = (): void => {
        if (currentTextBlock === null) {
            return;
        }
        emit?.({
            content: currentTextBlock.text,
            contentIndex: contentIndex(currentTextBlock),
            partial: output,
            type: "text_end",
        });
        currentTextBlock = null;
    };

    const ensureToolCall = (
        index: number,
        id: string | undefined,
    ): InternalToolCall => {
        const existingById = id === undefined ? undefined : toolCallsById.get(id);
        if (existingById !== undefined) {
            return existingById;
        }
        const existingByIndex = toolCallsByIndex.get(index);
        if (existingByIndex !== undefined) {
            if (id !== undefined && existingByIndex.id !== id) {
                toolCallsById.delete(existingByIndex.id);
                existingByIndex.id = id;
                toolCallsById.set(id, existingByIndex);
            }
            return existingByIndex;
        }

        finishTextBlock();
        const toolCall: InternalToolCall = {
            arguments: {},
            id: id ?? `call_${index}`,
            name: "",
            partialJson: "",
            type: "tool_call",
        };
        output.content.push(toolCall);
        toolCallsByIndex.set(index, toolCall);
        toolCallsById.set(toolCall.id, toolCall);
        emit?.({
            contentIndex: contentIndex(toolCall),
            partial: output,
            type: "toolcall_start",
        });
        return toolCall;
    };

    const pushOp = (op: Op): void => {
        if (op.op === "response.text_delta") {
            const block = ensureTextBlock();
            const content = String(op.content);
            block.text += content;
            if (content.length > 0) {
                emit?.({
                    contentIndex: contentIndex(block),
                    delta: content,
                    partial: output,
                    type: "text_delta",
                });
            }
            return;
        }

        if (op.op === "llm.text" && op.role === "assistant") {
            const block = ensureTextBlock();
            block.text += String(op.content);
            return;
        }

        if (op.op === "response.tool_call_delta") {
            const index = typeof op.index === "number" ? op.index : 0;
            const toolCall = ensureToolCall(
                index,
                typeof op.id === "string" ? op.id : undefined,
            );
            if (typeof op.name === "string") {
                toolCall.name = op.name;
            }
            if (typeof op.arguments === "string") {
                toolCall.partialJson += op.arguments;
                emit?.({
                    contentIndex: contentIndex(toolCall),
                    delta: op.arguments,
                    partial: output,
                    type: "toolcall_delta",
                });
            }
            return;
        }

        if (op.op === "llm.tool_call") {
            const call = op as OpOf<"llm.tool_call">;
            const index = toolCallsByIndex.size;
            const toolCall = ensureToolCall(index, call.id);
            toolCall.name = call.name;
            toolCall.arguments = call.arguments;
            toolCall.partialJson = JSON.stringify(call.arguments);
            return;
        }

        if (op.op === "response.stop") {
            const stop = op as OpOf<"response.stop">;
            output.stopReason = stopReasonFromFiat(stop.reason);
            return;
        }

        if (op.op === "response.usage") {
            output.usage = foldUsage(op as OpOf<"response.usage">, output.usage);
            return;
        }

        if (op.op === "response.id") {
            const id = op as OpOf<"response.id">;
            output.responseId ??= id.id;
            return;
        }

        if (op.op === "llm.model") {
            const model = op as OpOf<"llm.model">;
            if (options.model !== undefined && model.model !== options.model) {
                output.responseModel = model.model;
            } else if (options.model === undefined) {
                output.model = model.model;
            }
        }
    };

    return {
        get message() {
            return output;
        },
        push(program: Program) {
            for (const op of program) {
                pushOp(op);
            }
        },
        finish() {
            finishTextBlock();
            for (const toolCall of toolCallsByIndex.values()) {
                toolCall.arguments = parseToolArguments(
                    toolCall.partialJson,
                    toolCall.id,
                );
                delete (toolCall as { partialJson?: string }).partialJson;
                emit?.({
                    contentIndex: contentIndex(toolCall),
                    partial: output,
                    toolCall: {
                        type: "tool_call",
                        id: toolCall.id,
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                    },
                    type: "toolcall_end",
                });
            }
            output.stopReason = inferStopReason(
                output.stopReason,
                output.content,
            );
            emit?.({
                message: output,
                reason: output.stopReason,
                type: "done",
            });
            return output;
        },
    };
}
