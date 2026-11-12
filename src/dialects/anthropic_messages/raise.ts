// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import {
    opData,
    type Op,
    type Program,
    type StopReason,
} from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import * as reasoning from "../../core/reasoning.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import {
    asBoolean,
    asRecord,
    asString,
    asStringArray,
    asThinkingEffort,
} from "../../core/wire.js";
import type {
    WireAnthropicMessage,
    WireAnthropicStreamEvent,
    WireBlock,
} from "./ops.js";

export const raiseStages: Stage[] = [
    raiseMessages,
    raiseReasoning,
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

// A thinking or redacted_thinking block with fields this function does not
// know stays an anthropic_messages.content_block.
export function raiseReasoning(program: Program): Program {
    const nextId = reasoning.reasoningIds();
    return program.flatMap((op): Op[] => {
        if (op.op !== "anthropic_messages.content_block") return [op];
        const { block, role } = opData<{ block: WireBlock; role?: string }>(op);
        if (role !== "assistant") return [op];
        if (
            block.type === "thinking" &&
            typeof block.thinking === "string" &&
            typeof block.signature === "string" &&
            hasOnlyKeys(block, ["type", "thinking", "signature"])
        ) {
            return [
                {
                    op: "llm.reasoning",
                    id: nextId(),
                    content: block.thinking,
                    signature: {
                        dialect: "anthropic_messages",
                        value: block.signature,
                    },
                },
            ];
        }
        if (
            block.type === "redacted_thinking" &&
            typeof block.data === "string" &&
            hasOnlyKeys(block, ["type", "data"])
        ) {
            const id = nextId();
            return [
                { op: "llm.reasoning", id, content: "" },
                {
                    op: "anthropic_messages.redacted_thinking",
                    of: id,
                    data: block.data,
                },
            ];
        }
        return [op];
    });
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
        case "content_block_stop":
            return [
                {
                    op: "response.block_stop",
                    index: streamIndex(event),
                },
            ];
        case "message_delta":
            return raiseMessageDelta(event);
        case "message_start":
            return raiseMessageStart(event);
        case "message_stop":
        // ping keeps the connection open and carries no other meaning; only
        // anthropic sends it, so it stays a dialect op.
        case "ping":
            return [streamEventResidual(event)];
        default:
            throw new LintError(
                `anthropic_messages stream event ${JSON.stringify(event.type)} is unsupported`,
            );
    }
}

function streamEventResidual(event: WireAnthropicStreamEvent): Op {
    return {
        op: "anthropic_messages.stream_event",
        event,
        appliesTo: "response",
    };
}

// The message envelope's model, id, and input usage raise to core ops
// (llm.model, response.id, response.usage). A message_start also always
// carries role "assistant", type "message", an empty content list, and null
// stop_reason and stop_sequence; lowerStreamMessageStart writes those back.
// Any key whose value differs from what lowerStreamMessageStart writes, or
// that the raiser does not know, stays in the stream_event residual, and the
// residual exists only when such a key is present.
function raiseMessageStart(event: WireAnthropicStreamEvent): Op[] {
    const message = asRecord(
        event.message,
        "anthropic_messages message_start.message",
    );
    const out: Op[] = [];
    if (typeof message.model === "string") {
        out.push({ op: "llm.model", model: message.model });
    }
    if (typeof message.id === "string") {
        out.push({ op: "response.id", id: message.id });
    }
    if (message.usage != null) {
        out.push(
            ...raiseUsage([
                {
                    op: "anthropic_messages.usage",
                    usage: asRecord(
                        message.usage,
                        "anthropic_messages message_start.message.usage",
                    ),
                    appliesTo: "response",
                },
            ]),
        );
    }
    const rest = dropWrittenBackKeys(message);
    if (Object.keys(rest).length > 0) {
        out.push(streamEventResidual({ ...event, message: rest }));
    }
    return out;
}

