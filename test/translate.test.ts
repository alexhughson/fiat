// Executable documentation for shared cross-dialect pipeline semantics.

import { describe, expect, spyOn, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    type Stage,
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

describe("request translation", () => {
    test("core-IR transforms run between raise and lower — e.g. rerouting the model", () => {
        const rerouteToHaiku: Stage = (program) =>
            program.map((op) =>
                op.op === "llm.model"
                    ? { op: "llm.model", model: "claude-haiku-4-5" }
                    : op,
            );

        let core = OpenAIChatTranslator.fromBody({
            model: "gpt-4o",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
        });
        core = rerouteToHaiku(core);
        const body = AnthropicTranslator.toBody(core) as { model: string };

        expect(body.model).toBe("claude-haiku-4-5");
    });

    test("image URL requests translate from OpenAI Chat to Responses and Anthropic", () => {
        const core = OpenAIChatTranslator.fromBody({
            model: "gpt-4o",
            max_tokens: 100,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this?" },
                        {
                            type: "image_url",
                            image_url: {
                                url: "https://example.com/invoice.png",
                            },
                        },
                        { type: "text", text: "answer briefly" },
                    ],
                },
            ],
        });

        expect(OpenAIResponsesTranslator.toBody(core)).toEqual({
            model: "gpt-4o",
            max_output_tokens: 100,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "what is this?" },
                        {
                            type: "input_image",
                            image_url: "https://example.com/invoice.png",
                        },
                        { type: "input_text", text: "answer briefly" },
                    ],
                },
            ],
        });
        const anthropicCore = core.map((op) =>
            op.op === "llm.model"
                ? { op: "llm.model" as const, model: "claude-sonnet-4-6" }
                : op,
        );
        expect(AnthropicTranslator.toBody(anthropicCore)).toEqual({
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this?" },
                        {
                            type: "image",
                            source: {
                                type: "url",
                                url: "https://example.com/invoice.png",
                            },
                        },
                        { type: "text", text: "answer briefly" },
                    ],
                },
            ],
        });
        expect(() => AnthropicTranslator.toBody(core)).toThrow(
            "gpt-4o: Anthropic Messages does not support image input",
        );
    });

    test("image data URLs translate from OpenAI Chat to Gemini inline data", () => {
        const core = OpenAIChatTranslator.fromBody({
            model: "models/gemini-3.5-flash",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this?" },
                        {
                            type: "image_url",
                            image_url: {
                                url: "data:image/png;base64,aW1hZ2U=",
                            },
                        },
                    ],
                },
            ],
        });

        expect(GeminiTranslator.toBody(core)).toEqual({
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "what is this?" },
                        {
                            inline_data: {
                                mime_type: "image/png",
                                data: "aW1hZ2U=",
                            },
                        },
                    ],
                },
            ],
        });
    });

    test("hand-authored core image base64 sources must still be image media", () => {
        const program = [
            { op: "llm.model" as const, model: "gpt-4o" },
            {
                op: "llm.image" as const,
                role: "user" as const,
                source: {
                    type: "base64" as const,
                    mediaType: "application/pdf",
                    data: "cGRm",
                },
            },
        ];

        for (const lower of [
            () => OpenAIChatTranslator.toBody(program),
            () => OpenAIResponsesTranslator.toBody(program),
            () => AnthropicTranslator.toBody(program),
            () => GeminiTranslator.toBody(program),
        ]) {
            expect(lower).toThrow("expected image/*");
        }
        expect(() => OpenAIRealtimeTranslator.toBody(program)).toThrow(
            'no serialization for op "llm.image"',
        );
    });

    test("audio base64 requests translate from OpenAI Chat to Gemini inline data", () => {
        const core = OpenAIChatTranslator.fromBody({
            model: "models/gemini-3.5-flash",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "transcribe" },
                        {
                            type: "input_audio",
                            input_audio: { data: "YXVkaW8=", format: "wav" },
                        },
                    ],
                },
            ],
        });

        expect(GeminiTranslator.toBody(core)).toEqual({
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "transcribe" },
                        {
                            inline_data: {
                                mime_type: "audio/wav",
                                data: "YXVkaW8=",
                            },
                        },
                    ],
                },
            ],
        });
    });

    test("PDF document URLs translate from Anthropic to OpenAI Responses", () => {
        const core = AnthropicTranslator.fromBody({
            model: "gpt-4o",
            max_tokens: 100,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "summarize" },
                        {
                            type: "document",
                            source: {
                                type: "url",
                                url: "https://example.com/report.pdf",
                            },
                        },
                    ],
                },
            ],
        });

        expect(OpenAIResponsesTranslator.toBody(core)).toEqual({
            model: "gpt-4o",
            max_output_tokens: 100,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "summarize" },
                        {
                            type: "input_file",
                            file_url: "https://example.com/report.pdf",
                        },
                    ],
                },
            ],
        });
    });

    test("Gemini inline video is preserved as core media and unsupported targets fail", () => {
        const core = GeminiTranslator.fromBody({
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inline_data: {
                                mime_type: "video/mp4",
                                data: "dmlkZW8=",
                            },
                        },
                    ],
                },
            ],
        });

        expect(core).toContainEqual({
            op: "llm.video",
            role: "user",
            source: {
                type: "base64",
                mediaType: "video/mp4",
                data: "dmlkZW8=",
            },
        });
        expect(GeminiTranslator.toBody(core)).toEqual({
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inline_data: {
                                mime_type: "video/mp4",
                                data: "dmlkZW8=",
                            },
                        },
                    ],
                },
            ],
        });
        expect(() => OpenAIResponsesTranslator.toBody(core)).toThrow(
            'no serialization for op "llm.video"',
        );
    });

    test("content-bearing provider file handles cannot be dropped cross-provider", () => {
        const core = OpenAIResponsesTranslator.fromBody({
            model: "gpt-4o",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "read this" },
                        { type: "input_file", file_id: "file_123" },
                    ],
                },
            ],
        });

        expect(() => AnthropicTranslator.toBody(core)).toThrow(
            'cannot drop content-bearing foreign op "openai_responses.input"',
        );
        expect(OpenAIResponsesTranslator.toBody(core)).toEqual({
            model: "gpt-4o",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "read this" },
                        { type: "input_file", file_id: "file_123" },
                    ],
                },
            ],
        });
    });

    test("hand-authored core media sources are validated by modality", () => {
        const badAudio = [
            { op: "llm.model" as const, model: "gpt-4o-audio-preview" },
            {
                op: "llm.audio" as const,
                role: "user" as const,
                source: {
                    type: "base64" as const,
                    mediaType: "application/pdf",
                    data: "cGRm",
                },
            },
        ];
        const badDocument = [
            { op: "llm.model" as const, model: "gpt-4o" },
            {
                op: "llm.document" as const,
                role: "user" as const,
                source: {
                    type: "base64" as const,
                    mediaType: "audio/wav",
                    data: "YXVkaW8=",
                    filename: "audio.wav",
                },
            },
        ];

        expect(() => OpenAIChatTranslator.toBody(badAudio)).toThrow(
            "expected audio/*",
        );
        expect(() => OpenAIResponsesTranslator.toBody(badDocument)).toThrow(
            "expected application/pdf",
        );
    });
});

