import { describe, expect, test } from "bun:test";
import {
    collectAssistantMessage,
    applyRequestTextMeta,
    applyRequestToolResultMeta,
    dropEmptyText,
    lintMidConversationSystem,
    lowerCompleteResponseToStreamEvents,
    lowerThinking,
    lowerRequestTexts,
    lowerRequestContentBlocks,
    lowerStructuredOutput,
    lowerStreamStopAndUsage,
    lowerStreamTextDeltas,
    lowerStreamToolCallDeltas,
    lowerStopReasons,
    lowerToolCalls,
    lowerToolResults,
    lowerUsageCounts,
    mergeAdjacentSameRole,
} from "../../../src/dialects/anthropic_messages/lower";

describe("anthropic_messages lower request stages", () => {
    test("lintMidConversationSystem passes when system text comes before conversation text", () => {
        const program = [
            { op: "llm.text", role: "system", content: "policy" },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        expect(lintMidConversationSystem(program)).toEqual(program);
    });

    test("lowerThinking maps core effort to Anthropic adaptive thinking", () => {
        expect(
            lowerThinking([
                { op: "llm.model", model: "m" },
                { op: "llm.thinking", effort: "medium" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.thinking",
                adaptiveEffort: "medium",
                display: "omitted",
            },
        ]);
    });

    test("lowerStructuredOutput maps llm.output to output_config.format", () => {
        expect(
            lowerStructuredOutput([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "check",
                    schema: {},
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.output_config",
                value: {
                    format: {
                        type: "json_schema",
                        schema: {},
                    },
                },
            },
        ]);
    });

    test("applyRequestTextMeta reattaches adjacent Anthropic cache metadata to text blocks", () => {
        expect(
            applyRequestTextMeta([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "user", content: "hi" },
                {
                    op: "anthropic_messages.text_meta",
                    fields: { cache_control: { type: "ephemeral" } },
                    required: false,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.content_block",
                role: "user",
                block: {
                    type: "text",
                    text: "hi",
                    cache_control: { type: "ephemeral" },
                },
            },
        ]);
    });

    test("dropEmptyText filters out llm.text ops with empty content", () => {
        expect(
            dropEmptyText([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "user", content: "" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);
    });

    test("lowerRequestTexts turns non-system llm.text into a single-block wire message", () => {
        expect(
            lowerRequestTexts([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "system", content: "be nice" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "system", content: "be nice" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "hi" }],
                },
            },
        ]);
    });

    test("lowerToolCalls turns llm.tool_call into a single-block assistant tool_use message", () => {
        expect(
            lowerToolCalls([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.tool_call",
                    id: "t1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "get_weather",
                            input: { city: "Paris" },
                        },
                    ],
                },
            },
        ]);
    });

    test("applyRequestToolResultMeta reattaches adjacent Anthropic cache metadata to tool_result blocks", () => {
        expect(
            applyRequestToolResultMeta([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.tool_result",
                    id: "toolu_1",
                    content: "done",
                },
                {
                    op: "anthropic_messages.tool_result_meta",
                    fields: { cache_control: { type: "ephemeral" } },
                    required: false,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.content_block",
                role: "user",
                block: {
                    type: "tool_result",
                    tool_use_id: "toolu_1",
                    content: "done",
                    cache_control: { type: "ephemeral" },
                },
            },
        ]);
    });

    test("lowerToolResults turns llm.tool_result into a single-block user tool_result message", () => {
        expect(
            lowerToolResults([
                { op: "llm.model", model: "m" },
                { op: "llm.tool_result", id: "t1", content: "72F", isError: true },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "t1",
                            content: "72F",
                            is_error: true,
                        },
                    ],
                },
            },
        ]);
    });

    test("lowerRequestContentBlocks turns request residual content blocks into wire messages", () => {
        expect(
            lowerRequestContentBlocks([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.content_block",
                    role: "user",
                    block: { type: "image", source: { type: "base64", data: "abc" } },
                    required: false,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", data: "abc" } },
                    ],
                },
            },
        ]);
    });

    test("mergeAdjacentSameRole folds consecutive same-role wire messages into one message's block list", () => {
        expect(
            mergeAdjacentSameRole([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.message",
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "first" }],
                    },
                },
                {
                    op: "anthropic_messages.message",
                    message: {
                        role: "user",
                        content: [{ type: "text", text: "second" }],
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "first" },
                        { type: "text", text: "second" },
                    ],
                },
            },
        ]);
    });
});

