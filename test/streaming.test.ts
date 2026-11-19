import { describe, expect, spyOn, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
} from "../src/index";

function withWarnSpy<T>(
    run: (warn: ReturnType<typeof spyOn<Console, "warn">>) => T,
): T {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
        return run(warn);
    } finally {
        warn.mockRestore();
    }
}

describe("stream response conversion", () => {
    test("openai chat text chunks round-trip and raise to generic text deltas", () => {
        const chunk = {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    delta: { role: "assistant", content: "hi" },
                    finish_reason: null,
                    logprobs: null,
                },
            ],
        };

        expect(OpenAIChatTranslator.fromStreamResponse(chunk)).toEqual([
            {
                op: "openai_chat.body_field",
                key: "id",
                value: "chatcmpl-1",
                appliesTo: "response",
            },
            {
                op: "openai_chat.body_field",
                key: "object",
                value: "chat.completion.chunk",
                appliesTo: "response",
            },
            {
                op: "openai_chat.body_field",
                key: "created",
                value: 1700000000,
                appliesTo: "response",
            },
            { op: "llm.model", model: "gpt-4o" },
            {
                op: "openai_chat.stream_choice_param",
                key: "index",
                value: 0,
                appliesTo: "response",
            },
            {
                op: "openai_chat.stream_choice_param",
                key: "logprobs",
                value: null,
                appliesTo: "response",
            },
            { op: "response.text_delta", role: "assistant", content: "hi" },
        ]);
        expect(
            OpenAIChatTranslator.toStreamResponse(
                OpenAIChatTranslator.fromStreamResponse(chunk),
            ),
        ).toEqual(chunk);
    });

    test("openai chat tool-call argument fragments stay as strings", () => {
        const chunk = {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1700000000,
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                type: "function",
                                function: {
                                    name: "lookup",
                                    arguments: '{"x"',
                                },
                            },
                        ],
                    },
                    finish_reason: null,
                    logprobs: null,
                },
            ],
        };

        expect(OpenAIChatTranslator.fromStreamResponse(chunk)).toContainEqual({
            op: "response.tool_call_delta",
            index: 0,
            id: "call_1",
            name: "lookup",
            arguments: '{"x"',
        });
        expect(
            OpenAIChatTranslator.toStreamResponse(
                OpenAIChatTranslator.fromStreamResponse(chunk),
            ),
        ).toEqual(chunk);
    });

    test("openai responses text and terminal events round-trip", () => {
        const textEvent = {
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "hi",
        };
        const doneEvent = {
            type: "response.completed",
            response: {
                status: "completed",
                usage: {
                    input_tokens: 3,
                    input_tokens_details: {
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                    },
                    output_tokens: 2,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 5,
                },
            },
        };

        expect(OpenAIResponsesTranslator.fromStreamResponse(textEvent)).toEqual(
            [
                {
                    op: "openai_responses.body_field",
                    key: "type",
                    value: "response.output_text.delta",
                    appliesTo: "response",
                },
                {
                    op: "openai_responses.body_field",
                    key: "item_id",
                    value: "msg_1",
                    appliesTo: "response",
                },
                {
                    op: "openai_responses.body_field",
                    key: "output_index",
                    value: 0,
                    appliesTo: "response",
                },
                {
                    op: "openai_responses.body_field",
                    key: "content_index",
                    value: 0,
                    appliesTo: "response",
                },
                { op: "response.text_delta", role: "assistant", content: "hi" },
            ],
        );
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(textEvent),
            ),
        ).toEqual(textEvent);
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(doneEvent),
            ),
        ).toEqual(doneEvent);
    });

    test("openai responses function-call done chunks preserve item identity and event type", () => {
        const event = {
            type: "response.output_item.done",
            output_index: 0,
            item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "lookup",
                arguments: '{"x":"1"}',
            },
        };

        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(event),
            ),
        ).toEqual(event);
    });

    test("openai responses tool-call stream raises a tool_use stop", () => {
        const functionCall = {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"Halifax"}',
            status: "completed",
        };
        const completed = {
            type: "response.completed",
            sequence_number: 4,
            response: {
                id: "resp_1",
                object: "response",
                status: "completed",
                model: "gpt-4.1",
                output: [functionCall],
                usage: {
                    input_tokens: 20,
                    input_tokens_details: {
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                    },
                    output_tokens: 8,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 28,
                },
            },
        };
        // A real stream also holds response.created, response.in_progress, and
        // response.function_call_arguments.done; the raise throws on those
        // three event types, so this stream leaves them out.
        const stream = [
            {
                type: "response.output_item.added",
                sequence_number: 0,
                output_index: 0,
                item: { ...functionCall, arguments: "", status: "in_progress" },
            },
            {
                type: "response.function_call_arguments.delta",
                sequence_number: 1,
                item_id: "fc_1",
                output_index: 0,
                delta: '{"city":',
            },
            {
                type: "response.function_call_arguments.delta",
                sequence_number: 2,
                item_id: "fc_1",
                output_index: 0,
                delta: '"Halifax"}',
            },
            {
                type: "response.output_item.done",
                sequence_number: 3,
                output_index: 0,
                item: functionCall,
            },
            completed,
        ];

        expect(
            stream
                .flatMap((event) =>
                    OpenAIResponsesTranslator.fromStreamResponse(event),
                )
                .filter((op) => op.op !== "openai_responses.body_field"),
        ).toEqual([
            {
                op: "response.tool_call_delta",
                index: 0,
                id: "call_1",
                name: "get_weather",
            },
            { op: "response.tool_call_delta", index: 0, arguments: '{"city":' },
            {
                op: "response.tool_call_delta",
                index: 0,
                arguments: '"Halifax"}',
            },
            {
                op: "response.tool_call_delta",
                index: 0,
                id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Halifax"}',
            },
            { op: "response.stop", reason: "tool_use" },
            {
                op: "response.usage",
                inputTokens: 20,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 8,
                reasoningTokens: 0,
            },
        ]);
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(completed),
            ),
        ).toEqual(completed);
        expect(
            OpenAIResponsesTranslator.fromStreamResponse({
                type: "response.completed",
                response: {
                    status: "completed",
                    output: [
                        {
                            type: "message",
                            id: "msg_1",
                            status: "completed",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "checking",
                                    annotations: [],
                                },
                            ],
                        },
                        functionCall,
                        { type: "reasoning", id: "rs_1", summary: [] },
                    ],
                },
            }).filter((op) => op.op === "response.stop"),
        ).toEqual([{ op: "response.stop", reason: "tool_use" }]);
    });

    test("openai responses stream raises no tool_use stop without a completed function call", () => {
        const message = {
            type: "message",
            id: "msg_1",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "hi", annotations: [] }],
        };
        const functionCall = {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":',
            status: "incomplete",
        };
        const stops = (events: unknown[]) =>
            events
                .flatMap((event) =>
                    OpenAIResponsesTranslator.fromStreamResponse(event),
                )
                .filter((op) => op.op === "response.stop");

        expect(
            stops([
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { ...message, status: "in_progress", content: [] },
                },
                {
                    type: "response.output_text.delta",
                    item_id: "msg_1",
                    output_index: 0,
                    content_index: 0,
                    delta: "hi",
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: message,
                },
                {
                    type: "response.completed",
                    response: { status: "completed", output: [message] },
                },
            ]),
        ).toEqual([{ op: "response.stop", reason: "end_turn" }]);
        expect(
            stops([
                {
                    type: "response.completed",
                    response: { status: "completed" },
                },
            ]),
        ).toEqual([{ op: "response.stop", reason: "end_turn" }]);
        expect(
            stops([
                {
                    type: "response.completed",
                    response: { status: "completed", output: [] },
                },
            ]),
        ).toEqual([{ op: "response.stop", reason: "end_turn" }]);
        expect(
            stops([
                {
                    type: "response.incomplete",
                    response: {
                        status: "incomplete",
                        incomplete_details: { reason: "max_output_tokens" },
                        output: [functionCall],
                    },
                },
            ]),
        ).toEqual([{ op: "response.stop", reason: "max_tokens" }]);
        expect(
            stops([
                {
                    type: "response.failed",
                    response: {
                        status: "failed",
                        error: { code: "server_error", message: "nope" },
                        output: [{ ...functionCall, status: "completed" }],
                    },
                },
            ]),
        ).toEqual([]);
        expect(
            stops([
                {
                    type: "response.completed",
                    response: {
                        output: [{ ...functionCall, status: "completed" }],
                    },
                },
            ]),
        ).toEqual([]);
        expect(
            stops([
                {
                    type: "response.failed",
                    response: {
                        status: "cancelled",
                        output: [{ ...functionCall, status: "completed" }],
                    },
                },
            ]),
        ).toEqual([]);
    });

    test("openai responses stream terminal events throw on a malformed response.output", () => {
        const functionCall = {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: "{}",
            status: "completed",
        };
        const raise = (type: string, status: string, output: unknown) => () =>
            OpenAIResponsesTranslator.fromStreamResponse({
                type,
                response: { status, output },
            });
        const notAnArray =
            'stream event.response.output: expected an array, got "x"';
        const notAnObject =
            "stream event.response.output item: expected an object, got 1";

        expect(raise("response.completed", "completed", "x")).toThrow(
            notAnArray,
        );
        expect(raise("response.completed", "completed", [1])).toThrow(
            notAnObject,
        );
        // The malformed item throws on either side of the function call.
        expect(
            raise("response.completed", "completed", [1, functionCall]),
        ).toThrow(notAnObject);
        expect(
            raise("response.completed", "completed", [functionCall, 1]),
        ).toThrow(notAnObject);
        expect(raise("response.incomplete", "incomplete", [1])).toThrow(
            notAnObject,
        );
        expect(raise("response.failed", "failed", "x")).toThrow(notAnArray);
    });

    test("openai responses failed terminal events warn and drop cross-provider metadata", () => {
        withWarnSpy((warn) => {
            const chunk = OpenAIChatTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse({
                    type: "response.failed",
                    response: {
                        status: "failed",
                        error: { code: "server_error", message: "nope" },
                    },
                }),
            ) as Record<string, unknown>;

            expect(chunk).toMatchObject({
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: null }],
            });
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "openai_responses.body_field"',
                ),
            );
        });
    });

    test("openai realtime text events and done events use the stream edge", () => {
        const textEvent = {
            type: "response.output_text.delta",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "hi",
        };
        const doneEvent = {
            type: "response.done",
            response: {
                status: "completed",
                status_details: null,
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
        };

        expect(
            OpenAIRealtimeTranslator.fromStreamResponse(textEvent),
        ).toContainEqual({
            op: "response.text_delta",
            role: "assistant",
            content: "hi",
        });
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(textEvent),
            ),
        ).toEqual(textEvent);
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(doneEvent),
            ),
        ).toEqual(doneEvent);
    });

    test("openai realtime function-call done and terminal response metadata round-trip", () => {
        const functionDone = {
            type: "response.output_item.done",
            output_index: 0,
            item: {
                type: "function_call",
                id: "item_1",
                call_id: "call_1",
                name: "lookup",
                arguments: '{"x":"1"}',
            },
        };
        const doneEvent = {
            type: "response.done",
            response: {
                id: "resp_1",
                object: "realtime.response",
                status: "completed",
                status_details: null,
                output: [
                    {
                        id: "item_1",
                        type: "message",
                        role: "assistant",
                        content: [
                            {
                                type: "output_text",
                                text: "hi",
                            },
                        ],
                    },
                ],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
        };

        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(functionDone),
            ),
        ).toEqual(functionDone);
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(doneEvent),
            ),
        ).toEqual(doneEvent);
    });

    test("gemini stream lowering rejects partial tool-call argument fragments explicitly", () => {
        const partialOpenAIChunk = {
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                type: "function",
                                function: {
                                    name: "lookup",
                                    arguments: '{"x"',
                                },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        };

        expect(() =>
            GeminiTranslator.toStreamResponse(
                OpenAIChatTranslator.fromStreamResponse(partialOpenAIChunk),
            ),
        ).toThrow(LintError);
    });

    test("anthropic text deltas translate to openai chat chunks", () => {
        const openaiChunk = OpenAIChatTranslator.toStreamResponse(
            AnthropicTranslator.fromStreamResponse({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "hi" },
            }),
        ) as { choices: { delta: { role: string; content: string } }[] };

        expect(openaiChunk.choices[0]!.delta).toEqual({
            role: "assistant",
            content: "hi",
        });
    });

    test("anthropic tool fragments stay partial across raise and lower", () => {
        const start = {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: "toolu_1",
                name: "lookup",
                input: {},
            },
        };
        const delta = {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"x"' },
        };

        expect(AnthropicTranslator.fromStreamResponse(start)).toContainEqual({
            op: "response.tool_call_delta",
            index: 0,
            id: "toolu_1",
            name: "lookup",
        });
        expect(AnthropicTranslator.fromStreamResponse(delta)).toContainEqual({
            op: "response.tool_call_delta",
            index: 0,
            arguments: '{"x"',
        });
        expect(
            AnthropicTranslator.toStreamResponse(
                AnthropicTranslator.fromStreamResponse(delta),
            ),
        ).toEqual(delta);
    });
});

