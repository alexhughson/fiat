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
                usage: { input_tokens: 20, output_tokens: 9 },
            }),
        ) as Record<string, unknown>;

        expect(response.id).toBe("msg_01ABC");
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

    test("an OpenAI call crosses to Gemini and its tool result returns with only the call id", () => {
        const response = GeminiTranslator.toResponse(
            OpenAIResponsesTranslator.fromResponse({
                id: "resp_weather_9",
                status: "completed",
                model: "glm-5.3",
                output: [
                    {
                        type: "function_call",
                        id: "fc_item_9",
                        call_id: "call_weather_9",
                        name: "weather_now",
                        arguments: '{"city":"Halifax"}',
                    },
                ],
            }),
        ) as {
            candidates: {
                content: {
                    parts: {
                        functionCall: {
                            id: string;
                            name: string;
                            args: Record<string, unknown>;
                        };
                    }[];
                };
            }[];
        };
        const call = response.candidates[0]!.content.parts[0]!.functionCall;
        expect(call).toEqual({
            id: "call_weather_9",
            name: "weather_now",
            args: { city: "Halifax" },
        });

        const secondRequest = OpenAIResponsesTranslator.toBody(
            GeminiTranslator.fromBody({
                model: "glm-5.3",
                contents: [
                    { role: "model", parts: [{ functionCall: call }] },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    id: call.id,
                                    name: call.name,
                                    response: { temperature: 17 },
                                },
                            },
                        ],
                    },
                ],
            }),
        );
        expect(secondRequest).toEqual({
            model: "glm-5.3",
            input: [
                {
                    type: "function_call",
                    call_id: "call_weather_9",
                    name: "weather_now",
                    arguments: '{"city":"Halifax"}',
                },
                {
                    type: "function_call_output",
                    call_id: "call_weather_9",
                    output: '{"temperature":17}',
                },
            ],
        });
    });

    test("a Gemini call gains a Responses item id and its tool result returns to Gemini", () => {
        const response = OpenAIResponsesTranslator.toResponse(
            GeminiTranslator.fromResponse({
                responseId: "resp_gemini_1",
                candidates: [
                    {
                        content: {
                            role: "model",
                            parts: [
                                {
                                    functionCall: {
                                        id: "call_gemini_1",
                                        name: "lookup",
                                        args: { key: "alpha" },
                                    },
                                },
                            ],
                        },
                        finishReason: "STOP",
                    },
                ],
            }),
        ) as {
            output: {
                id: string;
                call_id: string;
                name: string;
                arguments: string;
            }[];
        };
        const call = response.output[0]!;
        expect(call.id).toMatch(/^fc_[0-9a-f]{32}$/);
        expect(call).toMatchObject({
            call_id: "call_gemini_1",
            name: "lookup",
            arguments: '{"key":"alpha"}',
        });

        const secondRequest = GeminiTranslator.toBody(
            OpenAIResponsesTranslator.fromBody({
                model: "gemini-3.5-flash-lite",
                input: [
                    {
                        type: "function_call",
                        id: call.id,
                        call_id: call.call_id,
                        name: call.name,
                        arguments: call.arguments,
                    },
                    {
                        type: "function_call_output",
                        call_id: call.call_id,
                        output: '{"value":17}',
                    },
                ],
            }),
        );
        expect(secondRequest).toEqual({
            model: "gemini-3.5-flash-lite",
            contents: [
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                id: "call_gemini_1",
                                name: "lookup",
                                args: { key: "alpha" },
                            },
                            thoughtSignature:
                                "skip_thought_signature_validator",
                        },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                id: "call_gemini_1",
                                name: "lookup",
                                response: { value: 17 },
                            },
                        },
                    ],
                },
            ],
        });
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
