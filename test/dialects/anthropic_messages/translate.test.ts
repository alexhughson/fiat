import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    type Stage,
} from "../../../src/index";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "../../fixtures/request_stress";

describe("anthropic_messages translation", () => {
    test("an openai body becomes an anthropic body: system message moves to the system param", () => {
        const anthropicBody = AnthropicTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "claude-sonnet-4-6",
                max_tokens: 800,
                messages: [
                    { role: "system", content: "You are an omniscient AI" },
                    { role: "user", content: "Hello" },
                ],
            }),
        );

        expect(anthropicBody).toEqual({
            model: "claude-sonnet-4-6",
            max_tokens: 800,
            system: "You are an omniscient AI",
            messages: [
                { role: "user", content: [{ type: "text", text: "Hello" }] },
            ],
        });
    });

    test("tools translate: function parameters become input_schema, tool_calls become tool_use blocks", () => {
        const anthropicBody = AnthropicTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "claude-sonnet-4-6",
                max_tokens: 800,
                messages: [
                    { role: "user", content: "Check my invoices" },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: {
                                    name: "list_invoices",
                                    arguments: '{"customer_id":"c_9"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_1",
                        content: '["INV-7"]',
                    },
                ],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "list_invoices",
                            description: "List customer invoices.",
                            parameters: { type: "object" },
                        },
                    },
                ],
                tool_choice: "required",
            }),
        );

        expect(anthropicBody).toEqual({
            model: "claude-sonnet-4-6",
            max_tokens: 800,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "Check my invoices" }],
                },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "call_1",
                            name: "list_invoices",
                            input: { customer_id: "c_9" },
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "call_1",
                            content: '["INV-7"]',
                        },
                    ],
                },
            ],
            tools: [
                {
                    name: "list_invoices",
                    description: "List customer invoices.",
                    input_schema: { type: "object" },
                },
            ],
            tool_choice: { type: "any" },
        });
    });

    describe("mixed-vendor history request target", () => {
        test("lowers to Anthropic", () => {
            expect(AnthropicTranslator.toBody(mixedHistoryProgram)).toEqual({
                model: "gpt-4o-mini",
                max_tokens: 256,
                tool_choice: { type: "auto" },
                system: "use the invoice and policy tools, then answer tersely.",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "check invoice INV-7 and the refund policy for pro annual",
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "i am checking the invoice and the policy now.",
                            },
                            {
                                type: "tool_use",
                                id: "call_invoice",
                                name: "lookup_invoice",
                                input: { invoice_id: "INV-7" },
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_use",
                                id: "call_policy",
                                name: "lookup_policy",
                                input: { plan: "pro_annual" },
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call_invoice",
                                content: '{"status":"paid","refundable":true}',
                                cache_control: { type: "ephemeral" },
                            },
                            {
                                type: "tool_result",
                                tool_use_id: "call_policy",
                                content: '{"window_days":30}',
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "the invoice is paid and refundable within 30 days.",
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [{ type: "text", text: "answer in one line" }],
                    },
                ],
                tools: [
                    {
                        name: "lookup_invoice",
                        description: "Fetch invoice status by invoice id.",
                        input_schema: {
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
                        input_schema: {
                            type: "object",
                            properties: {
                                plan: { type: "string" },
                            },
                            required: ["plan"],
                        },
                    },
                ],
            });
        });
    });

    describe("refund workflow request target", () => {
        test("lowers to Anthropic", () => {
            expect(AnthropicTranslator.toBody(refundWorkflowProgram)).toEqual({
                model: "gpt-4o-mini",
                max_tokens: 512,
                tool_choice: { type: "auto" },
                system: "use the billing policy. after any tool use, answer in one sentence.",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "refund invoice inv_1001 if it was paid twice.",
                                cache_control: { type: "ephemeral" },
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "tool_use",
                                id: "call_lookup_1|item_lookup_1",
                                name: "lookup_invoice",
                                input: { invoice_id: "inv_1001" },
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call_lookup_1|item_lookup_1",
                                content:
                                    '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "invoice inv_1001 was paid twice. i will issue the refund.",
                            },
                            {
                                type: "tool_use",
                                id: "call_refund_1|item_refund_1",
                                name: "issue_refund",
                                input: {
                                    invoice_id: "inv_1001",
                                    amount_cents: 1250,
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call_refund_1|item_refund_1",
                                content:
                                    '{"refund_id":"rf_900","status":"submitted"}',
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "refund rf_900 is submitted.",
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "summarize the outcome in one sentence.",
                            },
                        ],
                    },
                ],
                tools: [
                    {
                        name: "lookup_invoice",
                        description: "fetch invoice state",
                        input_schema: {
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
                        input_schema: {
                            type: "object",
                            properties: {
                                invoice_id: { type: "string" },
                                amount_cents: { type: "number" },
                            },
                            required: ["invoice_id", "amount_cents"],
                        },
                    },
                ],
            });
        });
    });

    describe("gemini-shaped planner request target", () => {
        test("lowers to Anthropic", () => {
            expect(AnthropicTranslator.toBody(geminiPlannerProgram)).toEqual({
                model: "models/gemini-3.5-flash",
                max_tokens: 384,
                system: "plan carefully, keep tool context, and answer briefly.",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "find the paris office and then check its weather",
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "i am resolving the office first.",
                            },
                            {
                                type: "tool_use",
                                id: "call_office",
                                name: "lookup_office",
                                input: { city: "Paris" },
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call_office",
                                content: '{"office":"Paris HQ"}',
                                cache_control: { type: "ephemeral" },
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "office found. now checking the weather.",
                            },
                            {
                                type: "tool_use",
                                id: "call_weather",
                                name: "get_weather",
                                input: { office: "Paris HQ" },
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "call_weather",
                                content: '{"temp_c":21,"condition":"sunny"}',
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "text",
                                text: "paris hq is sunny and 21c.",
                            },
                        ],
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: "reply in one sentence",
                            },
                        ],
                    },
                ],
                tools: [
                    {
                        name: "lookup_office",
                        description: "Resolve an office name from a city.",
                        input_schema: {
                            type: "object",
                            properties: { city: { type: "string" } },
                            required: ["city"],
                        },
                    },
                    {
                        name: "get_weather",
                        description: "Fetch the weather for an office.",
                        input_schema: {
                            type: "object",
                            properties: { office: { type: "string" } },
                            required: ["office"],
                        },
                    },
                ],
            });
        });
    });

    test("an anthropic text delta translates through the generic stream op pipeline", () => {
        const seen: unknown[] = [];
        const event = {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
        };

        const observe: Stage = (program) => {
            seen.push(...program);
            return program;
        };
        let core = AnthropicTranslator.fromStreamResponse(event);
        core = observe(core);
        const translated = AnthropicTranslator.toStreamResponse(core);

        expect(seen).toEqual([
            { op: "response.text_delta", index: 0, content: "hi" },
        ]);
        expect(translated).toEqual(event);
    });
});
