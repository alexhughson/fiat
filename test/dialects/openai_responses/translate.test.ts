import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    OpenAIResponsesTranslator,
} from "../../../src/index";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "../../fixtures/request_stress";

describe("openai_responses translation", () => {
    test("an openai chat request can lower to the responses input shape", () => {
        const body = OpenAIResponsesTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            }),
        );

        expect(body).toEqual({
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            ],
        });
    });

    const onePixelPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    test("a Gemini inline image lowers to OpenAI Responses for GPT-6 Luna", () => {
        const program = GeminiTranslator.fromBody({
            model: "models/gemini-3.5-flash-lite",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "What is in this image?" },
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: onePixelPng,
                            },
                        },
                    ],
                },
            ],
        }).map((op) =>
            op.op === "llm.model" ? { ...op, model: "gpt-6-luna" } : op,
        );

        expect(OpenAIResponsesTranslator.toBody(program)).toEqual({
            model: "gpt-6-luna",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "What is in this image?",
                        },
                        {
                            type: "input_image",
                            image_url: `data:image/png;base64,${onePixelPng}`,
                        },
                    ],
                },
            ],
        });
    });

    test.each(["gpt-6-luna", "glm-5.3-vision"])(
        "Responses image input round-trips without a model-name allowlist for %s",
        (model) => {
            const body = {
                model,
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "What is in this image?",
                            },
                            {
                                type: "input_image",
                                image_url: `data:image/png;base64,${onePixelPng}`,
                            },
                        ],
                    },
                ],
            };

            expect(
                OpenAIResponsesTranslator.toBody(
                    OpenAIResponsesTranslator.fromBody(body),
                ),
            ).toEqual(body);
        },
    );

    const userInput = [
        {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
        },
    ];
    test.each([
        [
            "model, input, instructions",
            {
                model: "gpt-4o-mini",
                input: userInput,
                instructions: "Reply tersely.",
            },
        ],
        [
            "input, model, instructions",
            {
                input: userInput,
                model: "gpt-4o-mini",
                instructions: "Reply tersely.",
            },
        ],
    ])(
        "a responses request with keys in the order %s lowers to Anthropic and Gemini",
        (_order, body) => {
            const program = OpenAIResponsesTranslator.fromBody(body);

            expect(program.filter((op) => op.op === "llm.text")).toEqual([
                { op: "llm.text", role: "system", content: "Reply tersely." },
                { op: "llm.text", role: "user", content: "hi" },
            ]);
            expect(AnthropicTranslator.toBody(program)).toEqual({
                model: "gpt-4o-mini",
                max_tokens: 4096,
                system: "Reply tersely.",
                messages: [
                    { role: "user", content: [{ type: "text", text: "hi" }] },
                ],
            });
            expect(GeminiTranslator.toBody(program)).toEqual({
                model: "gpt-4o-mini",
                contents: [{ role: "user", parts: [{ text: "hi" }] }],
                systemInstruction: { parts: [{ text: "Reply tersely." }] },
            });
        },
    );

    test("portable server tools translate from Anthropic to OpenAI Responses by name", () => {
        const body = OpenAIResponsesTranslator.toBody(
            AnthropicTranslator.fromBody({
                model: "gpt-4o-mini",
                max_tokens: 800,
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: "search docs" }],
                    },
                ],
                tools: [{ type: "web_search_20260318", name: "web_search" }],
                tool_choice: { type: "tool", name: "web_search" },
            }),
        );

        expect(body).toEqual({
            model: "gpt-4o-mini",
            max_output_tokens: 800,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "search docs" }],
                },
            ],
            tools: [{ type: "web_search_preview" }],
            tool_choice: { type: "web_search_preview" },
        });
    });

    describe("mixed-vendor history request target", () => {
        test("lowers to OpenAI Responses", () => {
            expect(
                OpenAIResponsesTranslator.toBody(mixedHistoryProgram),
            ).toEqual({
                model: "gpt-4o-mini",
                max_output_tokens: 256,
                instructions:
                    "use the invoice and policy tools, then answer tersely.",
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "check invoice INV-7 and the refund policy for pro annual",
                            },
                        ],
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content:
                            "i am checking the invoice and the policy now.",
                    },
                    {
                        type: "function_call",
                        call_id: "call_invoice",
                        name: "lookup_invoice",
                        arguments: '{"invoice_id":"INV-7"}',
                    },
                    {
                        type: "function_call",
                        call_id: "call_policy",
                        name: "lookup_policy",
                        arguments: '{"plan":"pro_annual"}',
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_invoice",
                        output: '{"status":"paid","refundable":true}',
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_policy",
                        output: '{"window_days":30}',
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content:
                            "the invoice is paid and refundable within 30 days.",
                    },
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "answer in one line",
                            },
                        ],
                    },
                ],
                tools: [
                    {
                        type: "function",
                        name: "lookup_invoice",
                        description: "Fetch invoice status by invoice id.",
                        parameters: {
                            type: "object",
                            properties: {
                                invoice_id: { type: "string" },
                            },
                            required: ["invoice_id"],
                        },
                        strict: true,
                    },
                    {
                        type: "function",
                        name: "lookup_policy",
                        description: "Fetch refund policy by plan.",
                        parameters: {
                            type: "object",
                            properties: {
                                plan: { type: "string" },
                            },
                            required: ["plan"],
                        },
                    },
                ],
                tool_choice: "auto",
            });
        });
    });

    describe("refund workflow request target", () => {
        test("lowers to OpenAI Responses", () => {
            expect(
                OpenAIResponsesTranslator.toBody(refundWorkflowProgram),
            ).toEqual({
                model: "gpt-4o-mini",
                max_output_tokens: 512,
                instructions:
                    "use the billing policy. after any tool use, answer in one sentence.",
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "refund invoice inv_1001 if it was paid twice.",
                            },
                        ],
                    },
                    {
                        type: "function_call",
                        call_id: "call_lookup_1",
                        name: "lookup_invoice",
                        arguments: '{"invoice_id":"inv_1001"}',
                        id: "fc_item_lookup_1",
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_lookup_1",
                        output: '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content:
                            "invoice inv_1001 was paid twice. i will issue the refund.",
                    },
                    {
                        type: "function_call",
                        call_id: "call_refund_1",
                        name: "issue_refund",
                        arguments:
                            '{"invoice_id":"inv_1001","amount_cents":1250}',
                        id: "fc_item_refund_1",
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_refund_1",
                        output: '{"refund_id":"rf_900","status":"submitted"}',
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: "refund rf_900 is submitted.",
                    },
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "summarize the outcome in one sentence.",
                            },
                        ],
                    },
                ],
                tools: [
                    {
                        type: "function",
                        name: "lookup_invoice",
                        description: "fetch invoice state",
                        parameters: {
                            type: "object",
                            properties: {
                                invoice_id: { type: "string" },
                            },
                            required: ["invoice_id"],
                        },
                        strict: true,
                    },
                    {
                        type: "function",
                        name: "issue_refund",
                        description: "submit a refund",
                        parameters: {
                            type: "object",
                            properties: {
                                invoice_id: { type: "string" },
                                amount_cents: { type: "number" },
                            },
                            required: ["invoice_id", "amount_cents"],
                        },
                    },
                ],
                tool_choice: "auto",
            });
        });
    });

    describe("gemini-shaped planner request target", () => {
        test("lowers to OpenAI Responses", () => {
            expect(
                OpenAIResponsesTranslator.toBody(geminiPlannerProgram),
            ).toEqual({
                model: "models/gemini-3.5-flash",
                max_output_tokens: 384,
                instructions:
                    "plan carefully, keep tool context, and answer briefly.",
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "find the paris office and then check its weather",
                            },
                        ],
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: "i am resolving the office first.",
                    },
                    {
                        type: "function_call",
                        call_id: "call_office",
                        name: "lookup_office",
                        arguments: '{"city":"Paris"}',
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_office",
                        output: '{"office":"Paris HQ"}',
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: "office found. now checking the weather.",
                    },
                    {
                        type: "function_call",
                        call_id: "call_weather",
                        name: "get_weather",
                        arguments: '{"office":"Paris HQ"}',
                    },
                    {
                        type: "function_call_output",
                        call_id: "call_weather",
                        output: '{"temp_c":21,"condition":"sunny"}',
                    },
                    {
                        type: "message",
                        role: "assistant",
                        content: "paris hq is sunny and 21c.",
                    },
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_text",
                                text: "reply in one sentence",
                            },
                        ],
                    },
                ],
                tools: [
                    {
                        type: "function",
                        name: "lookup_office",
                        description: "Resolve an office name from a city.",
                        parameters: {
                            type: "object",
                            properties: { city: { type: "string" } },
                            required: ["city"],
                        },
                    },
                    {
                        type: "function",
                        name: "get_weather",
                        description: "Fetch the weather for an office.",
                        parameters: {
                            type: "object",
                            properties: { office: { type: "string" } },
                            required: ["office"],
                        },
                    },
                ],
            });
        });
    });

    test("an anthropic response id lowers into the openai responses id", () => {
        const response = OpenAIResponsesTranslator.toResponse(
            AnthropicTranslator.fromResponse({
                id: "msg_01ABC",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "It is correct." }],
                stop_reason: "end_turn",
                usage: {
                    input_tokens: 20,
                    cache_read_input_tokens: 4,
                    cache_creation_input_tokens: 2,
                    output_tokens: 9,
                    output_tokens_details: { thinking_tokens: 1 },
                },
            }),
        ) as Record<string, unknown>;

        expect(response.id).toBe("msg_01ABC");
    });

    test("an anthropic response without a cache count lowers into openai responses with 0s for the parts it lacks", () => {
        // Every key of the responses usage object is a required number, so a
        // program whose source reported no count fills those fields with 0;
        // the call returns, which a proxy routing between dialects needs.
        const response = OpenAIResponsesTranslator.toResponse(
            AnthropicTranslator.fromResponse({
                id: "msg_nocache",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "It is correct." }],
                stop_reason: "end_turn",
                usage: { input_tokens: 20, output_tokens: 9 },
            }),
        ) as Record<string, unknown>;
        expect(response.usage).toEqual({
            input_tokens: 20,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 9,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 29,
        });
    });

    test("pause_turn does not become max_output_tokens when targeting openai responses", () => {
        expect(() =>
            OpenAIResponsesTranslator.toResponse(
                AnthropicTranslator.fromResponse({
                    id: "msg_pause",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-6",
                    content: [{ type: "text", text: "still working" }],
                    stop_reason: "pause_turn",
                    usage: { input_tokens: 1, output_tokens: 2 },
                }),
            ),
        ).toThrow(LintError);
    });

    test("refusal-only openai chat responses translate as assistant text", () => {
        const response = OpenAIResponsesTranslator.toResponse(
            OpenAIChatTranslator.fromResponse({
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: null,
                            refusal: "cannot do that",
                        },
                        finish_reason: "stop",
                    },
                ],
            }),
        ) as { output: { content: { text: string }[] }[] };

        expect(response.output[0]!.content[0]!.text).toBe("cannot do that");
    });
});
