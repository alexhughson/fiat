import { describe, expect, test } from "bun:test";
import { GeminiTranslator, OpenAIChatTranslator } from "../../../src/index";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "../../fixtures/request_stress";

describe("gemini translation", () => {
    test("an openai chat request can lower to gemini contents", () => {
        const body = GeminiTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "models/gemini-3.5-flash",
                max_tokens: 80,
                temperature: 0.2,
                messages: [
                    { role: "system", content: "Reply tersely." },
                    { role: "user", content: "hi" },
                ],
            }),
        );

        expect(body).toEqual({
            model: "models/gemini-3.5-flash",
            generationConfig: { maxOutputTokens: 80, temperature: 0.2 },
            systemInstruction: { parts: [{ text: "Reply tersely." }] },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });
    });

    describe("mixed-vendor history request target", () => {
        test("lowers to Gemini", () => {
            expect(GeminiTranslator.toBody(mixedHistoryProgram)).toEqual({
                model: "gpt-4o-mini",
                generationConfig: { maxOutputTokens: 256 },
                toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: "check invoice INV-7 and the refund policy for pro annual",
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "i am checking the invoice and the policy now.",
                            },
                            {
                                functionCall: {
                                    name: "lookup_invoice",
                                    args: { invoice_id: "INV-7" },
                                    id: "call_invoice",
                                },
                                thoughtSignature: "hist_sig_invoice",
                            },
                            {
                                functionCall: {
                                    name: "lookup_policy",
                                    args: { plan: "pro_annual" },
                                    id: "call_policy",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_invoice",
                                    response: {
                                        status: "paid",
                                        refundable: true,
                                    },
                                    id: "call_invoice",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_policy",
                                    response: { window_days: 30 },
                                    id: "call_policy",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "the invoice is paid and refundable within 30 days.",
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [{ text: "answer in one line" }],
                    },
                ],
                systemInstruction: {
                    parts: [
                        {
                            text: "use the invoice and policy tools, then answer tersely.",
                        },
                    ],
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "lookup_invoice",
                                description:
                                    "Fetch invoice status by invoice id.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        invoice_id: { type: "string" },
                                    },
                                    required: ["invoice_id"],
                                },
                            },
                            {
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
                    },
                ],
            });
        });
    });

    describe("refund workflow request target", () => {
        test("lowers to Gemini", () => {
            expect(GeminiTranslator.toBody(refundWorkflowProgram)).toEqual({
                model: "gpt-4o-mini",
                generationConfig: { maxOutputTokens: 512 },
                toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: "refund invoice inv_1001 if it was paid twice.",
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "lookup_invoice",
                                    args: { invoice_id: "inv_1001" },
                                    id: "call_lookup_1|item_lookup_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_invoice",
                                    response: {
                                        invoice_id: "inv_1001",
                                        duplicate_payment: true,
                                        amount_cents: 1250,
                                    },
                                    id: "call_lookup_1|item_lookup_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "invoice inv_1001 was paid twice. i will issue the refund.",
                            },
                            {
                                functionCall: {
                                    name: "issue_refund",
                                    args: {
                                        invoice_id: "inv_1001",
                                        amount_cents: 1250,
                                    },
                                    id: "call_refund_1|item_refund_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "issue_refund",
                                    response: {
                                        refund_id: "rf_900",
                                        status: "submitted",
                                    },
                                    id: "call_refund_1|item_refund_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [{ text: "refund rf_900 is submitted." }],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                text: "summarize the outcome in one sentence.",
                            },
                        ],
                    },
                ],
                systemInstruction: {
                    parts: [
                        {
                            text: "use the billing policy. after any tool use, answer in one sentence.",
                        },
                    ],
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "lookup_invoice",
                                description: "fetch invoice state",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        invoice_id: { type: "string" },
                                    },
                                    required: ["invoice_id"],
                                },
                            },
                            {
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
                    },
                ],
            });
        });
    });

    describe("gemini-shaped planner request target", () => {
        test("lowers to Gemini", () => {
            expect(GeminiTranslator.toBody(geminiPlannerProgram)).toEqual({
                model: "models/gemini-3.5-flash",
                generationConfig: { maxOutputTokens: 384 },
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: "find the paris office and then check its weather",
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "i am resolving the office first.",
                            },
                            {
                                functionCall: {
                                    name: "lookup_office",
                                    args: { city: "Paris" },
                                    id: "call_office",
                                },
                                thoughtSignature: "sig_lookup",
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_office",
                                    response: { office: "Paris HQ" },
                                    id: "call_office",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "office found. now checking the weather.",
                            },
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { office: "Paris HQ" },
                                    id: "call_weather",
                                },
                                thoughtSignature: "sig_weather",
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "get_weather",
                                    response: {
                                        temp_c: 21,
                                        condition: "sunny",
                                    },
                                    id: "call_weather",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [{ text: "paris hq is sunny and 21c." }],
                    },
                    {
                        role: "user",
                        parts: [{ text: "reply in one sentence" }],
                    },
                ],
                systemInstruction: {
                    parts: [
                        {
                            text: "plan carefully, keep tool context, and answer briefly.",
                        },
                    ],
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "lookup_office",
                                description:
                                    "Resolve an office name from a city.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        city: { type: "string" },
                                    },
                                    required: ["city"],
                                },
                            },
                            {
                                name: "get_weather",
                                description: "Fetch the weather for an office.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        office: { type: "string" },
                                    },
                                    required: ["office"],
                                },
                            },
                        ],
                    },
                ],
            });
        });
    });
});