// Gemini's API can send text and finishReason in one chunk. The OpenAI
// Responses and Realtime streams have no event that holds both.
describe("a stream chunk that holds a delta and a stop reason", () => {
    function geminiChunk(
        parts: unknown[],
        rest: Record<string, unknown> = {},
    ): Record<string, unknown> {
        const { finishReason, ...body } = rest;
        return {
            candidates: [
                {
                    content: { role: "model", parts },
                    ...(finishReason != null ? { finishReason } : {}),
                    index: 0,
                },
            ],
            ...body,
        };
    }

    const textAndStop = geminiChunk([{ text: "Hello" }], {
        finishReason: "STOP",
    });
    const textOnly = geminiChunk([{ text: "Hello" }]);
    const stopOnly = geminiChunk([], { finishReason: "STOP" });

    const responsesTextEvent = {
        type: "response.output_text.delta",
        item_id: expect.stringMatching(/^msg_/),
        output_index: 0,
        content_index: 0,
        delta: "Hello",
    };
    const responsesCompletedEvent = {
        type: "response.completed",
        response: { status: "completed" },
    };
    const realtimeTextEvent = {
        type: "response.output_text.delta",
        delta: "Hello",
    };
    const realtimeDoneEvent = {
        type: "response.done",
        response: { status: "completed", status_details: null },
    };

    test("gemini text and STOP lower to a delta event and a terminal event in openai_responses", () => {
        expect(
            OpenAIResponsesTranslator.toStreamResponses(
                GeminiTranslator.fromStreamResponse(textAndStop),
            ),
        ).toEqual([responsesTextEvent, responsesCompletedEvent]);
    });

    test("gemini text and STOP lower to a delta event and response.done in openai_realtime", () => {
        expect(
            OpenAIRealtimeTranslator.toStreamResponses(
                GeminiTranslator.fromStreamResponse(textAndStop),
            ),
        ).toEqual([realtimeTextEvent, realtimeDoneEvent]);
    });

    test("a gemini chunk with only text lowers to one delta event", () => {
        const raised = GeminiTranslator.fromStreamResponse(textOnly);

        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            responsesTextEvent,
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(raised)).toEqual([
            realtimeTextEvent,
        ]);
    });

    test("a gemini chunk with only STOP lowers to one terminal event", () => {
        const raised = GeminiTranslator.fromStreamResponse(stopOnly);

        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            responsesCompletedEvent,
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(raised)).toEqual([
            realtimeDoneEvent,
        ]);
    });

    test("the terminal event holds the stop reason and the usage of the chunk", () => {
        const raised = GeminiTranslator.fromStreamResponse(
            geminiChunk([{ text: "Hello" }], {
                finishReason: "MAX_TOKENS",
                usageMetadata: {
                    promptTokenCount: 4,
                    candidatesTokenCount: 1,
                },
            }),
        );

        // A gemini chunk reports no cache count, and every key of the
        // responses usage object is a required number, so its lowering fills
        // those keys with 0; the call returns, which a proxy routing between
        // the two dialects needs.
        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            responsesTextEvent,
            {
                type: "response.incomplete",
                response: {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                    usage: {
                        input_tokens: 4,
                        input_tokens_details: {
                            cached_tokens: 0,
                            cache_write_tokens: 0,
                        },
                        output_tokens: 1,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 5,
                    },
                },
            },
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(raised)).toEqual([
            realtimeTextEvent,
            {
                type: "response.done",
                response: {
                    status: "incomplete",
                    status_details: {
                        type: "incomplete",
                        reason: "max_output_tokens",
                    },
                    usage: {
                        input_tokens: 4,
                        output_tokens: 1,
                        total_tokens: 5,
                    },
                },
            },
        ]);
    });

    test("gemini text and SAFETY lower to a delta event and a terminal event that holds content_filter", () => {
        const raised = GeminiTranslator.fromStreamResponse(
            geminiChunk([{ text: "Hello" }], { finishReason: "SAFETY" }),
        );

        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            responsesTextEvent,
            {
                type: "response.incomplete",
                response: {
                    status: "incomplete",
                    incomplete_details: { reason: "content_filter" },
                },
            },
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(raised)).toEqual([
            realtimeTextEvent,
            {
                type: "response.done",
                response: {
                    status: "incomplete",
                    status_details: {
                        type: "incomplete",
                        reason: "content_filter",
                    },
                },
            },
        ]);
    });

    test("a gemini function call and STOP lower to the call event and a terminal event", () => {
        const raised = GeminiTranslator.fromStreamResponse(
            geminiChunk([{ functionCall: { name: "lookup", args: {} } }], {
                finishReason: "STOP",
            }),
        );

        const callEvent = expect.objectContaining({
            item: expect.objectContaining({ name: "lookup" }),
        });

        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            callEvent,
            responsesCompletedEvent,
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(raised)).toEqual([
            callEvent,
            realtimeDoneEvent,
        ]);
    });

    test("a gemini stream with usage on every chunk lowers to one terminal event, sent last", () => {
        const usageMetadata = { promptTokenCount: 4, candidatesTokenCount: 1 };
        const chunks = [
            geminiChunk([{ text: "Hel" }], { usageMetadata }),
            geminiChunk([{ text: "lo" }], { usageMetadata }),
            geminiChunk([{ text: "!" }], {
                finishReason: "STOP",
                usageMetadata,
            }),
        ];
        const eventTypes = (translator: typeof OpenAIResponsesTranslator) =>
            chunks
                .flatMap((chunk) =>
                    translator.toStreamResponses(
                        GeminiTranslator.fromStreamResponse(chunk),
                    ),
                )
                .map((event) => (event as { type: string }).type);

        expect(eventTypes(OpenAIResponsesTranslator)).toEqual([
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.completed",
        ]);
        expect(eventTypes(OpenAIRealtimeTranslator)).toEqual([
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.done",
        ]);
    });

    test("toStreamResponse throws instead of returning one of the two events", () => {
        const raised = GeminiTranslator.fromStreamResponse(textAndStop);

        expect(() =>
            OpenAIResponsesTranslator.toStreamResponse(raised),
        ).toThrow(LintError);
        expect(() => OpenAIRealtimeTranslator.toStreamResponse(raised)).toThrow(
            LintError,
        );

        const callAndStop = GeminiTranslator.fromStreamResponse(
            geminiChunk([{ functionCall: { name: "lookup", args: {} } }], {
                finishReason: "STOP",
            }),
        );

        expect(() =>
            OpenAIResponsesTranslator.toStreamResponse(callAndStop),
        ).toThrow(LintError);
        expect(() =>
            OpenAIRealtimeTranslator.toStreamResponse(callAndStop),
        ).toThrow(LintError);

        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                GeminiTranslator.fromStreamResponse(textOnly),
            ),
        ).toEqual(responsesTextEvent);
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                GeminiTranslator.fromStreamResponse(stopOnly),
            ),
        ).toEqual(realtimeDoneEvent);
    });
});

