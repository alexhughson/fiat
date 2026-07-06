import { describe, expect, spyOn, test } from "bun:test";
import {
    LintError,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
} from "../../../src/index";

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

describe("openai_realtime requests", () => {
    const textRequest = {
        events: [
            {
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            },
            {
                type: "response.create",
                response: {
                    instructions: "Reply tersely.",
                    output_modalities: ["text"],
                },
            },
        ],
    };

    test("core text lowers to ordered conversation.item.create plus response.create events", () => {
        expect(
            OpenAIRealtimeTranslator.toBody([
                { op: "llm.text", role: "system", content: "Reply tersely." },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual(textRequest);
    });

    test("response.create defaults output modalities to text", () => {
        expect(
            OpenAIRealtimeTranslator.toBody([
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "hi" }],
                    },
                },
                {
                    type: "response.create",
                    response: { output_modalities: ["text"] },
                },
            ],
        });
    });

    test("response.create rejects audio output modalities", () => {
        expect(() =>
            OpenAIRealtimeTranslator.toBody([
                {
                    op: "openai_realtime.response_param",
                    key: "output_modalities",
                    value: ["text", "audio"],
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toThrow(LintError);
    });

    test("response input mode embeds conversation context inside response.create", () => {
        expect(
            OpenAIRealtimeTranslator.toBody([
                { op: "openai_realtime.response_input_mode" },
                { op: "llm.text", role: "user", content: "hi" },
                {
                    op: "llm.tool_result",
                    id: "call_1",
                    content: "contents",
                },
            ]),
        ).toEqual({
            events: [
                {
                    type: "response.create",
                    response: {
                        input: [
                            {
                                type: "message",
                                role: "user",
                                content: [{ type: "input_text", text: "hi" }],
                            },
                            {
                                type: "function_call_output",
                                call_id: "call_1",
                                output: "contents",
                            },
                        ],
                        output_modalities: ["text"],
                    },
                },
            ],
        });
    });

    test("sampling remains session-scoped instead of request-event state", () => {
        expect(() =>
            OpenAIRealtimeTranslator.toBody([
                { op: "llm.temperature", value: 0.2 },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toThrow("configure sampling on the session");
    });

    test("event request body raises back to core text", () => {
        expect(OpenAIRealtimeTranslator.fromBody(textRequest)).toEqual([
            { op: "llm.text", role: "system", content: "Reply tersely." },
            { op: "llm.text", role: "user", content: "hi" },
        ]);
        expect(
            OpenAIRealtimeTranslator.toBody(
                OpenAIRealtimeTranslator.fromBody(textRequest),
            ),
        ).toEqual(textRequest);
    });

    test("function tools and tool choice live on response.create.response", () => {
        const body = OpenAIRealtimeTranslator.toBody([
            {
                op: "llm.tool",
                name: "get_weather",
                description: "Get weather for a city.",
                inputSchema: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                },
            },
            { op: "llm.tool_choice", value: { name: "get_weather" } },
            { op: "llm.max_output_tokens", value: 80 },
            { op: "llm.text", role: "user", content: "weather in paris" },
        ]);

        expect(body).toEqual({
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [
                            { type: "input_text", text: "weather in paris" },
                        ],
                    },
                },
                {
                    type: "response.create",
                    response: {
                        max_output_tokens: 80,
                        tool_choice: { type: "function", name: "get_weather" },
                        tools: [
                            {
                                type: "function",
                                name: "get_weather",
                                description: "Get weather for a city.",
                                parameters: {
                                    type: "object",
                                    properties: { city: { type: "string" } },
                                    required: ["city"],
                                },
                            },
                        ],
                        output_modalities: ["text"],
                    },
                },
            ],
        });
    });

    test("function_call and function_call_output items raise and round-trip", () => {
        const body = {
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                },
                {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: '{"temp":22}',
                    },
                },
                {
                    type: "response.create",
                    response: { output_modalities: ["text"] },
                },
            ],
        };

        expect(OpenAIRealtimeTranslator.fromBody(body)).toEqual([
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: '{"temp":22}' },
        ]);
        expect(
            OpenAIRealtimeTranslator.toBody(
                OpenAIRealtimeTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("interleaved system text fails instead of reordering events", () => {
        expect(() =>
            OpenAIRealtimeTranslator.toBody([
                { op: "llm.text", role: "user", content: "hi" },
                { op: "llm.text", role: "system", content: "new rules" },
            ]),
        ).toThrow(LintError);
    });

    test("audio input stays as a realtime residual and cannot be dropped cross-provider", () => {
        const body = {
            model: "gpt-4o-mini",
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_audio", audio: "..." }],
                    },
                },
                {
                    type: "response.create",
                    response: { output_modalities: ["text"] },
                },
            ],
        };

        expect(OpenAIRealtimeTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o-mini" },
            {
                op: "openai_realtime.item",
                event: body.events[0],
                preservesContent: true,
            },
        ]);
        expect(
            OpenAIRealtimeTranslator.toBody(
                OpenAIRealtimeTranslator.fromBody(body),
            ),
        ).toEqual(body);
        expect(() =>
            OpenAIChatTranslator.toBody(OpenAIRealtimeTranslator.fromBody(body)),
        ).toThrow(
            'cannot drop content-bearing foreign op "openai_realtime.item"',
        );
    });

    test("audio response output cannot be dropped cross-provider", () => {
        const body = {
            events: [
                {
                    type: "response.done",
                    response: {
                        model: "gpt-4o-realtime-preview",
                        output: [
                            {
                                type: "message",
                                role: "assistant",
                                content: [{ type: "audio", audio: "..." }],
                            },
                        ],
                    },
                },
            ],
        };

        const program = OpenAIRealtimeTranslator.fromResponse(body);
        expect(program).toContainEqual({
            op: "openai_realtime.output_meta",
            item: body.events[0]!.response.output[0],
            appliesTo: "response",
            preservesContent: true,
        });
        expect(() => OpenAIChatTranslator.toResponse(program)).toThrow(
            'cannot drop content-bearing foreign op "openai_realtime.output_meta"',
        );
    });

    test("portable image input fails loudly instead of becoming realtime event wire", () => {
        expect(() =>
            OpenAIRealtimeTranslator.toBody([
                { op: "llm.model", model: "gpt-realtime" },
                {
                    op: "llm.image",
                    role: "user",
                    source: {
                        type: "url",
                        url: "https://example.com/invoice.png",
                    },
                },
            ]),
        ).toThrow('no serialization for op "llm.image"');
    });

    test("model, event metadata, item metadata, and content metadata round-trip", () => {
        const body = {
            model: "gpt-realtime",
            events: [
                {
                    type: "conversation.item.create",
                    event_id: "event_1",
                    previous_item_id: "item_0",
                    item: {
                        type: "message",
                        id: "item_1",
                        object: "realtime.item",
                        status: "completed",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "hi",
                                transcript_confidence: 0.99,
                            },
                        ],
                    },
                },
                {
                    type: "response.create",
                    response: { output_modalities: ["text"] },
                },
            ],
        };

        expect(OpenAIRealtimeTranslator.fromBody(body)).toContainEqual({
            op: "llm.model",
            model: "gpt-realtime",
        });
        expect(
            OpenAIRealtimeTranslator.toBody(
                OpenAIRealtimeTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("multi-part request messages raise to multiple text ops and home-round-trip as one item", () => {
        const body = {
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [
                            { type: "input_text", text: "first" },
                            { type: "input_text", text: "second" },
                        ],
                    },
                },
                {
                    type: "response.create",
                    response: { output_modalities: ["text"] },
                },
            ],
        };

        expect(OpenAIRealtimeTranslator.fromBody(body)).toEqual([
            { op: "llm.text", role: "user", content: "first" },
            { op: "llm.text", role: "user", content: "second" },
            {
                op: "openai_realtime.item_meta",
                event: body.events[0],
                appliesTo: "request",
            },
        ]);
        expect(
            OpenAIRealtimeTranslator.toBody(
                OpenAIRealtimeTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("unsupported tool fields round-trip and foreign errored tool metadata warns", () => {
        const toolBody = {
            events: [
                {
                    type: "response.create",
                    response: {
                        output_modalities: ["text"],
                        tools: [
                            {
                                type: "function",
                                name: "fn",
                                parameters: {},
                                strict: true,
                            },
                        ],
                    },
                },
            ],
        };

        expect(
            OpenAIRealtimeTranslator.toBody(
                OpenAIRealtimeTranslator.fromBody(toolBody),
            ),
        ).toEqual(toolBody);

        withWarnSpy((warn) => {
            const body = OpenAIRealtimeTranslator.toBody([
                {
                    op: "llm.tool_result",
                    id: "call_1",
                    content: "failed",
                },
                {
                    op: "anthropic_messages.tool_result_meta",
                    id: "call_1",
                    is_error: true,
                },
            ]) as Record<string, unknown>;

            expect(body.events).toBeDefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "anthropic_messages.tool_result_meta"',
                ),
            );
        });
    });
});

