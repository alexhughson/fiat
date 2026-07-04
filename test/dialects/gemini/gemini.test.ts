import { describe, expect, test } from "bun:test";
import {
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    translateStreamResponse,
} from "../../../src/index";
import {
    geminiFunctionCallResponseFixture,
    geminiModelFixture,
    geminiRequestFixture,
    geminiTextResponseFixture,
    geminiWeatherToolName,
} from "../../fixtures/gemini";

const model = geminiModelFixture;

describe("gemini requests", () => {
    test("text, system, tools, tool choice, and function responses round-trip", () => {
        const body = geminiRequestFixture;

        expect(GeminiTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model },
            { op: "llm.text", role: "system", content: "Reply tersely." },
            { op: "llm.max_output_tokens", value: 80 },
            { op: "llm.temperature", value: 0.2 },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingBudget: 0 } },
            },
            {
                op: "llm.text",
                role: "user",
                content: "What's the weather in Paris?",
            },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: '{"temp_c":21}' },
            {
                op: "gemini.part_meta",
                part: {
                    kind: "functionResponse",
                    index: 0,
                    id: "call_1",
                    name: "get_weather",
                    response: { temp_c: 21 },
                },
                required: false,
            },
            {
                op: "llm.tool",
                name: "get_weather",
                description: "Get the current weather for a city.",
                inputSchema: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                },
            },
            { op: "llm.tool_choice", value: { name: "get_weather" } },
        ]);
        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("a bare tool_result without a function name fails loudly", () => {
        expect(() =>
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                { op: "llm.tool_result", id: "call_1", content: '{"ok":true}' },
            ]),
        ).toThrow("functionResponse.name");
    });

    test("systemInstruction round-trips even when it follows contents on the wire", () => {
        const body = {
            model,
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            systemInstruction: { parts: [{ text: "Reply tersely." }] },
        };

        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("tool_result isError halts instead of serializing as a normal functionResponse", () => {
        expect(() =>
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
                {
                    op: "llm.tool_result",
                    id: "call_1",
                    content: '{"message":"nope"}',
                    isError: true,
                },
            ]),
        ).toThrow("isError");
    });

    test("unsupported content-level fields halt instead of being dropped", () => {
        expect(() =>
            GeminiTranslator.fromBody({
                model,
                contents: [
                    {
                        role: "user",
                        parts: [{ text: "hi" }],
                        cacheControl: true,
                    },
                ],
            }),
        ).toThrow("unsupported fields cacheControl");
    });

    test("request history keeps a previous functionCall thoughtSignature", () => {
        const responseProgram = GeminiTranslator.fromResponse(
            geminiFunctionCallResponseFixture,
        );

        const body = GeminiTranslator.toBody([
            { op: "llm.model", model },
            { op: "llm.text", role: "user", content: "weather?" },
            ...responseProgram,
            { op: "llm.tool_result", id: "call_1", content: '{"temp_c":21}' },
        ]) as Record<string, unknown>;

        expect(body.contents).toEqual([
            { role: "user", parts: [{ text: "weather?" }] },
            {
                role: "model",
                parts: [
                    {
                        functionCall: {
                            name: geminiWeatherToolName,
                            args: { city: "Paris" },
                            id: "call_1",
                        },
                        thoughtSignature: "sig",
                    },
                ],
            },
            {
                role: "user",
                parts: [
                    {
                        functionResponse: {
                            name: geminiWeatherToolName,
                            response: { temp_c: 21 },
                            id: "call_1",
                        },
                    },
                ],
            },
        ]);
    });

    test("request history keeps thoughtSignature when Gemini omitted functionCall.id", () => {
        const responseProgram = GeminiTranslator.fromResponse({
            model,
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: geminiWeatherToolName,
                                    args: { city: "Paris" },
                                },
                                thoughtSignature: "sig_without_id",
                            },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
            },
        });

        const body = GeminiTranslator.toBody([
            { op: "llm.model", model },
            { op: "llm.text", role: "user", content: "weather?" },
            ...responseProgram,
            {
                op: "llm.tool_result",
                id: "gemini_call_0",
                content: '{"temp_c":21}',
            },
        ]) as Record<string, unknown>;

        expect(body.contents).toEqual([
            { role: "user", parts: [{ text: "weather?" }] },
            {
                role: "model",
                parts: [
                    {
                        functionCall: {
                            name: geminiWeatherToolName,
                            args: { city: "Paris" },
                        },
                        thoughtSignature: "sig_without_id",
                    },
                ],
            },
            {
                role: "user",
                parts: [
                    {
                        functionResponse: {
                            name: geminiWeatherToolName,
                            response: { temp_c: 21 },
                            id: "gemini_call_0",
                        },
                    },
                ],
            },
        ]);
    });

    test("request bodies with model thoughtSignature parts round-trip", () => {
        const body = {
            model,
            contents: [
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: geminiWeatherToolName,
                                args: { city: "Paris" },
                                id: "call_1",
                            },
                            thoughtSignature: "request_sig",
                        },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: geminiWeatherToolName,
                                response: { temp_c: 21 },
                                id: "call_1",
                            },
                        },
                    ],
                },
            ],
        };

        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("gemini-native built-in tools round-trip as core server tools", () => {
        const body = {
            model,
            contents: [{ role: "user", parts: [{ text: "run code" }] }],
            tools: [{ codeExecution: {} }, { googleSearch: {} }],
        };

        const program = GeminiTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.server_tool",
            name: "code_execution",
            kind: "code_execution",
        });
        expect(program).toContainEqual({
            op: "llm.server_tool",
            name: "web_search",
            kind: "web_search",
        });
        expect(GeminiTranslator.toBody(program)).toEqual(body);
    });

    test("forced server tool choice fails instead of becoming an allowed function", () => {
        expect(() =>
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                { op: "llm.text", role: "user", content: "search" },
                {
                    op: "llm.server_tool",
                    name: "web_search",
                    kind: "web_search",
                },
                { op: "llm.tool_choice", value: { name: "web_search" } },
            ]),
        ).toThrow(LintError);
    });

    test("mixed text and native multimodal request parts round-trip in order", () => {
        const body = {
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: "abc",
                            },
                        },
                        { text: "describe this" },
                        {
                            fileData: {
                                mimeType: "application/pdf",
                                fileUri: "gs://bucket/doc.pdf",
                            },
                        },
                        { text: "briefly" },
                    ],
                },
            ],
        };

        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("roleless request contents from REST examples round-trip as native Gemini content", () => {
        const body = {
            model,
            contents: [
                {
                    parts: [
                        { text: "describe this" },
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: "abc",
                            },
                        },
                    ],
                },
            ],
        };

        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("llm.output lowers to Gemini structured output generationConfig", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "weather_answer",
                    schema: {
                        type: "object",
                        properties: { city: { type: "string" } },
                        required: ["city"],
                    },
                },
                { op: "llm.text", role: "user", content: "weather?" },
            ]),
        ).toEqual({
            model,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                },
            },
            contents: [{ role: "user", parts: [{ text: "weather?" }] }],
        });
    });

    test("llm.output conflicts with existing Gemini structured output config", () => {
        expect(() =>
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                {
                    op: "gemini.generation_config",
                    value: { responseMimeType: "text/plain" },
                },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "weather_answer",
                    schema: { type: "object" },
                },
                { op: "llm.text", role: "user", content: "weather?" },
            ]),
        ).toThrow("llm.output conflicts");
    });

    test("thinkingLevel becomes thinkingBudget on pre-Gemini-3 generateContent models", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model: "models/gemini-2.5-flash" },
                {
                    op: "gemini.generation_config",
                    value: { thinkingConfig: { thinkingLevel: "LOW" } },
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "models/gemini-2.5-flash",
            generationConfig: {
                thinkingConfig: { thinkingBudget: 1024 },
            },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });

        expect(() =>
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model: "models/gemini-2.5-flash" },
                    {
                        op: "gemini.generation_config",
                        value: { thinkingConfig: { thinkingLevel: "LOW" } },
                    },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow("thinkingLevel is only supported by Gemini 3 or later");
    });

    test("thinkingLevel passes through for Gemini 3 generateContent models", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                {
                    op: "gemini.generation_config",
                    value: { thinkingConfig: { thinkingLevel: "LOW" } },
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model,
            generationConfig: {
                thinkingConfig: { thinkingLevel: "LOW" },
            },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });
    });

    test("Gemini 3 native thinkingLevel clamps max-like values unless strict mode is requested", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                {
                    op: "gemini.generation_config",
                    value: { thinkingConfig: { thinkingLevel: "MAX" } },
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model,
            generationConfig: {
                thinkingConfig: { thinkingLevel: "high" },
            },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });

        expect(() =>
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model },
                    {
                        op: "gemini.generation_config",
                        value: { thinkingConfig: { thinkingLevel: "MAX" } },
                    },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow('thinkingLevel does not support effort "max"');
    });

    test("llm.thinking lowers to Gemini 3 thinkingLevel", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                { op: "llm.thinking", effort: "high" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model,
            generationConfig: {
                thinkingConfig: { thinkingLevel: "high" },
            },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });
    });

    test("llm.thinking lowers to Gemini 2.5 thinkingBudget token limits", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model: "models/gemini-2.5-flash" },
                { op: "llm.thinking", effort: "medium" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "models/gemini-2.5-flash",
            generationConfig: {
                thinkingConfig: { thinkingBudget: 4096 },
            },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });
    });

    test("Gemini 2.5 maps every portable thinking effort to a budget", () => {
        const cases = [
            ["low", 1024],
            ["medium", 4096],
            ["high", 8192],
            ["xhigh", 16384],
            ["max", 24576],
        ] as const;

        for (const [effort, thinkingBudget] of cases) {
            expect(
                GeminiTranslator.toBody([
                    { op: "llm.model", model: "models/gemini-2.5-flash" },
                    { op: "llm.thinking", effort },
                    { op: "llm.text", role: "user", content: "hi" },
                ]),
            ).toMatchObject({
                generationConfig: {
                    thinkingConfig: { thinkingBudget },
                },
            });
        }
    });

    test("Gemini 3 clamps unsupported portable thinking efforts unless strict mode is requested", () => {
        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                { op: "llm.thinking", effort: "xhigh" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            generationConfig: {
                thinkingConfig: { thinkingLevel: "high" },
            },
        });

        expect(
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                { op: "llm.thinking", effort: "max" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            generationConfig: {
                thinkingConfig: { thinkingLevel: "high" },
            },
        });

        expect(() =>
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model },
                    { op: "llm.thinking", effort: "max" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow('thinkingLevel does not support llm.thinking effort "max"');
    });
});

