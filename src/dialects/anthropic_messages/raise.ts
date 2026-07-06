// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import { opData, type Op, type Program, type StopReason } from "../../core/ops";
import { LintError } from "../../core/lint";
import { stagePipeline, type Stage } from "../../core/rewrite";
import {
    asBoolean,
    asRecord,
    asString,
    asStringArray,
    asThinkingEffort,
} from "../../core/wire";
import type {
    WireAnthropicMessage,
    WireAnthropicStreamEvent,
    WireBlock,
} from "./ops";

export const raiseStages: Stage[] = [
    raiseMessages,
    raiseOutputConfig,
    raiseRequestParams,
    raiseStopReasons,
    raiseUsage,
];

export const raise: Stage = stagePipeline(raiseStages);

export const raiseStreamResponseStages: Stage[] = [raiseStreamEvents];

export const raiseStreamResponse: Stage = stagePipeline(
    raiseStreamResponseStages,
);

export function raiseMessages(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "anthropic_messages.message"
            ? raiseMessage(
                  opData<{ message: WireAnthropicMessage }>(op).message,
              )
            : [op],
    );
}

export function raiseOutputConfig(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "anthropic_messages.output_config") return [op];

        const config = opData<{ value: Record<string, unknown> }>(op).value;
        const { effort, format, ...rest } = config;
        const out: Op[] = [];
        if (effort != null) {
            out.push({
                op: "llm.thinking",
                effort: asThinkingEffort(effort, "output_config.effort"),
            });
        }
        if (format == null) {
            if (Object.keys(rest).length > 0) out.push({ ...op, value: rest });
            return out.length > 0 ? out : [op];
        }

        const output = outputFromFormat(format);
        if (!output) {
            out.push({ ...op, value: { format, ...rest } });
            return out;
        }

        out.push(output);
        if (Object.keys(rest).length > 0) {
            out.push({ ...op, value: rest });
        }
        return out;
    });
}

export function raiseRequestParams(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op === "anthropic_messages.metadata") {
            return raiseMetadata(
                op,
                opData<{ value: Record<string, unknown> }>(op).value,
            );
        }
        if (op.op === "anthropic_messages.thinking_config") {
            return raiseThinkingConfig(
                op,
                opData<{ value: Record<string, unknown> }>(op).value,
            );
        }
        if (op.op === "anthropic_messages.context_management") {
            return [op];
        }
        return [op];
    });
}

export function raiseStopReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "anthropic_messages.stop_reason"
            ? [
                  {
                      op: "response.stop",
                      reason: raiseStopReason(
                          opData<{ value: string }>(op).value,
                      ),
                  } as Op,
              ]
            : [op],
    );
}

// Maps the cross-provider counts onto response.usage; any vendor-specific
// fields (cache counts, ...) stay behind as a droppable residual.
export function raiseUsage(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "anthropic_messages.usage") return [op];
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
                op: "anthropic_messages.usage",
                usage: rest,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
            });
        }
        return out;
    });
}

export function raiseStreamEvents(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "anthropic_messages.stream_event"
            ? raiseStreamEvent(
                  opData<{ event: WireAnthropicStreamEvent }>(op).event,
              )
            : [op],
    );
}

function raiseStreamEvent(event: WireAnthropicStreamEvent): Op[] {
    switch (event.type) {
        case "content_block_delta":
            return [raiseContentBlockDelta(event)];
        case "content_block_start":
            return [raiseContentBlockStart(event)];
        case "message_delta":
            return raiseMessageDelta(event);
        case "message_stop":
            return [
                {
                    op: "anthropic_messages.stream_event",
                    event,
                    appliesTo: "response",
                },
            ];
        default:
            throw new LintError(
                `anthropic_messages stream event ${JSON.stringify(event.type)} is unsupported`,
            );
    }
}

