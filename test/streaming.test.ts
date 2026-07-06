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
