import { describe, expect, spyOn, test } from "bun:test";
import {
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    type Program,
} from "../../../src/index";
import {
    geminiFunctionCallResponseFixture,
    geminiModelFixture,
    geminiRequestFixture,
    geminiTextResponseFixture,
    geminiWeatherToolName,
} from "../../fixtures/gemini";

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
                    of: "call_1",
                    name: "get_weather",
                },
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
        ).toEqual({
            ...body,
            contents: [
                body.contents[0],
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: geminiWeatherToolName,
                                args: { city: "Paris" },
                                id: "call_1",
                            },
                            thoughtSignature:
                                "skip_thought_signature_validator",
                        },
                    ],
                },
                body.contents[2],
            ],
        });
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

    test("Anthropic tool_result error metadata warns and drops for Gemini", () => {
        withWarnSpy((warn) => {
            const body = GeminiTranslator.toBody([
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
                },
                {
                    op: "anthropic_messages.tool_result_meta",
                    id: "call_1",
                    is_error: true,
                },
            ]) as Record<string, unknown>;

            expect(body.contents).toBeDefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "anthropic_messages.tool_result_meta"',
                ),
            );
        });
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

    test("core tool history without a Gemini response injects fake thoughtSignature", () => {
        const body = GeminiTranslator.toBody([
            { op: "llm.model", model },
            { op: "llm.text", role: "user", content: "weather?" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: geminiWeatherToolName,
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: '{"temp_c":21}' },
            {
                op: "llm.tool",
                name: geminiWeatherToolName,
                description: "Get the current weather for a city.",
                inputSchema: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                },
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
                            id: "call_1",
                        },
                        thoughtSignature: "skip_thought_signature_validator",
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

    test("mixed text, inline image, and native file request parts round-trip in order", () => {
        const fileData = {
            mimeType: "application/pdf",
            fileUri: "gs://bucket/doc.pdf",
        };
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
                        { fileData },
                        { text: "briefly" },
                    ],
                },
            ],
        };

        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual({
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inline_data: {
                                mime_type: "image/png",
                                data: "abc",
                            },
                        },
                        { text: "describe this" },
                        { fileData },
                        { text: "briefly" },
                    ],
                },
            ],
        });
    });

    test("REST inline image data raises to portable image ops", () => {
        const body = {
            model,
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
                        { text: "answer briefly" },
                    ],
                },
            ],
        };

        expect(GeminiTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model },
            { op: "llm.text", role: "user", content: "what is this?" },
            {
                op: "llm.image",
                role: "user",
                source: {
                    type: "base64",
                    mediaType: "image/png",
                    data: "aW1hZ2U=",
                },
            },
            { op: "llm.text", role: "user", content: "answer briefly" },
        ]);
        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("camel-case inlineData raises to the same media ops as inline_data", () => {
        const kinds: [string, string][] = [
            ["image/png", "llm.image"],
            ["audio/wav", "llm.audio"],
            ["application/pdf", "llm.document"],
            ["video/mp4", "llm.video"],
        ];
        for (const [mediaType, op] of kinds) {
            const camel = {
                model,
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    mimeType: mediaType,
                                    data: "eA==",
                                },
                            },
                        ],
                    },
                ],
            };
            const raised = [
                { op: "llm.model", model },
                {
                    op,
                    role: "user",
                    source: { type: "base64", mediaType, data: "eA==" },
                },
            ];

            expect(GeminiTranslator.fromBody(camel)).toEqual(raised);
            for (const blob of [
                { mime_type: mediaType, data: "eA==" },
                { mimeType: mediaType, data: "eA==" },
            ]) {
                expect(
                    GeminiTranslator.fromBody({
                        model,
                        contents: [
                            {
                                role: "user",
                                parts: [{ inline_data: blob }],
                            },
                        ],
                    }),
                ).toEqual(raised);
            }
        }
    });

    test("an inlineData part with no mimeType fails like an inline_data part with no mime_type", () => {
        for (const part of [
            { inlineData: { data: "eA==" } },
            { inline_data: { data: "eA==" } },
        ]) {
            expect(() =>
                GeminiTranslator.fromBody({
                    model,
                    contents: [{ role: "user", parts: [part] }],
                }),
            ).toThrow("expected a string, got undefined");
        }
    });

    test("an inline media part that also sets another Gemini part field fails instead of dropping the media", () => {
        const image = { mimeType: "image/png", data: "aW1hZ2U=" };
        const snakeImage = { mime_type: "image/png", data: "aW1hZ2U=" };
        for (const [part, fields] of [
            [{ inlineData: image, text: "hi" }, "text"],
            [{ inline_data: snakeImage, text: "hi" }, "text"],
            [{ inline_data: snakeImage, inlineData: image }, "inlineData"],
            [
                {
                    inlineData: image,
                    fileData: {
                        mimeType: "image/png",
                        fileUri: "gs://bucket/image.png",
                    },
                },
                "fileData",
            ],
            [
                {
                    inlineData: image,
                    functionResponse: {
                        name: "describe",
                        id: "call_1",
                        response: {},
                    },
                },
                "functionResponse",
            ],
        ] as const) {
            expect(() =>
                GeminiTranslator.fromBody({
                    model,
                    contents: [{ role: "user", parts: [part] }],
                }),
            ).toThrow(`gemini inline media part: unsupported fields ${fields}`);
        }
    });

    test("an inlineData image with a snake-case mime_type lowers into OpenAI Chat", () => {
        const program = GeminiTranslator.fromBody({
            model: "gpt-4o",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "what is this?" },
                        {
                            inlineData: {
                                mime_type: "image/png",
                                data: "aW1hZ2U=",
                            },
                        },
                    ],
                },
            ],
        });

        expect(OpenAIChatTranslator.toBody(program)).toEqual({
            model: "gpt-4o",
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
    });

    test("inline media parts with other part or blob fields stay native in both key forms", () => {
        const body = {
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                mimeType: "video/mp4",
                                data: "dmlkZW8=",
                            },
                            videoMetadata: { fps: 2 },
                        },
                        {
                            inline_data: {
                                mime_type: "image/png",
                                data: "aW1hZ2U=",
                                display_name: "chart.png",
                            },
                        },
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: "aW1hZ2U=",
                                displayName: "chart.png",
                            },
                        },
                    ],
                },
            ],
        };

        expect(
            GeminiTranslator.fromBody(body)
                .slice(1)
                .map((op) => op.op),
        ).toEqual(["gemini.content", "gemini.content", "gemini.content"]);
        expect(
            GeminiTranslator.toBody(GeminiTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("Gemini file_data stays native instead of pretending to be portable image input", () => {
        const body = {
            model,
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            file_data: {
                                mime_type: "image/png",
                                file_uri: "gs://bucket/image.png",
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

    test("URL image sources fail for Gemini generateContent until a file upload exists", () => {
        expect(() =>
            GeminiTranslator.toBody([
                { op: "llm.model", model },
                {
                    op: "llm.image",
                    role: "user",
                    source: {
                        type: "url",
                        url: "https://example.com/invoice.png",
                    },
                },
            ]),
        ).toThrow("require provider file upload");
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
                thinkingConfig: { thinkingLevel: "HIGH" },
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

    test("llm.thinking lowers to Gemini 3 Pro thinkingLevel enum values", () => {
        const cases = [
            ["low", "LOW"],
            ["medium", "HIGH"],
            ["high", "HIGH"],
        ] as const;

        for (const [effort, thinkingLevel] of cases) {
            expect(
                GeminiTranslator.toBody([
                    { op: "llm.model", model: "models/gemini-3-pro-preview" },
                    { op: "llm.thinking", effort },
                    { op: "llm.text", role: "user", content: "hi" },
                ]),
            ).toEqual({
                model: "models/gemini-3-pro-preview",
                generationConfig: {
                    thinkingConfig: { thinkingLevel },
                },
                contents: [{ role: "user", parts: [{ text: "hi" }] }],
            });
        }
    });

    test("llm.thinking lowers to Gemini 3 Flash thinkingLevel enum values", () => {
        const cases = [
            ["low", "LOW"],
            ["medium", "MEDIUM"],
            ["high", "HIGH"],
        ] as const;

        for (const [effort, thinkingLevel] of cases) {
            expect(
                GeminiTranslator.toBody([
                    { op: "llm.model", model: "models/gemini-3.5-flash" },
                    { op: "llm.thinking", effort },
                    { op: "llm.text", role: "user", content: "hi" },
                ]),
            ).toEqual({
                model: "models/gemini-3.5-flash",
                generationConfig: {
                    thinkingConfig: { thinkingLevel },
                },
                contents: [{ role: "user", parts: [{ text: "hi" }] }],
            });
        }
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
                thinkingConfig: { thinkingLevel: "HIGH" },
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
                thinkingConfig: { thinkingLevel: "HIGH" },
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
            },
            { op: "response.id", id: "resp_123" },
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
        });
        expect(GeminiTranslator.toResponse(program)).toEqual(wire);
    });

    test("STOP raises to tool_use only when the candidate holds a functionCall part", () => {
        const stopsOf = (parts: unknown[], finishReason: string) =>
            GeminiTranslator.fromResponse({
                model,
                candidates: [
                    { content: { role: "model", parts }, finishReason },
                ],
            }).filter((op) => op.op === "response.stop");
        const call = {
            functionCall: { id: "call_1", name: "get_weather", args: {} },
        };

        expect(stopsOf([call], "STOP")).toEqual([
            { op: "response.stop", reason: "tool_use" },
        ]);
        expect(stopsOf([{ text: "It is sunny." }], "STOP")).toEqual([
            { op: "response.stop", reason: "end_turn" },
        ]);
        expect(stopsOf([call], "MAX_TOKENS")).toEqual([
            { op: "response.stop", reason: "max_tokens" },
        ]);
    });

    test("a functionCall outside the current candidate does not make a text response raise to tool_use", () => {
        const textResponse = {
            model,
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [{ text: "The answer is 19." }],
                    },
                    finishReason: "STOP",
                },
            ],
        };
        const callContent = (appliesTo: "request" | "response") =>
            ({
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                id: "history_9",
                                name: "lookup",
                                args: { code: 37 },
                            },
                        },
                    ],
                },
                appliesTo,
            }) as const;
        const stops = (program: Program) =>
            program.filter((op) => op.op === "response.stop");

        const history = GeminiTranslator.fromResponse(textResponse, {
            beforeRaise: (lower) => [callContent("request"), ...lower],
        });
        expect(history).toContainEqual({
            op: "llm.tool_call",
            id: "history_9",
            name: "lookup",
            arguments: { code: 37 },
        });
        expect(stops(history)).toEqual([
            { op: "response.stop", reason: "end_turn" },
        ]);

        // The earlier response ends in MAX_TOKENS, and the current text
        // response is already raised, so no gemini.content op of its own
        // comes before its finish reason.
        const earlierResponse = GeminiTranslator.fromResponse(textResponse, {
            beforeRaise: (lower) => [
                callContent("response"),
                { op: "gemini.finish_reason", value: "MAX_TOKENS" },
                ...lower.map((op) =>
                    op.op === "gemini.content"
                        ? {
                              op: "llm.text",
                              role: "assistant",
                              content: "The answer is 19.",
                          }
                        : op,
                ),
            ],
        });
        expect(stops(earlierResponse)).toEqual([
            { op: "response.stop", reason: "max_tokens" },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("a functionCall response with STOP lowers back to finishReason STOP", () => {
        const program = GeminiTranslator.fromResponse(
            geminiFunctionCallResponseFixture,
        );

        expect(program).toContainEqual({
            op: "response.stop",
            reason: "tool_use",
        });
        expect(GeminiTranslator.toResponse(program)).toEqual(
            geminiFunctionCallResponseFixture,
        );
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
            { op: "response.stop", reason: "tool_use" },
        ]);
        expect(
            GeminiTranslator.toStreamResponse(
                GeminiTranslator.fromStreamResponse(chunk),
            ),
        ).toEqual(chunk);
    });

    test("a stream chunk raises STOP to tool_use only when the chunk holds a functionCall part", () => {
        const opsOf = (parts: unknown[], finishReason?: string) =>
            GeminiTranslator.fromStreamResponse({
                candidates: [
                    {
                        content: { role: "model", parts },
                        ...(finishReason ? { finishReason } : {}),
                    },
                ],
            });

        expect(opsOf([{ text: "It is sunny." }], "STOP")).toEqual([
            {
                op: "response.text_delta",
                role: "assistant",
                content: "It is sunny.",
            },
            { op: "response.stop", reason: "end_turn" },
        ]);
        expect(
            opsOf([{ functionCall: { name: "lookup", args: { x: "1" } } }]),
        ).toEqual([
            {
                op: "response.tool_call_delta",
                index: 0,
                name: "lookup",
                arguments: '{"x":"1"}',
            },
        ]);
    });

    test("a tool_call_delta with response.stop tool_use lowers to a functionCall chunk with STOP", () => {
        expect(
            GeminiTranslator.toStreamResponse([
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
                { op: "response.stop", reason: "tool_use" },
            ]),
        ).toEqual({
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { city: "Paris" },
                                    id: "call_1",
                                },
                            },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
        });
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
        const openaiChunk = OpenAIChatTranslator.toStreamResponse(
            GeminiTranslator.fromStreamResponse({
                candidates: [
                    {
                        content: {
                            role: "model",
                            parts: [{ text: "hi" }],
                        },
                    },
                ],
            }),
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