describe("residual semantics", () => {
    const bodyWithResidual = (required: boolean | undefined) => ({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        // openai-only; anthropic has no equivalent
        logit_bias: { "50256": -100 },
        ...(required === undefined ? {} : {}),
    });

    test("an Anthropic text block with citations keeps its text for OpenAI Chat", () => {
        const program = AnthropicTranslator.fromResponse({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [
                {
                    type: "text",
                    text: "Rider X won the 2026 Giro.",
                    citations: [
                        {
                            type: "web_search_result_location",
                            url: "https://example.com/giro",
                            encrypted_index: "Eo8B",
                        },
                    ],
                },
            ],
            stop_reason: "end_turn",
        });

        const response = withWarnSpy((warn) => {
            const lowered = OpenAIChatTranslator.toResponse(program);
            expect(warn).toHaveBeenCalledWith(
                "metamodel: openai_chat dropped citations from an anthropic text block",
            );
            return lowered;
        }) as { choices: { message: unknown }[] };
        expect(response.choices[0]!.message).toEqual({
            role: "assistant",
            content: "Rider X won the 2026 Giro.",
        });

        const gemini = withWarnSpy((warn) => {
            const lowered = GeminiTranslator.toResponse(program);
            expect(warn).toHaveBeenCalledWith(
                "metamodel: gemini dropped citations from an anthropic text block",
            );
            return lowered;
        }) as { candidates: { content: unknown }[] };
        expect(gemini.candidates[0]!.content).toEqual({
            role: "model",
            parts: [{ text: "Rider X won the 2026 Giro." }],
        });
    });

    test("an endpoint-only param that nothing consumed warns and drops", () => {
        withWarnSpy((warn) => {
            const body = AnthropicTranslator.toBody(
                OpenAIChatTranslator.fromBody(bodyWithResidual(undefined)),
            ) as Record<string, unknown>;

            expect(body.logit_bias).toBeUndefined();
            expect(body.messages).toEqual([
                { role: "user", content: [{ type: "text", text: "hi" }] },
            ]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "openai_chat.body_field"',
                ),
            );
        });
    });

    test("residuals returning to their home dialect are consumed losslessly", () => {
        const original = {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            logit_bias: { "50256": -100 },
        };
        const roundTripped = OpenAIChatTranslator.toBody(
            OpenAIChatTranslator.fromBody(original),
        );
        expect(roundTripped).toEqual(original);
    });
});

