import { describe, expect, test } from "bun:test";
import {
    raiseMessages,
    raiseOutputConfig,
    raiseRequestParams,
    raiseStopReasons,
    raiseStreamEvents,
    raiseUsage,
} from "../../../src/dialects/anthropic_messages/raise";

describe("anthropic_messages raise stages", () => {
    test("raiseMessages flattens a wire message's content blocks into core ops", () => {
        expect(
            raiseMessages([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.message",
                    message: {
                        role: "assistant",
                        content: [
                            { type: "text", text: "hi" },
                            {
                                type: "tool_use",
                                id: "t1",
                                name: "get_weather",
                                input: { city: "Paris" },
                            },
                        ],
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "hi" },
            {
                op: "llm.tool_call",
                id: "t1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
        ]);
    });

    test("raiseOutputConfig maps Anthropic json_schema format and effort onto core ops", () => {
        expect(
            raiseOutputConfig([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.output_config",
                    value: {
                        effort: "medium",
                        format: {
                            type: "json_schema",
                            schema: { type: "object" },
                        },
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.thinking", effort: "medium" },
            {
                op: "llm.output",
                format: "json_schema",
                name: "anthropic_output",
                schema: { type: "object" },
            },
        ]);
    });

    test("raiseRequestParams maps shared Anthropic request params onto core ops and marks supported housekeeping droppable", () => {
        expect(
            raiseRequestParams([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.metadata",
                    value: { user_id: "user-123" },
                },
                { op: "request.stream", value: true },
                {
                    op: "anthropic_messages.thinking_config",
                    value: { type: "adaptive", display: "omitted" },
                },
                {
                    op: "anthropic_messages.context_management",
                    value: {
                        edits: [
                            {
                                type: "clear_thinking_20251015",
                                keep: "all",
                            },
                        ],
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "request.user", value: "user-123" },
            { op: "request.stream", value: true },
            {
                op: "anthropic_messages.thinking_config",
                value: { type: "adaptive", display: "omitted" },
            },
            {
                op: "anthropic_messages.context_management",
                value: {
                    edits: [
                        {
                            type: "clear_thinking_20251015",
                            keep: "all",
                        },
                    ],
                },
            },
        ]);
    });

    test("raiseStopReasons maps the wire stop_reason value onto response.stop", () => {
        expect(
            raiseStopReasons([
                { op: "llm.model", model: "m" },
                { op: "anthropic_messages.stop_reason", value: "end_turn" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("raiseUsage splits the wire usage object into the core parts plus a residual for the fields core does not model", () => {
        expect(
            raiseUsage([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.usage",
                    usage: {
                        input_tokens: 20,
                        output_tokens: 9,
                        cache_read_input_tokens: 3,
                        cache_creation_input_tokens: 4,
                        cache_creation: {
                            ephemeral_5m_input_tokens: 4,
                            ephemeral_1h_input_tokens: 0,
                        },
                        service_tier: "standard",
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "response.usage",
                inputTokens: 20,
                cacheReadTokens: 3,
                cacheWriteTokens: 4,
                outputTokens: 9,
            },
            {
                op: "anthropic_messages.usage",
                usage: {
                    cache_creation: {
                        ephemeral_5m_input_tokens: 4,
                        ephemeral_1h_input_tokens: 0,
                    },
                    service_tier: "standard",
                },
            },
        ]);
    });

    test("raiseUsage subtracts thinking_tokens from output_tokens and keeps no residual when the body reports only counts", () => {
        expect(
            raiseUsage([
                {
                    op: "anthropic_messages.usage",
                    usage: {
                        input_tokens: 52,
                        cache_read_input_tokens: 2048,
                        cache_creation_input_tokens: 500,
                        output_tokens: 97,
                        output_tokens_details: { thinking_tokens: 40 },
                    },
                },
            ]),
        ).toEqual([
            {
                op: "response.usage",
                inputTokens: 52,
                cacheReadTokens: 2048,
                cacheWriteTokens: 500,
                outputTokens: 57,
                reasoningTokens: 40,
            },
        ]);
    });

    test("raiseUsage reads a thinking_tokens key the details object omits as its default 0, and a missing details object as no count", () => {
        const zeroFromDefault = raiseUsage([
            {
                op: "anthropic_messages.usage",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    output_tokens_details: {},
                },
            },
        ]);
        expect(zeroFromDefault).toEqual([
            {
                op: "response.usage",
                inputTokens: 10,
                outputTokens: 5,
                reasoningTokens: 0,
            },
        ]);

        const noDetails = raiseUsage([
            {
                op: "anthropic_messages.usage",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    output_tokens_details: null,
                },
            },
        ]);
        expect(noDetails).toEqual([
            { op: "response.usage", inputTokens: 10, outputTokens: 5 },
        ]);
    });

    test("raiseUsage fails on a thinking_tokens count larger than output_tokens", () => {
        expect(() =>
            raiseUsage([
                {
                    op: "anthropic_messages.usage",
                    usage: {
                        input_tokens: 10,
                        output_tokens: 5,
                        output_tokens_details: { thinking_tokens: 6 },
                    },
                },
            ]),
        ).toThrow(
            /output_tokens_details\.thinking_tokens 6 exceeds the remaining output_tokens 5/,
        );
    });
});

describe("anthropic_messages stream raise stages", () => {
    test("raiseStreamEvents maps Anthropic stream deltas into generic stream ops", () => {
        expect(
            raiseStreamEvents([
                {
                    op: "anthropic_messages.stream_event",
                    event: {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: "hi" },
                    },
                },
                {
                    op: "anthropic_messages.stream_event",
                    event: {
                        type: "message_delta",
                        delta: { stop_reason: "end_turn" },
                        usage: { output_tokens: 2 },
                    },
                },
            ]),
        ).toEqual([
            { op: "response.text_delta", index: 0, content: "hi" },
            { op: "response.stop", reason: "end_turn" },
            { op: "response.usage", outputTokens: 2 },
        ]);
    });
});