function raiseContentBlockDelta(event: WireAnthropicStreamEvent): Op {
    const delta = asRecord(
        event.delta,
        "anthropic_messages content_block_delta.delta",
    );
    switch (delta.type) {
        case "text_delta":
            return {
                op: "response.text_delta",
                index: streamIndex(event),
                content: asString(delta.text, "text_delta.text"),
            };
        case "input_json_delta":
            return {
                op: "response.tool_call_delta",
                index: streamIndex(event),
                arguments: asString(
                    delta.partial_json,
                    "input_json_delta.partial_json",
                ),
            };
        default:
            throw new LintError(
                `anthropic_messages content_block_delta ${JSON.stringify(delta.type)} is unsupported`,
            );
    }
}

function raiseContentBlockStart(event: WireAnthropicStreamEvent): Op {
    const block = asRecord(
        event.content_block,
        "anthropic_messages content_block_start.content_block",
    ) as WireBlock;
    if (block.type !== "tool_use") {
        throw new LintError(
            `anthropic_messages content_block_start ${JSON.stringify(block.type)} is unsupported`,
        );
    }
    const input = block.input ?? {};
    if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        Object.keys(input).length > 0
    ) {
        throw new LintError(
            "anthropic_messages content_block_start tool_use input must be empty; streamed input arrives as input_json_delta fragments",
        );
    }
    return {
        op: "response.tool_call_delta",
        index: streamIndex(event),
        id: block.id ?? missing("tool_use.id"),
        name: block.name ?? missing("tool_use.name"),
    };
}

function raiseMessageDelta(event: WireAnthropicStreamEvent): Op[] {
    const delta = asRecord(
        event.delta,
        "anthropic_messages message_delta.delta",
    );
    const out: Op[] = [];
    if (delta.stop_reason != null) {
        out.push({
            op: "response.stop",
            reason: raiseStopReason(
                asString(delta.stop_reason, "message_delta.delta.stop_reason"),
            ),
        });
    }
    if (event.usage != null) {
        out.push(
            ...raiseUsage([
                {
                    op: "anthropic_messages.usage",
                    usage: event.usage,
                    appliesTo: "response",
                },
            ]),
        );
    }
    if (out.length === 0) {
        throw new LintError(
            "anthropic_messages message_delta has no supported stop_reason or usage",
        );
    }
    return out;
}

function streamIndex(event: WireAnthropicStreamEvent): number {
    if (typeof event.index !== "number") {
        throw new Error(
            `anthropic_messages stream event ${JSON.stringify(event.type)}: missing numeric index`,
        );
    }
    return event.index;
}

function outputFromFormat(format: unknown): Op | undefined {
    const record = asRecord(format, "output_config.format");
    const { type, schema, ...rest } = record;
    if (type !== "json_schema") return undefined;
    if (Object.keys(rest).length > 0) return undefined;
    return {
        op: "llm.output",
        format: "json_schema",
        name: "anthropic_output",
        schema: asRecord(schema, "output_config.format.schema"),
    };
}

function raiseMetadata(op: Op, metadata: Record<string, unknown>): Op[] {
    const { user_id, ...rest } = metadata;
    const out: Op[] = [];
    if (user_id != null) {
        out.push({
            op: "request.user",
            value: asString(user_id, "metadata.user_id"),
        });
    }
    if (Object.keys(rest).length > 0) {
        out.push({ ...op, value: rest });
    }
    return out.length > 0 ? out : [op];
}

function raiseThinkingConfig(op: Op, thinking: Record<string, unknown>): Op[] {
    const { type, display, ...rest } = thinking;
    if (Object.keys(rest).length > 0) return [op];
    if (type === "disabled" && display == null) {
        return [];
    }
    if (type === "adaptive" && display === "omitted") {
        return [op];
    }
    return [op];
}

function raiseMessage(message: WireAnthropicMessage): Op[] {
    const { role, content } = message;
    if (typeof content === "string") {
        return [{ op: "llm.text", role, content }];
    }
    return content.flatMap((block) => raiseBlock(role, block));
}

