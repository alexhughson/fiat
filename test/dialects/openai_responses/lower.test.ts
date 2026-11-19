import { describe, expect, test } from "bun:test";
import {
    collectOutputItems,
    lowerRequestTexts,
    lowerStopReasons,
    lowerToolCalls,
    lowerToolResults,
    lowerUsageCounts,
    rejectStructuredOutput,
} from "../../../src/dialects/openai_responses/lower";

describe("openai_responses lower request stages", () => {
    test("rejectStructuredOutput passes a request with no structured output", () => {
        const program = [{ op: "llm.model", model: "m" }];

        expect(rejectStructuredOutput(program)).toEqual(program);
    });

    test("lowerRequestTexts converts non-system core text to a message input item", () => {
        expect(
            lowerRequestTexts([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "system", content: "sys" },
                { op: "llm.text", role: "user", content: "hi" },
                { op: "llm.text", role: "assistant", content: "hello" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "system", content: "sys" },
            {
                op: "openai_responses.input",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            },
            {
                op: "openai_responses.input",
                item: {
                    type: "message",
                    role: "assistant",
                    content: "hello",
                },
            },
        ]);
    });

    test("lowerToolCalls converts a core tool call into a function_call input item", () => {
        expect(
            lowerToolCalls([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            },
        ]);
    });

    test("lowerToolResults converts a core tool result into a function_call_output input item", () => {
        expect(
            lowerToolResults([
                { op: "llm.model", model: "m" },
                { op: "llm.tool_result", id: "call_1", content: "72F" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call_output",
                    call_id: "call_1",
                    output: "72F",
                },
            },
        ]);
    });
});

describe("openai_responses lower response stages", () => {
    test("lowerStopReasons narrows core stop reasons onto wire finish reasons", () => {
        expect(
            lowerStopReasons([
                { op: "llm.model", model: "m" },
                { op: "response.stop", reason: "refusal" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "openai_responses.finish_reason", reason: "content_filter" },
        ]);
    });

    test("lowerUsageCounts sums the core parts into the wire totals, and requires a number for every key", () => {
        expect(
            lowerUsageCounts([
                { op: "llm.model", model: "m" },
                {
                    op: "response.usage",
                    inputTokens: 52,
                    cacheReadTokens: 2048,
                    cacheWriteTokens: 500,
                    outputTokens: 57,
                    reasoningTokens: 40,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.usage",
                usage: {
                    input_tokens: 2600,
                    input_tokens_details: {
                        cached_tokens: 2048,
                        cache_write_tokens: 500,
                    },
                    output_tokens: 97,
                    output_tokens_details: { reasoning_tokens: 40 },
                    total_tokens: 2697,
                },
            },
        ]);
    });

    test("lowerUsageCounts writes 0 for required numbers whose parts the source did not report", () => {
        expect(
            lowerUsageCounts([
                { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            ]),
        ).toEqual([
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
        ]);
        expect(
            lowerUsageCounts([
                {
                    op: "response.usage",
                    inputTokens: 12,
                    cacheReadTokens: 3,
                    outputTokens: 2,
                    reasoningTokens: 1,
                },
            ]),
        ).toEqual([
            {
                op: "openai_responses.usage",
                usage: {
                    input_tokens: 15,
                    input_tokens_details: {
                        cached_tokens: 3,
                        cache_write_tokens: 0,
                    },
                    output_tokens: 3,
                    output_tokens_details: { reasoning_tokens: 1 },
                    total_tokens: 18,
                },
            },
        ]);
    });

    test("collectOutputItems reunites pending core ops with output_meta templates and synthesizes leftovers", () => {
        expect(
            collectOutputItems([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "assistant", content: "hi" },
                {
                    op: "openai_responses.output_meta",
                    item: {
                        id: "msg_1",
                        type: "message",
                        content: [
                            {
                                type: "output_text",
                                text: "placeholder",
                                annotations: [],
                                logprobs: [],
                            },
                        ],
                    },
                    appliesTo: "response",
                },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.output",
                item: {
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: "hi",
                            annotations: [],
                            logprobs: [],
                        },
                    ],
                },
            },
            {
                op: "openai_responses.output",
                item: {
                    type: "function_call",
                    status: "completed",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            },
        ]);
    });
});
