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
                usage: { input_tokens: 3, output_tokens: 2 },
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
                usage: { input_tokens: 20, output_tokens: 8 },
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
            { op: "response.usage", inputTokens: 20, outputTokens: 8 },
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
                usage: { input_tokens: 3, output_tokens: 2 },
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
                usage: { input_tokens: 3, output_tokens: 2 },
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

        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            responsesTextEvent,
            {
                type: "response.incomplete",
                response: {
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                    usage: { input_tokens: 4, output_tokens: 1 },
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
                    usage: { input_tokens: 4, output_tokens: 1 },
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