function raiseBlock(role: "user" | "assistant", block: WireBlock): Op[] {
    switch (block.type) {
        case "text": {
            const text = textBlockWithOnlyCacheMeta(block);
            if (!text) {
                return [contentBlock(role, block)];
            }
            return [
                { op: "llm.text", role, content: text.content },
                ...(text.fields
                    ? [
                          {
                              op: "anthropic_messages.text_meta",
                              fields: text.fields,
                          } as Op,
                      ]
                    : []),
            ];
        }
        case "tool_use":
            if (!hasOnlyKeys(block, ["type", "id", "name", "input"])) {
                return [contentBlock(role, block)];
            }
            return [
                {
                    op: "llm.tool_call",
                    id: block.id ?? missing("tool_use.id"),
                    name: block.name ?? missing("tool_use.name"),
                    arguments: block.input ?? {},
                },
            ];
        case "tool_result":
            if (
                !hasOnlyKeys(block, [
                    "type",
                    "tool_use_id",
                    "content",
                    "is_error",
                    "cache_control",
                ])
            ) {
                return [contentBlock(role, block)];
            }
            {
                const content = tryFlattenResultContent(block.content);
                if (content == null) return [contentBlock(role, block)];
                const id =
                    block.tool_use_id ?? missing("tool_result.tool_use_id");
                const fields = toolResultMetaFields(block);
                return [
                    {
                        op: "llm.tool_result",
                        id,
                        content,
                    },
                    ...(fields || block.is_error
                        ? [
                              {
                                  op: "anthropic_messages.tool_result_meta",
                                  id,
                                  ...(fields ? { fields } : {}),
                                  ...(block.is_error ? { is_error: true } : {}),
                              } as Op,
                          ]
                        : []),
                ];
            }
        case "thinking":
        case "redacted_thinking":
            return [
                {
                    ...contentBlock(role, block),
                    appliesTo: "response",
                },
            ];
        default:
            return [contentBlock(role, block)];
    }
}

function contentBlock(role: "user" | "assistant", block: WireBlock): Op {
    return {
        op: "anthropic_messages.content_block",
        block,
        role,
        ...(role === "assistant" ? { appliesTo: "response" as const } : {}),
    };
}

function tryFlattenResultContent(content: WireBlock["content"]): string | null {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (
                !hasOnlyKeys(block, ["type", "text"]) ||
                block.type !== "text"
            ) {
                return null;
            }
            parts.push(block.text ?? "");
        }
        return parts.join("");
    }
    return null;
}

function toolResultMetaFields(
    block: WireBlock,
): Record<string, unknown> | undefined {
    const fields: Record<string, unknown> = {};
    if (Array.isArray(block.content)) fields.content = block.content;
    if (block.cache_control != null) fields.cache_control = block.cache_control;
    return Object.keys(fields).length > 0 ? fields : undefined;
}

function missing(field: string): never {
    throw new Error(`anthropic_messages block: missing ${field}`);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function textBlockWithOnlyCacheMeta(
    block: WireBlock,
): { content: string; fields?: Record<string, unknown> } | undefined {
    const { type, text, cache_control, ...rest } = block;
    if (type !== "text" || typeof text !== "string") return undefined;
    if (Object.keys(rest).length > 0) return undefined;
    if (cache_control == null) return { content: text };
    return { content: text, fields: { cache_control } };
}

const WIRE_STOP_REASONS: Record<string, StopReason> = {
    end_turn: "end_turn",
    max_tokens: "max_tokens",
    tool_use: "tool_use",
    stop_sequence: "stop_sequence",
    refusal: "refusal",
    pause_turn: "pause_turn",
    model_context_window_exceeded: "model_context_window_exceeded",
};

export function raiseStopReason(value: string): StopReason {
    const reason = WIRE_STOP_REASONS[value];
    if (!reason)
        throw new LintError(
            `anthropic_messages stop_reason "${value}" has no core stop reason mapping`,
        );
    return reason;
}