describe("openai_realtime responses", () => {
    const wireResponse = {
        events: [
            {
                type: "response.done",
                event_id: "event_1",
                response: {
                    id: "resp_1",
                    object: "realtime.response",
                    status: "completed",
                    status_details: null,
                    model: "gpt-realtime",
                    output: [
                        {
                            id: "item_1",
                            object: "realtime.item",
                            type: "message",
                            role: "assistant",
                            status: "completed",
                            content: [{ type: "output_text", text: "pong" }],
                        },
                    ],
                    usage: {
                        input_tokens: 12,
                        output_tokens: 2,
                        total_tokens: 14,
                    },
                },
            },
        ],
    };

    test("response.done text raises to assistant text, stop, usage, and response-only residuals", () => {
        expect(OpenAIRealtimeTranslator.fromResponse(wireResponse)).toEqual([
            {
                op: "openai_realtime.event_param",
                eventType: "response.done",
                key: "event_id",
                value: "event_1",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.body_field",
                key: "id",
                value: "resp_1",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.body_field",
                key: "object",
                value: "realtime.response",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.body_field",
                key: "status",
                value: "completed",
                appliesTo: "response",
            },
            {
                op: "openai_realtime.body_field",
                key: "status_details",
                value: null,
                appliesTo: "response",
            },
            { op: "llm.model", model: "gpt-realtime" },
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_realtime.output_meta",
                item: {
                    type: "message",
                    id: "item_1",
                    object: "realtime.item",
                    status: "completed",
                },
                appliesTo: "response",
            },
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            {
                op: "openai_realtime.usage",
                usage: { total_tokens: 14 },
                appliesTo: "response",
            },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("supported response.done text fixture round-trips", () => {
        expect(
            OpenAIRealtimeTranslator.toResponse(
                OpenAIRealtimeTranslator.fromResponse(wireResponse),
            ),
        ).toEqual(wireResponse);
    });

    test("two message output items round-trip as two items, each keeping its own id", () => {
        // Each message-type output_meta closes over the text since the previous
        // one, so distinct wire items stay distinct instead of collapsing into
        // one item that only remembers the last id.
        const twoMessages = {
            events: [
                {
                    type: "response.done",
                    response: {
                        model: "gpt-realtime",
                        output: [
                            {
                                id: "m1",
                                type: "message",
                                role: "assistant",
                                status: "completed",
                                content: [{ type: "output_text", text: "one" }],
                            },
                            {
                                id: "m2",
                                type: "message",
                                role: "assistant",
                                status: "completed",
                                content: [{ type: "output_text", text: "two" }],
                            },
                        ],
                    },
                },
            ],
        };

        const roundTripped = OpenAIRealtimeTranslator.toResponse(
            OpenAIRealtimeTranslator.fromResponse(twoMessages),
        ) as {
            events: { response: { output: unknown } }[];
        };
        // toResponse synthesizes envelope fields the fixture omits (id, object,
        // status), so compare the output array — that's what this test is about.
        expect(roundTripped.events[0]!.response.output).toEqual(
            twoMessages.events[0]!.response.output,
        );
    });

    test("response output item status is preserved on round-trip", () => {
        const body = {
            events: [
                {
                    type: "response.done",
                    response: {
                        id: "resp_partial",
                        object: "realtime.response",
                        status: "incomplete",
                        status_details: {
                            type: "incomplete",
                            reason: "max_output_tokens",
                        },
                        output: [
                            {
                                type: "message",
                                role: "assistant",
                                status: "incomplete",
                                content: [
                                    { type: "output_text", text: "partial" },
                                ],
                            },
                        ],
                    },
                },
            ],
        };

        expect(
            OpenAIRealtimeTranslator.toResponse(
                OpenAIRealtimeTranslator.fromResponse(body),
            ),
        ).toEqual(body);
    });

    test("response content part metadata and multiple text parts round-trip", () => {
        const body = {
            events: [
                {
                    type: "response.done",
                    response: {
                        output: [
                            {
                                type: "message",
                                role: "assistant",
                                status: "completed",
                                content: [
                                    {
                                        type: "output_text",
                                        text: "one",
                                        annotations: [{ type: "note" }],
                                    },
                                    { type: "output_text", text: "two" },
                                ],
                            },
                        ],
                    },
                },
            ],
        };

        expect(OpenAIRealtimeTranslator.fromResponse(body)).toEqual([
            { op: "llm.text", role: "assistant", content: "one" },
            { op: "llm.text", role: "assistant", content: "two" },
            {
                op: "openai_realtime.output_meta",
                item: body.events[0]!.response.output[0],
                appliesTo: "response",
            },
        ]);
        expect(
            OpenAIRealtimeTranslator.toResponse(
                OpenAIRealtimeTranslator.fromResponse(body),
            ),
        ).toEqual({
            events: [
                {
                    type: "response.done",
                    response: {
                        id: expect.any(String),
                        object: "realtime.response",
                        status: "completed",
                        status_details: null,
                        output: body.events[0]!.response.output,
                    },
                },
            ],
        });
    });

    test("response.done function_call raises to llm.tool_call and tool_use stop", () => {
        const program = OpenAIRealtimeTranslator.fromResponse({
            events: [
                {
                    type: "response.done",
                    response: {
                        status: "completed",
                        output: [
                            {
                                type: "function_call",
                                id: "fc_1",
                                status: "completed",
                                call_id: "call_1",
                                name: "get_weather",
                                arguments: '{"city":"Paris"}',
                            },
                        ],
                    },
                },
            ],
        });

        expect(program).toContainEqual({
            op: "llm.tool_call",
            id: "call_1",
            name: "get_weather",
            arguments: { city: "Paris" },
        });
        expect(program).toContainEqual({
            op: "response.stop",
            reason: "tool_use",
        });
    });

    test("mixed function_call then message output preserves item order", () => {
        const body = {
            events: [
                {
                    type: "response.done",
                    response: {
                        status: "completed",
                        output: [
                            {
                                type: "function_call",
                                id: "fc_1",
                                status: "completed",
                                call_id: "call_1",
                                name: "get_weather",
                                arguments: '{"city":"Paris"}',
                            },
                            {
                                type: "message",
                                role: "assistant",
                                status: "completed",
                                content: [
                                    {
                                        type: "output_text",
                                        text: "checking",
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
        };

        const roundTripped = OpenAIRealtimeTranslator.toResponse(
            OpenAIRealtimeTranslator.fromResponse(body),
        ) as { events: { response: { output: unknown[] } }[] };

        expect(roundTripped.events[0]!.response.output).toEqual(
            body.events[0]!.response.output,
        );
    });

    test("pause and context-window stops do not lower as max_tokens", () => {
        for (const reason of [
            "pause_turn",
            "model_context_window_exceeded",
        ] as const) {
            const lower = () =>
                OpenAIRealtimeTranslator.toResponse([
                    { op: "llm.text", role: "assistant", content: "partial" },
                    { op: "response.stop", reason },
                ]);

            expect(lower).toThrow(LintError);
            expect(lower).toThrow(
                `response.stop ${reason} has no finish reason mapping`,
            );
        }
    });

    test("streaming deltas are rejected loudly", () => {
        expect(() =>
            OpenAIRealtimeTranslator.fromResponse({
                events: [
                    {
                        type: "response.output_text.delta",
                        response_id: "resp_1",
                        delta: "p",
                    },
                ],
            }),
        ).toThrow("streaming detail");
    });
});
