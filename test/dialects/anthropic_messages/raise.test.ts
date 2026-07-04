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
                required: false,
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
                required: false,
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

    test("raiseUsage splits cross-provider counts onto response.usage and keeps vendor-specific fields as a droppable residual", () => {
        expect(
            raiseUsage([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.usage",
                    usage: {
                        input_tokens: 20,
                        output_tokens: 9,
                        cache_read_input_tokens: 3,
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
            {
                op: "anthropic_messages.usage",
                usage: { cache_read_input_tokens: 3 },
                required: false,
            },
        ]);
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
