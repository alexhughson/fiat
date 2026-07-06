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