describe("assistant turns survive replay", () => {
    test("text after a tool call stays in the same Chat assistant message", () => {
        const program = AnthropicTranslator.fromBody({
            model: "claude-sonnet-4-5",
            max_tokens: 100,
            messages: [
                { role: "user", content: "Weather in Halifax?" },
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "Checking." },
                        {
                            type: "tool_use",
                            id: "call_1",
                            name: "get_weather",
                            input: { city: "Halifax" },
                        },
                        { type: "text", text: "One moment." },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "call_1",
                            content: "4 C",
                        },
                    ],
                },
            ],
        });

        const body = withWarnSpy((warn) => {
            const lowered = OpenAIChatTranslator.toBody(program);
            expect(warn).toHaveBeenCalledTimes(1);
            return lowered;
        }) as { messages: unknown };
        expect(body.messages).toEqual([
            { role: "user", content: "Weather in Halifax?" },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Checking." },
                    { type: "text", text: "One moment." },
                ],
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "get_weather",
                            arguments: '{"city":"Halifax"}',
                        },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_1", content: "4 C" },
        ]);
    });

    test("two consecutive Chat assistant messages stay two messages", () => {
        const original = {
            model: "gpt-5",
            messages: [
                { role: "user", content: "Hi" },
                { role: "assistant", content: "Part one." },
                { role: "assistant", content: "Part two." },
            ],
        };
        expect(
            OpenAIChatTranslator.toBody(
                OpenAIChatTranslator.fromBody(original),
            ),
        ).toEqual(original);
    });
});