describe("gemini responses", () => {
    const wireResponse = geminiTextResponseFixture;

    test("text responses raise to assistant text, usage, stop, and response-only residuals", () => {
        expect(GeminiTranslator.fromResponse(wireResponse)).toEqual([
            { op: "llm.model", model },
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "gemini.part_meta",
                part: {
                    kind: "text",
                    index: 0,
                    meta: { thoughtSignature: "thought_sig_1" },
                },
                required: false,
            },
            { op: "response.stop", reason: "end_turn" },
            {
                op: "gemini.candidate_meta",
                candidate: {
                    safetyRatings: [
                        {
                            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                            probability: "NEGLIGIBLE",
                        },
                    ],
                },
                appliesTo: "response",
                required: false,
            },
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            {
                op: "gemini.usage",
                usage: {
                    totalTokenCount: 14,
                    thoughtsTokenCount: 1,
                    serviceTier: "default",
                },
                appliesTo: "response",
                required: false,
            },
            {
                op: "gemini.body_field",
                key: "responseId",
                value: "resp_123",
                appliesTo: "response",
                required: false,
            },
        ]);
    });

    test("responses round-trip without promoting thoughtSignature into core", () => {
        expect(
            GeminiTranslator.toResponse(
                GeminiTranslator.fromResponse(wireResponse),
            ),
        ).toEqual(wireResponse);
    });

    test("functionCall parts raise to llm.tool_call with object args", () => {
        const program = GeminiTranslator.fromResponse(
            geminiFunctionCallResponseFixture,
        );

        expect(program).toContainEqual({
            op: "llm.tool_call",
            id: "call_1",
            name: "get_weather",
            arguments: { city: "Paris" },
        });
        expect(program).toContainEqual({
            op: "gemini.part_meta",
            part: {
                kind: "functionCall",
                index: 0,
                id: "call_1",
                meta: { thoughtSignature: "sig" },
            },
            required: false,
        });
    });

    test("functionCall parts without ids get a stable core id without adding one on round-trip", () => {
        const wire = {
            model,
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { city: "Paris" },
                                },
                            },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                totalTokenCount: 14,
            },
        };
        const program = GeminiTranslator.fromResponse(wire);

        expect(program).toContainEqual({
            op: "llm.tool_call",
            id: "gemini_call_0",
            name: "get_weather",
            arguments: { city: "Paris" },
        });
        expect(program).toContainEqual({
            op: "gemini.part_meta",
            part: {
                kind: "functionCall",
                index: 0,
                id: "gemini_call_0",
                idSource: "synthesized",
            },
            required: false,
        });
        expect(GeminiTranslator.toResponse(program)).toEqual(wire);
    });

    test("unmapped finish reasons halt instead of guessing", () => {
        expect(() =>
            GeminiTranslator.fromResponse({
                model,
                candidates: [
                    {
                        content: { role: "model", parts: [{ text: "" }] },
                        finishReason: "RECITATION",
                    },
                ],
            }),
        ).toThrow("no core stop reason mapping");
    });

    test("pause and context-window stops do not lower as MAX_TOKENS", () => {
        for (const reason of [
            "pause_turn",
            "model_context_window_exceeded",
        ] as const) {
            const lower = () =>
                GeminiTranslator.toResponse([
                    { op: "llm.model", model },
                    { op: "llm.text", role: "assistant", content: "partial" },
                    { op: "response.stop", reason },
                ]);

            expect(lower).toThrow(LintError);
            expect(lower).toThrow(
                `response.stop ${reason} has no finishReason mapping`,
            );
        }
    });

    test("malformed usage token counts halt", () => {
        expect(() =>
            GeminiTranslator.fromResponse({
                model,
                candidates: [
                    {
                        content: { role: "model", parts: [{ text: "pong" }] },
                        finishReason: "STOP",
                    },
                ],
                usageMetadata: {
                    promptTokenCount: "12",
                    candidatesTokenCount: 2,
                },
            }),
        ).toThrow("usageMetadata.promptTokenCount");
    });
});