describe("anthropic_messages lower response stages", () => {
    test("lowerStopReasons maps response.stop back onto the wire stop_reason op", () => {
        expect(
            lowerStopReasons([
                { op: "llm.model", model: "m" },
                { op: "response.stop", reason: "end_turn" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "anthropic_messages.stop_reason", value: "end_turn" },
        ]);
    });

    test("lowerUsageCounts turns response.usage back into the wire usage op's input_tokens/output_tokens shape", () => {
        expect(
            lowerUsageCounts([
                { op: "llm.model", model: "m" },
                { op: "response.usage", inputTokens: 20, outputTokens: 9 },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.usage",
                usage: { input_tokens: 20, output_tokens: 9 },
            },
        ]);
    });

    test("collectAssistantMessage collapses response text and tool-call ops into one assistant message", () => {
        expect(
            collectAssistantMessage([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "assistant", content: "let me check" },
                {
                    op: "llm.tool_call",
                    id: "t1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
                { op: "response.stop", reason: "tool_use" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "tool_use" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "let me check" },
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "get_weather",
                            input: { city: "Paris" },
                        },
                    ],
                },
            },
        ]);
    });
});

describe("anthropic_messages lower stream response stages", () => {
    test("lowerCompleteResponseToStreamEvents turns a complete assistant response into Anthropic stream events", () => {
        const program = lowerCompleteResponseToStreamEvents([
            { op: "llm.model", model: "claude-sonnet-4-5" },
            { op: "llm.text", role: "assistant", content: "hi" },
            { op: "response.stop", reason: "end_turn" },
            { op: "response.usage", inputTokens: 3, outputTokens: 1 },
        ]);

        expect(program).toHaveLength(6);
        expect(program[0]).toMatchObject({
            op: "anthropic_messages.stream_event",
            event: {
                type: "message_start",
                message: {
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-5",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 3, output_tokens: 1 },
                },
            },
        });
        expect(program.slice(1)).toEqual([
            {
                op: "anthropic_messages.stream_event",
                event: {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                },
                appliesTo: "response",
            },
            {
                op: "anthropic_messages.stream_event",
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "hi" },
                },
                appliesTo: "response",
            },
            {
                op: "anthropic_messages.stream_event",
                event: { type: "content_block_stop", index: 0 },
                appliesTo: "response",
            },
            {
                op: "anthropic_messages.stream_event",
                event: {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { input_tokens: 3, output_tokens: 1 },
                },
                appliesTo: "response",
            },
            {
                op: "anthropic_messages.stream_event",
                event: { type: "message_stop" },
                appliesTo: "response",
            },
        ]);
    });

    test("lowerStreamTextDeltas maps generic text deltas to Anthropic content_block_delta events", () => {
        expect(
            lowerStreamTextDeltas([
                { op: "response.text_delta", index: 0, content: "hi" },
            ]),
        ).toEqual([
            {
                op: "anthropic_messages.stream_event",
                event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "hi" },
                },
                appliesTo: "response",
            },
        ]);
    });

    test("lowerStreamToolCallDeltas maps tool-call start metadata to an Anthropic content_block_start event", () => {
        expect(
            lowerStreamToolCallDeltas([
                {
                    op: "response.tool_call_delta",
                    index: 1,
                    id: "call_1",
                    name: "lookup",
                },
            ]),
        ).toEqual([
            {
                op: "anthropic_messages.stream_event",
                event: {
                    type: "content_block_start",
                    index: 1,
                    content_block: {
                        type: "tool_use",
                        id: "call_1",
                        name: "lookup",
                        input: {},
                    },
                },
                appliesTo: "response",
            },
        ]);
    });

    test("lowerStreamStopAndUsage combines generic stop and usage into a message_delta event", () => {
        expect(
            lowerStreamStopAndUsage([
                { op: "response.stop", reason: "max_tokens" },
                { op: "response.usage", inputTokens: 3, outputTokens: 1 },
            ]),
        ).toEqual([
            {
                op: "anthropic_messages.stream_event",
                event: {
                    type: "message_delta",
                    delta: { stop_reason: "max_tokens" },
                    usage: { input_tokens: 3, output_tokens: 1 },
                },
                appliesTo: "response",
            },
        ]);
    });
});