// The keys whose values lowerStreamMessageStart writes back unchanged: the
// constants a message_start always carries, and the keys raised to core ops.
// Returns a shallow copy of message without those keys; a key that differs
// from its written-back value stays in the returned object.
function dropWrittenBackKeys(message: Record<string, unknown>) {
    const writtenBack: Record<string, unknown> = {
        model: typeof message.model === "string" ? message.model : undefined,
        id: typeof message.id === "string" ? message.id : undefined,
        usage: message.usage,
        role: "assistant",
        type: "message",
        content: [],
        stop_reason: null,
        stop_sequence: null,
    };
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(message)) {
        if (!(key in writtenBack) || !deepEqual(value, writtenBack[key])) {
            rest[key] = value;
        }
    }
    return rest;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== "object" || a === null) return false;
    if (typeof b !== "object" || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
        if (
            !deepEqual(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
            )
        ) {
            return false;
        }
    }
    return true;
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
    if (block.type === "text") {
        // The block opens empty and its text arrives as text_delta events.
        return {
            op: "response.text_start",
            index: streamIndex(event),
        };
    }
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
            const text = textBlockWithMeta(block);
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
        case "image": {
            const image = imageBlock(role, block);
            return image ? [image] : [contentBlock(role, block)];
        }
        case "document": {
            const document = documentBlock(role, block);
            return document ? [document] : [contentBlock(role, block)];
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

function imageBlock(role: "user" | "assistant", block: WireBlock): Op | null {
    if (role !== "user" || !hasOnlyKeys(block, ["type", "source"])) {
        return null;
    }
    const source = block.source;
    if (
        typeof source !== "object" ||
        source === null ||
        Array.isArray(source)
    ) {
        return null;
    }
    const record = source as Record<string, unknown>;
    if (record.type === "url" && hasOnlyKeys(record, ["type", "url"])) {
        return {
            op: "llm.image",
            role: "user",
            source: { type: "url", url: asString(record.url, "image.url") },
        };
    }
    if (
        record.type === "base64" &&
        hasOnlyKeys(record, ["type", "media_type", "data"])
    ) {
        const mediaType = asString(record.media_type, "image.media_type");
        if (!mediaType.startsWith("image/")) return null;
        return {
            op: "llm.image",
            role: "user",
            source: {
                type: "base64",
                mediaType,
                data: asString(record.data, "image.data"),
            },
        };
    }
    return null;
}

function documentBlock(
    role: "user" | "assistant",
    block: WireBlock,
): Op | null {
    if (role !== "user" || !hasOnlyKeys(block, ["type", "source"])) {
        return null;
    }
    const source = block.source;
    if (
        typeof source !== "object" ||
        source === null ||
        Array.isArray(source)
    ) {
        return null;
    }
    const record = source as Record<string, unknown>;
    if (record.type === "url" && hasOnlyKeys(record, ["type", "url"])) {
        return {
            op: "llm.document",
            role: "user",
            source: { type: "url", url: asString(record.url, "document.url") },
        };
    }
    if (
        record.type === "base64" &&
        hasOnlyKeys(record, ["type", "media_type", "data"])
    ) {
        const mediaType = asString(record.media_type, "document.media_type");
        if (mediaType !== "application/pdf") return null;
        return {
            op: "llm.document",
            role: "user",
            source: {
                type: "base64",
                mediaType,
                data: asString(record.data, "document.data"),
            },
        };
    }
    return null;
}

function contentBlock(role: "user" | "assistant", block: WireBlock): Op {
    return {
        op: "anthropic_messages.content_block",
        block,
        role,
        ...(role === "user" && isMediaBlock(block)
            ? { preservesContent: true }
            : {}),
        ...(role === "assistant" ? { appliesTo: "response" as const } : {}),
    };
}

function isMediaBlock(block: WireBlock): boolean {
    return block.type === "image" || block.type === "document";
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

function textBlockWithMeta(
    block: WireBlock,
): { content: string; fields?: Record<string, unknown> } | undefined {
    const { type, text, ...fields } = block;
    if (type !== "text" || typeof text !== "string") return undefined;
    if (Object.keys(fields).length === 0) return { content: text };
    return { content: text, fields };
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