describe("the model that answered", () => {
    const translators = [
        AnthropicTranslator,
        OpenAIChatTranslator,
        OpenAIResponsesTranslator,
        OpenAIRealtimeTranslator,
        GeminiTranslator,
    ];

    const anthropicResponse = {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
    };
    const openaiChatResponse = {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o-2024-08-06",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: "hello" },
                finish_reason: "stop",
                logprobs: null,
            },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    };

    test.each([
        {
            name: "anthropic_messages",
            translator: AnthropicTranslator,
            request: {
                model: "claude-sonnet-4-5",
                max_tokens: 10,
                messages: [{ role: "user", content: "hi" }],
            },
            response: anthropicResponse,
        },
        {
            name: "openai_chat",
            translator: OpenAIChatTranslator,
            request: {
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            },
            response: openaiChatResponse,
        },
    ])(
        "$name: a response that names another model keeps both names, and the next request asks for the requested model",
        ({ translator, request, response }) => {
            const requestProgram = translator.fromBody(request);
            const responseProgram = translator.fromResponse(response);

            expect(
                [...requestProgram, ...responseProgram].filter(
                    (op) => op.op === "llm.model" || op.op === "response.model",
                ),
            ).toEqual([
                { op: "llm.model", model: request.model },
                { op: "response.model", model: response.model },
            ]);
            expect(translator.toResponse(responseProgram)).toMatchObject({
                model: response.model,
            });

            const next = [
                ...requestProgram,
                ...responseProgram,
                {
                    op: "llm.text" as const,
                    role: "user" as const,
                    content: "again",
                },
            ];
            for (const target of translators) {
                expect(target.toBody(next)).toMatchObject({
                    model: request.model,
                });
            }
        },
    );

    test("a gemini response lowered to another dialect names gemini's modelVersion, and back", () => {
        const geminiResponse = {
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "hello" }] },
                    finishReason: "STOP",
                },
            ],
            modelVersion: "gemini-2.5-flash-preview-05-20",
        };
        const program = GeminiTranslator.fromResponse(geminiResponse);

        expect(program).toContainEqual({
            op: "response.model",
            model: "gemini-2.5-flash-preview-05-20",
        });
        expect(AnthropicTranslator.toResponse(program)).toMatchObject({
            model: "gemini-2.5-flash-preview-05-20",
        });
        expect(GeminiTranslator.toResponse(program)).toEqual(geminiResponse);

        const fromAnthropic = GeminiTranslator.toResponse(
            AnthropicTranslator.fromResponse(anthropicResponse),
        ) as Record<string, unknown>;
        expect(fromAnthropic.modelVersion).toBe("claude-sonnet-4-5-20250929");
        expect(fromAnthropic).not.toHaveProperty("model");
    });

    test("request settings in a response program do not change the response body", () => {
        const response = [
            { op: "response.id" as const, id: "id_1" },
            { op: "response.model" as const, model: "model-that-answered" },
            {
                op: "llm.text" as const,
                role: "assistant" as const,
                content: "hi",
            },
            { op: "response.stop" as const, reason: "end_turn" as const },
        ];
        const settings = [
            { op: "llm.model" as const, model: "requested-model" },
            { op: "llm.temperature" as const, value: 0.5 },
            { op: "llm.max_output_tokens" as const, value: 9 },
            { op: "llm.thinking" as const, effort: "low" as const },
            {
                op: "llm.tool" as const,
                name: "lookup",
                inputSchema: { type: "object" },
            },
            {
                op: "llm.server_tool" as const,
                name: "web_search",
                kind: "web_search" as const,
            },
            { op: "llm.tool_choice" as const, value: "auto" as const },
            {
                op: "llm.output" as const,
                format: "json_schema" as const,
                name: "answer",
                schema: { type: "object" },
            },
        ];
        // openai_chat and openai_responses stamp the time of the call
        const withoutTime = (body: unknown) => {
            const { created, created_at, ...rest } = body as Record<
                string,
                unknown
            >;
            return rest;
        };
        for (const target of translators) {
            for (const setting of settings) {
                expect(
                    withoutTime(target.toResponse([setting, ...response])),
                ).toEqual(withoutTime(target.toResponse(response)));
            }
        }
    });

    test("a response program with llm.model and no response.model lowers with the requested model", () => {
        const handBuilt = [
            { op: "llm.model" as const, model: "requested-model" },
            {
                op: "llm.text" as const,
                role: "assistant" as const,
                content: "hi",
            },
            { op: "response.stop" as const, reason: "end_turn" as const },
        ];
        expect(AnthropicTranslator.toResponse(handBuilt)).toMatchObject({
            model: "requested-model",
        });
        expect(
            AnthropicTranslator.toStreamResponses(handBuilt)[0],
        ).toMatchObject({
            type: "message_start",
            message: { model: "requested-model" },
        });
        expect(
            AnthropicTranslator.toResponse([
                ...handBuilt,
                { op: "response.model", model: "model-that-answered" },
            ]),
        ).toMatchObject({ model: "model-that-answered" });
    });

    test("stream events raise the model wherever the event names it", () => {
        const chatChunk = {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "gpt-4o-2024-08-06",
            choices: [
                { index: 0, delta: { content: "hello" }, finish_reason: null },
            ],
        };
        const fromChat = OpenAIChatTranslator.fromStreamResponse(chatChunk);
        expect(fromChat.filter((op) => op.op.endsWith(".model"))).toEqual([
            { op: "response.model", model: "gpt-4o-2024-08-06" },
        ]);
        expect(GeminiTranslator.toStreamResponses(fromChat)).toEqual([
            {
                modelVersion: "gpt-4o-2024-08-06",
                candidates: [
                    { content: { role: "model", parts: [{ text: "hello" }] } },
                ],
            },
        ]);
        // a delta event of the Responses API has no model field
        expect(
            OpenAIResponsesTranslator.toStreamResponses(fromChat)[0],
        ).not.toHaveProperty("model");

        const completed = {
            type: "response.completed",
            sequence_number: 4,
            response: {
                id: "resp_1",
                object: "response",
                status: "completed",
                model: "gpt-4o-2024-08-06",
                output: [],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
        };
        const fromResponses =
            OpenAIResponsesTranslator.fromStreamResponse(completed);
        expect(fromResponses).toContainEqual({
            op: "response.model",
            model: "gpt-4o-2024-08-06",
        });
        expect(
            OpenAIResponsesTranslator.toStreamResponses(fromResponses),
        ).toEqual([completed]);
        expect(
            OpenAIChatTranslator.toStreamResponses(fromResponses)[0],
        ).toMatchObject({ model: "gpt-4o-2024-08-06" });

        const done = {
            type: "response.done",
            event_id: "event_1",
            response: {
                object: "realtime.response",
                id: "resp_2",
                status: "completed",
                model: "gpt-realtime-2025-08-28",
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
        };
        const fromRealtime = OpenAIRealtimeTranslator.fromStreamResponse(done);
        expect(fromRealtime).toContainEqual({
            op: "response.model",
            model: "gpt-realtime-2025-08-28",
        });
        expect(
            OpenAIRealtimeTranslator.toStreamResponses(fromRealtime),
        ).toEqual([done]);
        expect(
            OpenAIChatTranslator.toStreamResponses(fromRealtime)[0],
        ).toMatchObject({ model: "gpt-realtime-2025-08-28" });
    });
});
