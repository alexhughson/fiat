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

    test("openai responses content_part.added raises to response.text_start and round-trips", () => {
        const event = {
            type: "response.content_part.added",
            sequence_number: 3,
            item_id: "msg_123",
            output_index: 0,
            content_index: 0,
            part: {
                type: "output_text",
                text: "",
                annotations: [],
                logprobs: [],
            },
        };

        const program = OpenAIResponsesTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            {
                op: "openai_responses.stream_event_meta",
                event: {
                    type: "response.content_part.added",
                    sequence_number: 3,
                    item_id: "msg_123",
                    content_index: 0,
                    part: {
                        annotations: [],
                        logprobs: [],
                    },
                },
                appliesTo: "response",
            },
            { op: "response.text_start", index: 0 },
        ]);
        expect(OpenAIResponsesTranslator.toStreamResponse(program)).toEqual(
            event,
        );
    });

    test("openai responses content_part.added of a non-text part still throws", () => {
        expect(() =>
            OpenAIResponsesTranslator.fromStreamResponse({
                type: "response.content_part.added",
                sequence_number: 3,
                item_id: "msg_123",
                output_index: 0,
                content_index: 0,
                part: { type: "refusal", refusal: "" },
            }),
        ).toThrow(LintError);
    });

    test("openai responses content_part.done of a non-text part still throws", () => {
        expect(() =>
            OpenAIResponsesTranslator.fromStreamResponse({
                type: "response.content_part.done",
                sequence_number: 6,
                item_id: "msg_123",
                output_index: 0,
                content_index: 0,
                part: { type: "refusal", refusal: "No" },
            }),
        ).toThrow(LintError);
    });

    test("an anthropic text block start translates to an openai responses content_part.added event", () => {
        const event = {
            type: "response.content_part.added",
            output_index: 0,
            part: {
                type: "output_text",
                text: "",
                annotations: [],
                logprobs: [],
            },
        };

        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                AnthropicTranslator.fromStreamResponse({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                }),
            ),
        ).toEqual(event);
    });

    test("openai responses content_part.done raises to response.block_stop and round-trips", () => {
        const event = {
            type: "response.content_part.done",
            sequence_number: 6,
            item_id: "msg_123",
            output_index: 0,
            content_index: 0,
            part: {
                type: "output_text",
                text: "Hello",
                annotations: [],
                logprobs: [],
            },
        };

        const program = OpenAIResponsesTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            {
                op: "openai_responses.stream_event_meta",
                event: {
                    type: "response.content_part.done",
                    sequence_number: 6,
                    item_id: "msg_123",
                    content_index: 0,
                    part: {
                        text: "Hello",
                        annotations: [],
                        logprobs: [],
                    },
                },
                appliesTo: "response",
            },
            { op: "response.block_stop", index: 0 },
        ]);
        expect(OpenAIResponsesTranslator.toStreamResponse(program)).toEqual(
            event,
        );
    });

    test("an anthropic content_block_stop translates to an openai responses content_part.done event", () => {
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                AnthropicTranslator.fromStreamResponse({
                    type: "content_block_stop",
                    index: 0,
                }),
            ),
        ).toEqual({
            type: "response.content_part.done",
            output_index: 0,
        });
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

    test("openai realtime content_part events of a text part raise to the block ops and round-trip", () => {
        const added = {
            type: "response.content_part.added",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "text", text: "", transcripts: null },
        };
        const done = {
            type: "response.content_part.done",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "text", text: "hi", transcripts: ["hi"] },
        };

        // The params hold only openai_realtime data: no output_index or
        // part.type (the core op states both) and no empty part.text.
        expect(OpenAIRealtimeTranslator.fromStreamResponse(added)).toEqual([
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.added",
                key: "type",
                value: "response.content_part.added",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.added",
                key: "response_id",
                value: "resp_1",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.added",
                key: "item_id",
                value: "msg_1",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.added",
                key: "content_index",
                value: 0,
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.added",
                key: "part",
                value: { transcripts: null },
                appliesTo: "response",
            },
            { op: "response.text_start", index: 0 },
        ]);
        // Stream lowering holds no state, so the done event keeps its text
        // in the params; lowering writes output_index and part.type back.
        expect(OpenAIRealtimeTranslator.fromStreamResponse(done)).toEqual([
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.done",
                key: "type",
                value: "response.content_part.done",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.done",
                key: "response_id",
                value: "resp_1",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.done",
                key: "item_id",
                value: "msg_1",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.done",
                key: "content_index",
                value: 0,
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.content_part.done",
                key: "part",
                value: { text: "hi", transcripts: ["hi"] },
                appliesTo: "response",
            },
            { op: "response.block_stop", index: 0 },
        ]);

        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(added),
            ),
        ).toEqual(added);
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(done),
            ),
        ).toEqual(done);
    });

    test("openai realtime content_part.added of a non-text part still throws", () => {
        expect(() =>
            OpenAIRealtimeTranslator.fromStreamResponse({
                type: "response.content_part.added",
                response_id: "resp_1",
                item_id: "msg_1",
                output_index: 0,
                content_index: 0,
                part: { type: "audio", audio: null },
            }),
        ).toThrow(LintError);
    });

    test("openai realtime content_part.done of a non-text part stays params-only and round-trips", () => {
        const audioDone = {
            type: "response.content_part.done",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "audio", audio: null },
        };
        const program = OpenAIRealtimeTranslator.fromStreamResponse(audioDone);
        // No core op: a part other than text has no block ops yet.
        expect(
            program.every((op) => op.op === "openai_realtime.event_param"),
        ).toBe(true);
        expect(OpenAIRealtimeTranslator.toStreamResponse(program)).toEqual(
            audioDone,
        );
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

describe("response.done across dialects", () => {
    const doneEvent = {
        type: "message_stop",
    };

    test("an anthropic message_stop raises to response.done and lowers home", () => {
        expect(AnthropicTranslator.fromStreamResponse(doneEvent)).toEqual([
            { op: "response.done" },
        ]);
        expect(
            AnthropicTranslator.toStreamResponse(
                AnthropicTranslator.fromStreamResponse(doneEvent),
            ),
        ).toEqual(doneEvent);
    });

    test("openai responses terminal events raise response.done beside stop and usage", () => {
        const completed = {
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        const incomplete = {
            type: "response.incomplete",
            response: {
                id: "resp_1",
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        expect(OpenAIResponsesTranslator.fromStreamResponse(completed)).toEqual(
            [
                {
                    op: "openai_responses.body_field",
                    key: "type",
                    value: "response.completed",
                    appliesTo: "response",
                },
                {
                    op: "openai_responses.body_field",
                    key: "response",
                    value: { id: "resp_1", status: "completed" },
                    appliesTo: "response",
                },
                { op: "response.stop", reason: "end_turn" },
                { op: "response.usage", inputTokens: 3, outputTokens: 2 },
                { op: "response.done" },
            ],
        );
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(completed),
            ),
        ).toEqual(completed);
        expect(
            OpenAIResponsesTranslator.fromStreamResponse(incomplete),
        ).toEqual([
            {
                op: "openai_responses.body_field",
                key: "type",
                value: "response.incomplete",
                appliesTo: "response",
            },
            {
                op: "openai_responses.body_field",
                key: "response",
                value: {
                    id: "resp_1",
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                },
                appliesTo: "response",
            },
            { op: "response.stop", reason: "max_tokens" },
            { op: "response.usage", inputTokens: 3, outputTokens: 2 },
            { op: "response.done" },
        ]);
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(incomplete),
            ),
        ).toEqual(incomplete);
    });

    test("an openai responses response.failed raises response.done beside usage only", () => {
        const failed = {
            type: "response.failed",
            response: {
                id: "resp_1",
                status: "failed",
                error: { code: "server_error", message: "nope" },
            },
        };
        expect(OpenAIResponsesTranslator.fromStreamResponse(failed)).toEqual([
            {
                op: "openai_responses.body_field",
                key: "type",
                value: "response.failed",
                appliesTo: "response",
            },
            {
                op: "openai_responses.body_field",
                key: "response",
                value: {
                    id: "resp_1",
                    status: "failed",
                    error: { code: "server_error", message: "nope" },
                },
                appliesTo: "response",
            },
            { op: "response.done" },
        ]);
        expect(
            OpenAIResponsesTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(failed),
            ),
        ).toEqual(failed);
        expect(
            OpenAIResponsesTranslator.toStreamResponses(
                OpenAIResponsesTranslator.fromStreamResponse(failed),
            ),
        ).toEqual([failed]);
    });

    test("openai realtime response.done raises the core op beside stop and usage", () => {
        const realtimeDone = {
            type: "response.done",
            response: {
                id: "resp_1",
                status: "completed",
                status_details: null,
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        expect(
            OpenAIRealtimeTranslator.fromStreamResponse(realtimeDone),
        ).toEqual([
            {
                op: "openai_realtime.event_param",
                eventType: "response.done",
                key: "type",
                value: "response.done",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.event_param",
                eventType: "response.done",
                key: "response",
                value: {
                    id: "resp_1",
                    status: "completed",
                    status_details: null,
                },
                appliesTo: "response",
            },
            { op: "response.usage", inputTokens: 3, outputTokens: 2 },
            { op: "response.stop", reason: "end_turn" },
            { op: "response.done" },
        ]);
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIRealtimeTranslator.fromStreamResponse(realtimeDone),
            ),
        ).toEqual(realtimeDone);
    });

    test("a raised terminal event lowers to message_delta then message_stop in one plural call", () => {
        const completed = {
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        const events = AnthropicTranslator.toStreamResponses(
            OpenAIResponsesTranslator.fromStreamResponse(completed),
        ) as Record<string, unknown>[];
        expect(events).toEqual([
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { input_tokens: 3, output_tokens: 2 },
            },
            { type: "message_stop" },
        ]);
    });

    test("the singular call throws for a program that lowers to two events", () => {
        const completed = {
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        expect(() =>
            AnthropicTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(completed),
            ),
        ).toThrow(
            "anthropic_messages stream response toWire: expected exactly 1 event op, got 2",
        );
    });

    test("a raised message_stop lowers to no event in openai_chat and gemini plural calls", () => {
        const raised = AnthropicTranslator.fromStreamResponse({
            type: "message_stop",
        });
        expect(OpenAIChatTranslator.toStreamResponses(raised)).toEqual([]);
        expect(GeminiTranslator.toStreamResponses(raised)).toEqual([]);
    });

    test("a whole anthropic stream lowered event by event ends with one terminal event", () => {
        // message_start raises llm.model, which openai_responses and
        // openai_realtime stream lowering have no serialization for (the same
        // on the row's base), so the stream starts at its first block event.
        const stream = [
            {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hi" },
            },
            { type: "content_block_stop", index: 0 },
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
        ];
        for (const translator of [
            OpenAIResponsesTranslator,
            OpenAIRealtimeTranslator,
        ]) {
            const events = stream.flatMap(
                (event) =>
                    translator.toStreamResponses(
                        AnthropicTranslator.fromStreamResponse(event),
                    ) as Record<string, unknown>[],
            );
            const terminals = events.filter(
                (event) =>
                    event.type === "response.completed" ||
                    event.type === "response.incomplete" ||
                    event.type === "response.failed" ||
                    event.type === "response.done",
            );
            expect(terminals).toHaveLength(1);
            expect(
                (terminals[0] as { response?: { usage?: unknown } }).response
                    ?.usage,
            ).toEqual({ output_tokens: 2 });
        }
    });

    test("a raised terminal event keeps lowering to the same openai chat chunk as before the op", () => {
        const completed = {
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        const chunk = OpenAIChatTranslator.toStreamResponse(
            OpenAIResponsesTranslator.fromStreamResponse(completed),
        ) as Record<string, unknown>;
        expect(chunk).toMatchObject({
            object: "chat.completion.chunk",
            choices: [{ delta: {}, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
    });

    test("a raised terminal event keeps lowering to the same realtime response.done event", () => {
        const completed = {
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        };
        expect(
            OpenAIRealtimeTranslator.toStreamResponse(
                OpenAIResponsesTranslator.fromStreamResponse(completed),
            ),
        ).toEqual({
            type: "response.done",
            response: {
                status: "completed",
                status_details: null,
                usage: { input_tokens: 3, output_tokens: 2 },
            },
        });
    });
});
