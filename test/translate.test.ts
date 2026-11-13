// Executable documentation for shared cross-dialect pipeline semantics.

import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
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

    test("content beside llm.model stays in the response body", () => {
        const program = [
            { op: "llm.model" as const, model: "requested-model" },
            { op: "response.id" as const, id: "id_1" },
            { op: "response.model" as const, model: "model-that-answered" },
            {
                op: "llm.text" as const,
                role: "assistant" as const,
                content: "hi",
            },
            { op: "response.stop" as const, reason: "end_turn" as const },
        ];
        expect(AnthropicTranslator.toResponse(program)).toEqual({
            id: "id_1",
            type: "message",
            role: "assistant",
            model: "model-that-answered",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
        });
        // A system text is content, so response lowering receives it and
        // rejects it.
        for (const target of translators) {
            expect(() =>
                target.toResponse([
                    { op: "llm.text", role: "system", content: "be brief" },
                    ...program,
                ]),
            ).toThrow("unexpected system text in a response program");
        }
    });

    test("a request setting other than llm.model reaches response lowering, which rejects it", () => {
        // A Responses response body has a temperature field, so removing
        // llm.temperature before lowering would lose it without a warning.
        expect(() =>
            OpenAIResponsesTranslator.toResponse([
                { op: "llm.model", model: "gpt-4o" },
                { op: "llm.temperature", value: 0.5 },
                ...OpenAIChatTranslator.fromResponse(openaiChatResponse),
            ]),
        ).toThrow('no serialization for op "llm.temperature"');
    });

    test("a raised response lowered as a request, with no request before it, asks for the model that answered last", () => {
        const again = {
            op: "llm.text" as const,
            role: "user" as const,
            content: "again",
        };
        const one = [...AnthropicTranslator.fromResponse(anthropicResponse)];
        const two = [
            ...one,
            again,
            ...OpenAIChatTranslator.fromResponse(openaiChatResponse),
        ];
        for (const target of translators) {
            expect(target.toBody([...one, again])).toMatchObject({
                model: "claude-sonnet-4-5-20250929",
            });
            expect(target.toBody([...two, again])).toMatchObject({
                model: "gpt-4o-2024-08-06",
            });
        }
    });

    test("a request lowered after two raised responses holds one requested model, the model that answered last", () => {
        const again = {
            op: "llm.text" as const,
            role: "user" as const,
            content: "again",
        };
        const program = [
            ...OpenAIChatTranslator.fromResponse({
                ...openaiChatResponse,
                model: "o3-mini-2025-01-31",
            }),
            again,
            ...OpenAIChatTranslator.fromResponse(openaiChatResponse),
            again,
            { op: "llm.max_output_tokens" as const, value: 50 },
        ];
        for (const target of translators) {
            let requested: unknown[] = [];
            const readRequestedModels: Stage = (lowered) => {
                requested = lowered.filter((op) => op.op === "llm.model");
                return lowered;
            };
            target.toBody(program, { beforeLower: readRequestedModels });
            expect(requested).toEqual([
                { op: "llm.model", model: "gpt-4o-2024-08-06" },
            ]);
        }
        // openai_chat writes max_completion_tokens for o3-mini and
        // max_tokens for gpt-4o, so a second requested model that names
        // o3-mini would change the field.
        const body = OpenAIChatTranslator.toBody(program) as Record<
            string,
            unknown
        >;
        expect(body.model).toBe("gpt-4o-2024-08-06");
        expect(body.max_tokens).toBe(50);
        expect(body).not.toHaveProperty("max_completion_tokens");
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
        // Request lowering writes the last llm.model, so the response names
        // the last one too.
        expect(
            AnthropicTranslator.toResponse([
                { op: "llm.model", model: "first-requested-model" },
                ...handBuilt,
            ]),
        ).toMatchObject({ model: "requested-model" });
    });

    test("a response program with response.model names the model that answered, wherever llm.model stands", () => {
        const content = [
            {
                op: "llm.text" as const,
                role: "assistant" as const,
                content: "hi",
            },
            { op: "response.stop" as const, reason: "end_turn" as const },
        ];
        const answered = {
            op: "response.model" as const,
            model: "model-that-answered",
        };
        const requested = {
            op: "llm.model" as const,
            model: "requested-model",
        };
        for (const program of [
            [requested, answered, ...content],
            [answered, requested, ...content],
            [answered, ...content, requested],
        ]) {
            expect(AnthropicTranslator.toResponse(program)).toMatchObject({
                model: "model-that-answered",
            });
            expect(OpenAIChatTranslator.toResponse(program)).toMatchObject({
                model: "model-that-answered",
            });
            expect(GeminiTranslator.toResponse(program)).toMatchObject({
                modelVersion: "model-that-answered",
            });
        }
    });

    const chatChunk = (choices: unknown[]) => ({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o-2024-08-06",
        choices,
    });

    test("a Chat stream chunk raises the model, and each dialect writes it only into an event that has a field for it", () => {
        const textChunk = OpenAIChatTranslator.fromStreamResponse(
            chatChunk([
                { index: 0, delta: { content: "hello" }, finish_reason: null },
            ]),
        );
        expect(textChunk.filter((op) => op.op.endsWith(".model"))).toEqual([
            { op: "response.model", model: "gpt-4o-2024-08-06" },
        ]);
        expect(GeminiTranslator.toStreamResponses(textChunk)).toEqual([
            {
                modelVersion: "gpt-4o-2024-08-06",
                candidates: [
                    { content: { role: "model", parts: [{ text: "hello" }] } },
                ],
            },
        ]);
        // a delta event of the Responses API and of the Realtime API has no
        // model field
        expect(OpenAIResponsesTranslator.toStreamResponses(textChunk)).toEqual([
            {
                type: "response.output_text.delta",
                item_id: expect.any(String),
                output_index: 0,
                content_index: 0,
                delta: "hello",
            },
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(textChunk)).toEqual([
            { type: "response.output_text.delta", delta: "hello" },
        ]);

        const finishChunk = OpenAIChatTranslator.fromStreamResponse(
            chatChunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
        );
        // message_delta of the Anthropic API has no model field
        expect(AnthropicTranslator.toStreamResponses(finishChunk)).toEqual([
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]);
        expect(
            OpenAIResponsesTranslator.toStreamResponses(finishChunk),
        ).toEqual([
            {
                type: "response.completed",
                response: {
                    model: "gpt-4o-2024-08-06",
                    status: "completed",
                },
            },
        ]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(finishChunk)).toEqual(
            [
                {
                    type: "response.done",
                    response: { status: "completed", status_details: null },
                },
            ],
        );
    });

    test("a Chat stream chunk that holds only the model writes no event where no event has a field for the model", () => {
        const modelOnly = OpenAIChatTranslator.fromStreamResponse(
            chatChunk([]),
        );
        expect(modelOnly.filter((op) => op.op.endsWith(".model"))).toEqual([
            { op: "response.model", model: "gpt-4o-2024-08-06" },
        ]);
        expect(AnthropicTranslator.toStreamResponses(modelOnly)).toEqual([]);
        expect(OpenAIResponsesTranslator.toStreamResponses(modelOnly)).toEqual(
            [],
        );
        expect(OpenAIRealtimeTranslator.toStreamResponses(modelOnly)).toEqual(
            [],
        );
        expect(GeminiTranslator.toStreamResponses(modelOnly)).toEqual([
            { modelVersion: "gpt-4o-2024-08-06" },
        ]);
    });

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

    test("a terminal event of the Responses API raises the model and writes it back", () => {
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
    });

    test("lowering a raised response.completed event to the Responses API leaves the raised program unchanged", () => {
        const raised = OpenAIResponsesTranslator.fromStreamResponse(completed);
        const before = structuredClone(raised);
        OpenAIResponsesTranslator.toStreamResponses(raised);
        expect(raised).toEqual(before);
    });

    test("a Responses output_item.added event, which holds no response object, is written without a model", () => {
        const added = {
            type: "response.output_item.added",
            sequence_number: 2,
            output_index: 0,
            item: {
                id: "msg_1",
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [],
            },
        };
        expect(
            OpenAIResponsesTranslator.toStreamResponses([
                ...OpenAIResponsesTranslator.fromStreamResponse(added),
                { op: "response.model", model: "gpt-4o-mini-2024-07-18" },
            ]),
        ).toEqual([added]);
    });

    test("a response.failed event of the Responses API, which holds no stop reason and no usage, raises the model and writes it back", () => {
        const failed = {
            type: "response.failed",
            sequence_number: 3,
            response: {
                id: "resp_1",
                object: "response",
                status: "failed",
                model: "gpt-4o-2024-08-06",
                error: { code: "server_error", message: "boom" },
                output: [],
            },
        };
        const raised = OpenAIResponsesTranslator.fromStreamResponse(failed);
        expect(raised.filter((op) => op.op.startsWith("response."))).toEqual([
            { op: "response.model", model: "gpt-4o-2024-08-06" },
        ]);
        expect(OpenAIResponsesTranslator.toStreamResponses(raised)).toEqual([
            failed,
        ]);
    });

    test("a Chat usage chunk, which holds usage and no stop reason, lowers to a response.completed event that names the model", () => {
        const usageChunk = OpenAIChatTranslator.fromStreamResponse({
            ...chatChunk([]),
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        });
        expect(OpenAIResponsesTranslator.toStreamResponses(usageChunk)).toEqual(
            [
                {
                    type: "response.completed",
                    response: {
                        model: "gpt-4o-2024-08-06",
                        status: "completed",
                        usage: { input_tokens: 8, output_tokens: 2 },
                    },
                },
            ],
        );
    });

    test("a Responses terminal event that holds only model and usage keeps the model when its codec program is lowered without raising", () => {
        const event = {
            type: "response.completed",
            response: {
                model: "gpt-4o-2024-08-06",
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
        };
        const codecProgram =
            OpenAIResponsesTranslator.dialect.responseStream!.fromWire(event);
        expect(codecProgram.map((op) => op.op)).toEqual([
            "openai_responses.body_field",
            "response.model",
            "openai_responses.usage",
        ]);
        expect(
            OpenAIResponsesTranslator.toStreamResponses(codecProgram),
        ).toEqual([
            {
                type: "response.completed",
                response: { ...event.response, status: "completed" },
            },
        ]);
    });

    test("a Chat tool call argument chunk lowers to delta events that hold no model", () => {
        const argumentChunk = OpenAIChatTranslator.fromStreamResponse(
            chatChunk([
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            { index: 0, function: { arguments: '{"city":' } },
                        ],
                    },
                    finish_reason: null,
                },
            ]),
        );
        expect(argumentChunk.filter((op) => op.op.endsWith(".model"))).toEqual([
            { op: "response.model", model: "gpt-4o-2024-08-06" },
        ]);
        expect(AnthropicTranslator.toStreamResponses(argumentChunk)).toEqual([
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"city":' },
            },
        ]);
        expect(
            OpenAIResponsesTranslator.toStreamResponses(argumentChunk),
        ).toEqual([
            {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                delta: '{"city":',
            },
        ]);
    });

    test("a Gemini stream chunk raises modelVersion as response.model", () => {
        const raised = GeminiTranslator.fromStreamResponse({
            modelVersion: "gemini-2.5-flash",
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "hi" }] },
                    index: 0,
                },
            ],
        });
        expect(raised.filter((op) => op.op.endsWith(".model"))).toEqual([
            { op: "response.model", model: "gemini-2.5-flash" },
        ]);
    });

    test("a recorded Realtime response.done event names no model, and none is raised from it", () => {
        const recording = JSON.parse(
            readFileSync(
                new URL(
                    "../e2e/openai_realtime/output/latest/text.gpt-realtime-2.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        ) as { rawResponseEvents: { type: string }[] };
        const done = recording.rawResponseEvents.find(
            (event) => event.type === "response.done",
        );
        expect(done).toBeDefined();
        const fromRealtime = OpenAIRealtimeTranslator.fromStreamResponse(done);
        expect(fromRealtime.filter((op) => op.op.endsWith(".model"))).toEqual(
            [],
        );
        expect(
            OpenAIRealtimeTranslator.toStreamResponses(fromRealtime),
        ).toEqual([done]);
        expect(
            OpenAIChatTranslator.toStreamResponses(fromRealtime)[0],
        ).not.toHaveProperty("model");
    });
});
