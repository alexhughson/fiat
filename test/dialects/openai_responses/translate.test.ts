import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
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
                        content: [
                            {
                                type: "input_text",
                                text: "i am checking the invoice and the policy now.",
                            },
                        ],
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
                        content: [
                            {
                                type: "input_text",
                                text: "the invoice is paid and refundable within 30 days.",
                            },
                        ],
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
                        content: [
                            {
                                type: "input_text",
                                text: "invoice inv_1001 was paid twice. i will issue the refund.",
                            },
                        ],
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
                        content: [
                            {
                                type: "input_text",
                                text: "refund rf_900 is submitted.",
                            },
                        ],
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
                        content: [
                            {
                                type: "input_text",
                                text: "i am resolving the office first.",
                            },
                        ],
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
                        content: [
                            {
                                type: "input_text",
                                text: "office found. now checking the weather.",
                            },
                        ],
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
                        content: [
                            {
                                type: "input_text",
                                text: "paris hq is sunny and 21c.",
                            },
                        ],
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
