import { describe, expect, test } from "bun:test";
import {
    raiseFinishReasons,
    raiseInputs,
    raiseOutputs,
    raiseUsage,
} from "../../../src/dialects/openai_responses/raise";

describe("openai_responses raise stages", () => {
    test("raiseInputs dispatches each wire input item type to its core op", () => {
        expect(
            raiseInputs([
                { op: "llm.model", model: "m" },
                {
                    op: "openai_responses.input",
                    item: { type: "message", role: "user", content: "hi" },
                },
                {
                    op: "openai_responses.input",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                },
                {
                    op: "openai_responses.input",
                    item: {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: "72F",
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: "72F" },
        ]);
    });

    test("raiseOutputs turns a wire output item into its core op plus output_meta", () => {
        expect(
            raiseOutputs([
                { op: "llm.model", model: "m" },
                {
                    op: "openai_responses.output",
                    item: {
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [
                            {
                                type: "output_text",
                                text: "pong",
                                annotations: [],
                                logprobs: [],
                            },
                        ],
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_responses.output_meta",
                item: {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: "pong",
                            annotations: [],
                            logprobs: [],
                        },
                    ],
                },
                appliesTo: "response",
            },
        ]);
    });

    test("raiseFinishReasons maps the wire finish_reason to a core response.stop", () => {
        expect(
            raiseFinishReasons([
                { op: "llm.model", model: "m" },
                { op: "openai_responses.finish_reason", reason: "tool_use" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "tool_use" },
        ]);
    });

    test("raiseUsage subtracts the details the body reports inside its totals and keeps the TTL breakdown as a residual", () => {
        expect(
            raiseUsage([
                { op: "llm.model", model: "m" },
                {
                    op: "openai_responses.usage",
                    usage: {
                        input_tokens: 2600,
                        input_tokens_details: {
                            cached_tokens: 2048,
                            cache_write_tokens: 500,
                            cache_write_tokens_details: {
                                ttl_30m_tokens: 500,
                                ttl_12h_tokens: 0,
                            },
                        },
                        output_tokens: 97,
                        output_tokens_details: { reasoning_tokens: 40 },
                        total_tokens: 2697,
                    },
                    appliesTo: "response",
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "response.usage",
                inputTokens: 52,
                cacheReadTokens: 2048,
                cacheWriteTokens: 500,
                outputTokens: 57,
                reasoningTokens: 40,
            },
            {
                op: "openai_responses.usage",
                usage: {
                    input_tokens_details: {
                        cache_write_tokens_details: {
                            ttl_30m_tokens: 500,
                            ttl_12h_tokens: 0,
                        },
                    },
                },
                appliesTo: "response",
            },
        ]);
    });

    test("raiseUsage leaves no residual when the body reports only the counts", () => {
        expect(
            raiseUsage([
                {
                    op: "openai_responses.usage",
                    usage: {
                        input_tokens: 12,
                        input_tokens_details: {
                            cached_tokens: 0,
                            cache_write_tokens: 0,
                        },
                        output_tokens: 2,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 14,
                    },
                },
            ]),
        ).toEqual([
            {
                op: "response.usage",
                inputTokens: 12,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 2,
                reasoningTokens: 0,
            },
        ]);
    });
});