// A Responses stream names its items: every text delta of one message carries
// the same item_id, and the terminal event holds the whole response. The
// per-chunk calls lower one chunk alone, so a caller that translates one
// whole stream creates one writer and feeds it every raised chunk.
describe("one writer lowers one whole stream into openai_responses events", () => {
    function geminiChunk(
        parts: unknown[],
        rest: Record<string, unknown> = {},
    ): Record<string, unknown> {
        const { finishReason, ...body } = rest;
        return {
            candidates: [
                {
                    content: { role: "model", parts },
                    ...(finishReason != null ? { finishReason } : {}),
                    index: 0,
                },
            ],
            ...body,
        };
    }

    // The chunk shape is a reduced fixture, not the full body recorded from
    // the API: recorded from gemini-3.5-flash-lite on 2026-11-19, with the
    // long text of the middle chunks shortened and the thoughtSignature that
    // the API sent on the final empty part removed. The real stream sent six
    // text chunks and finished with an empty text part, finishReason STOP,
    // usage, responseId, and modelVersion, as below.
    const recordedStream = [
        geminiChunk([{ text: "Every night" }], {
            responseId: "cwr_av2CCZjCn88Po6btqAc",
            modelVersion: "gemini-3.5-flash-lite",
            usageMetadata: {
                promptTokenCount: 15,
                candidatesTokenCount: 2,
                totalTokenCount: 17,
            },
        }),
        geminiChunk([{ text: ", the moon" }], {
            responseId: "cwr_av2CCZjCn88Po6btqAc",
            modelVersion: "gemini-3.5-flash-lite",
            usageMetadata: {
                promptTokenCount: 15,
                candidatesTokenCount: 5,
                totalTokenCount: 20,
            },
        }),
        geminiChunk([{ text: "" }], {
            finishReason: "STOP",
            responseId: "cwr_av2CCZjCn88Po6btqAc",
            modelVersion: "gemini-3.5-flash-lite",
            usageMetadata: {
                promptTokenCount: 15,
                candidatesTokenCount: 78,
                totalTokenCount: 93,
            },
        }),
    ];

    test("every text delta of one message shares one item id", () => {
        const writer = OpenAIResponsesTranslator.streamWriter();
        const events = recordedStream.flatMap((chunk) =>
            writer.write(GeminiTranslator.fromStreamResponse(chunk)),
        );

        const deltas = events.filter(
            (event) =>
                (event as { type: string }).type ===
                "response.output_text.delta",
        );
        expect(deltas).toHaveLength(3);
        const itemIds = new Set(
            deltas.map((event) => (event as { item_id: string }).item_id),
        );
        expect(itemIds.size).toBe(1);
        expect([...itemIds][0]).toMatch(/^msg_/);
    });

    test("the terminal event holds the message the stream built", () => {
        const writer = OpenAIResponsesTranslator.streamWriter();
        const events = recordedStream.flatMap((chunk) =>
            writer.write(GeminiTranslator.fromStreamResponse(chunk)),
        );
        const deltaId = (events[0] as { item_id: string; delta: string })
            .item_id;

        expect(events).toEqual([
            {
                type: "response.output_text.delta",
                item_id: deltaId,
                output_index: 0,
                content_index: 0,
                delta: "Every night",
            },
            {
                type: "response.output_text.delta",
                item_id: deltaId,
                output_index: 0,
                content_index: 0,
                delta: ", the moon",
            },
            {
                type: "response.output_text.delta",
                item_id: deltaId,
                output_index: 0,
                content_index: 0,
                delta: "",
            },
            {
                type: "response.completed",
                // Gemini raising keeps responseId and modelVersion in
                // gemini.body_field residuals. Responses lowering drops those
                // foreign residuals, so the response has no id and no model.
                response: {
                    status: "completed",
                    usage: {
                        input_tokens: 15,
                        input_tokens_details: {
                            cached_tokens: 0,
                            cache_write_tokens: 0,
                        },
                        output_tokens: 78,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 93,
                    },
                    output: [
                        {
                            type: "message",
                            id: deltaId,
                            role: "assistant",
                            status: "completed",
                            content: [
                                {
                                    type: "output_text",
                                    text: "Every night, the moon",
                                    annotations: [],
                                    logprobs: [],
                                },
                            ],
                        },
                    ],
                },
            },
        ]);
    });

    test("text before and after a call stays in separate ordered messages", () => {
        const writer = OpenAIResponsesTranslator.streamWriter();
        const events = [
            geminiChunk([{ text: "before " }]),
            geminiChunk([
                {
                    functionCall: {
                        id: "gemini-call-1",
                        name: "lookup",
                        args: { x: 1 },
                    },
                },
            ]),
            geminiChunk([{ text: " after" }]),
            geminiChunk([{ text: "" }], { finishReason: "STOP" }),
        ].flatMap((chunk) =>
            writer.write(GeminiTranslator.fromStreamResponse(chunk)),
        );

        const deltas = events.filter(
            (event) =>
                (event as { type: string }).type ===
                "response.output_text.delta",
        ) as { item_id: string; output_index: number; delta: string }[];
        expect(
            deltas.map(({ output_index, delta }) => ({ output_index, delta })),
        ).toEqual([
            { output_index: 0, delta: "before " },
            { output_index: 2, delta: " after" },
            { output_index: 2, delta: "" },
        ]);
        expect(deltas[0]!.item_id).not.toBe(deltas[1]!.item_id);
        expect(deltas[1]!.item_id).toBe(deltas[2]!.item_id);

        const callEvent = events.find(
            (event) =>
                (event as { item?: { type?: string } }).item?.type ===
                "function_call",
        )!;
        expect(callEvent).toMatchObject({ output_index: 1 });
        expect(events.indexOf(callEvent)).toBeGreaterThan(
            events.indexOf(deltas[0]!),
        );
        expect(events.indexOf(callEvent)).toBeLessThan(
            events.indexOf(deltas[1]!),
        );

        const terminal = events[events.length - 1] as {
            response: { output: unknown[] };
        };
        expect(terminal.response.output).toEqual([
            expect.objectContaining({
                type: "message",
                id: deltas[0]!.item_id,
                content: [expect.objectContaining({ text: "before " })],
            }),
            expect.objectContaining({
                type: "function_call",
                call_id: "gemini-call-1",
                name: "lookup",
                arguments: '{"x":1}',
            }),
            expect.objectContaining({
                type: "message",
                id: deltas[1]!.item_id,
                content: [expect.objectContaining({ text: " after" })],
            }),
        ]);
    });

    test("two writers keep the state of their own stream", () => {
        const first = OpenAIResponsesTranslator.streamWriter();
        const second = OpenAIResponsesTranslator.streamWriter();
        const raise = (text: string, finishReason?: string) =>
            GeminiTranslator.fromStreamResponse(
                geminiChunk([{ text }], { finishReason }),
            );

        const firstEvents = first.write(raise("a"));
        const secondEvents = second.write(raise("b"));
        firstEvents.push(...first.write(raise("c")));
        secondEvents.push(...second.write(raise("", "STOP")));
        firstEvents.push(...first.write(raise("", "STOP")));

        const deltasOf = (events: unknown[]) =>
            events.filter(
                (event) =>
                    (event as { type: string }).type ===
                    "response.output_text.delta",
            ) as { item_id: string }[];
        const firstDeltas = deltasOf(firstEvents);
        const secondDeltas = deltasOf(secondEvents);
        const firstId = firstDeltas[0]!.item_id;
        const secondId = secondDeltas[0]!.item_id;
        expect(new Set(firstDeltas.map((event) => event.item_id))).toEqual(
            new Set([firstId]),
        );
        expect(new Set(secondDeltas.map((event) => event.item_id))).toEqual(
            new Set([secondId]),
        );
        expect(firstId).not.toBe(secondId);

        const terminalOutputOf = (events: unknown[]) =>
            (
                events.find(
                    (event) =>
                        (event as { type: string }).type ===
                        "response.completed",
                ) as { response: { output: unknown[] } }
            ).response.output;
        expect(terminalOutputOf(firstEvents)).toEqual([
            expect.objectContaining({
                id: firstId,
                content: [expect.objectContaining({ text: "ac" })],
            }),
        ]);
        expect(terminalOutputOf(secondEvents)).toEqual([
            expect.objectContaining({
                id: secondId,
                content: [expect.objectContaining({ text: "b" })],
            }),
        ]);
    });

    test("a stream that names its own items keeps their ids and response", () => {
        const textEvent = {
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "hi",
        };
        const doneEvent = {
            type: "response.completed",
            response: {
                id: "resp_1",
                model: "gpt-6-luna",
                status: "completed",
                output: [
                    {
                        type: "message",
                        id: "msg_1",
                        role: "assistant",
                        status: "completed",
                        content: [
                            {
                                type: "output_text",
                                text: "hi",
                                annotations: [],
                            },
                        ],
                    },
                ],
                usage: {
                    input_tokens: 3,
                    input_tokens_details: {
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                    },
                    output_tokens: 2,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 5,
                },
            },
        };

        const writer = OpenAIResponsesTranslator.streamWriter();
        const events = [textEvent, doneEvent].flatMap((event) =>
            writer.write(OpenAIResponsesTranslator.fromStreamResponse(event)),
        );

        expect(events).toEqual([textEvent, doneEvent]);
    });

    test("a gemini function-call stream puts the call in the terminal response", () => {
        const writer = OpenAIResponsesTranslator.streamWriter();
        const events = [
            geminiChunk([
                {
                    functionCall: {
                        id: "gemini-call-1",
                        name: "lookup",
                        args: { x: 1 },
                    },
                },
            ]),
            geminiChunk([{ text: "" }], { finishReason: "STOP" }),
        ].flatMap((chunk) =>
            writer.write(GeminiTranslator.fromStreamResponse(chunk)),
        );

        expect(events[events.length - 1]).toEqual({
            type: "response.completed",
            response: {
                status: "completed",
                output: [
                    {
                        type: "function_call",
                        call_id: "gemini-call-1",
                        name: "lookup",
                        arguments: '{"x":1}',
                    },
                ],
            },
        });
    });

    test("a function call without an id throws instead of inventing call_id", () => {
        const writer = OpenAIResponsesTranslator.streamWriter();
        const raised = GeminiTranslator.fromStreamResponse(
            geminiChunk([{ functionCall: { name: "lookup", args: { x: 1 } } }]),
        );

        expect(() => writer.write(raised)).toThrow(
            "function call is missing call_id (response.tool_call_delta.id)",
        );
    });

    test("argument fragments sent without an item join into the call", () => {
        const writer = OpenAIResponsesTranslator.streamWriter();
        const events = [
            {
                type: "content_block_start",
                index: 0,
                content_block: {
                    type: "tool_use",
                    id: "toolu_1",
                    name: "lookup",
                    input: {},
                },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"x":' },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: "1}" },
            },
            {
                type: "message_delta",
                delta: { stop_reason: "tool_use", stop_sequence: null },
                usage: { input_tokens: 10, output_tokens: 2 },
            },
        ].flatMap((event) =>
            writer.write(AnthropicTranslator.fromStreamResponse(event)),
        );

        expect(events[events.length - 1]).toEqual({
            type: "response.completed",
            response: {
                status: "completed",
                usage: {
                    input_tokens: 10,
                    input_tokens_details: {
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                    },
                    output_tokens: 2,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 12,
                },
                output: [
                    expect.objectContaining({
                        type: "function_call",
                        name: "lookup",
                        arguments: '{"x":1}',
                    }),
                ],
            },
        });
    });

    test("the writer lowers through the caller's lower options", () => {
        const writer = OpenAIResponsesTranslator.streamWriter({
            beforeLower: (program) =>
                program.filter((op) => op.op !== "response.usage"),
        });
        const events = writer.write(
            GeminiTranslator.fromStreamResponse(recordedStream[2]!),
        );

        expect(events).toEqual([
            {
                type: "response.output_text.delta",
                item_id: expect.stringMatching(/^msg_/),
                output_index: 0,
                content_index: 0,
                delta: "",
            },
            {
                type: "response.completed",
                response: { status: "completed" },
            },
        ]);
    });

    test("a chunk lowered without the writer keeps its chunk's fields only", () => {
        const events = OpenAIResponsesTranslator.toStreamResponses(
            GeminiTranslator.fromStreamResponse(recordedStream[2]!),
        );

        expect(events).toEqual([
            {
                type: "response.output_text.delta",
                item_id: expect.stringMatching(/^msg_/),
                output_index: 0,
                content_index: 0,
                delta: "",
            },
            {
                type: "response.completed",
                response: {
                    status: "completed",
                    usage: {
                        input_tokens: 15,
                        input_tokens_details: {
                            cached_tokens: 0,
                            cache_write_tokens: 0,
                        },
                        output_tokens: 78,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 93,
                    },
                },
            },
        ]);
    });

    test("a dialect without a stateful stream lowering throws", () => {
        expect(() => AnthropicTranslator.streamWriter()).toThrow(
            'dialect "anthropic_messages" does not implement stateful stream lowering',
        );
    });
});