describe("gemini stream responses", () => {
    test("text chunks raise to response.text_delta and lower back to Gemini chunks", () => {
        const chunk = {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [{ text: "hi" }],
                    },
                },
            ],
        };

        expect(GeminiTranslator.fromStreamResponse(chunk)).toEqual([
            { op: "response.text_delta", role: "assistant", content: "hi" },
        ]);
        expect(
            GeminiTranslator.toStreamResponse(
                GeminiTranslator.fromStreamResponse(chunk),
            ),
        ).toEqual(chunk);
    });

    test("functionCall chunks raise to complete tool_call deltas and lower back to Gemini chunks", () => {
        const chunk = {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "lookup",
                                    args: { x: "1" },
                                },
                            },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
        };

        expect(GeminiTranslator.fromStreamResponse(chunk)).toEqual([
            {
                op: "response.tool_call_delta",
                index: 0,
                name: "lookup",
                arguments: '{"x":"1"}',
            },
            { op: "response.stop", reason: "end_turn" },
        ]);
        expect(
            GeminiTranslator.toStreamResponse(
                GeminiTranslator.fromStreamResponse(chunk),
            ),
        ).toEqual(chunk);
    });

    test("usage-only chunks raise and lower without synthesizing an empty candidate", () => {
        const chunk = {
            usageMetadata: {
                promptTokenCount: 3,
                candidatesTokenCount: 2,
            },
        };

        expect(GeminiTranslator.fromStreamResponse(chunk)).toEqual([
            { op: "response.usage", inputTokens: 3, outputTokens: 2 },
        ]);
        expect(
            GeminiTranslator.toStreamResponse(
                GeminiTranslator.fromStreamResponse(chunk),
            ),
        ).toEqual(chunk);
    });

    test("Gemini text chunks translate through the generic stream response ops", () => {
        const openaiChunk = translateStreamResponse(
            {
                candidates: [
                    {
                        content: {
                            role: "model",
                            parts: [{ text: "hi" }],
                        },
                    },
                ],
            },
            { from: GeminiTranslator, to: OpenAIChatTranslator },
        ) as {
            object: string;
            choices: { delta: { role: string; content: string } }[];
        };

        expect(openaiChunk.object).toBe("chat.completion.chunk");
        expect(openaiChunk.choices[0]!.delta).toEqual({
            role: "assistant",
            content: "hi",
        });
    });
});
