import { describe, expect, test } from "bun:test";
import {
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
} from "../../../src/index";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "../../fixtures/request_stress";

describe("openai_realtime translation", () => {
    test("an openai chat request can lower to a realtime request body", () => {
        const body = OpenAIRealtimeTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "gpt-realtime",
                messages: [
                    { role: "system", content: "Reply tersely." },
                    { role: "user", content: "hi" },
                ],
                max_tokens: 80,
            }),
        );

        expect(body).toEqual({
            model: "gpt-realtime",
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "hi" }],
                    },
                },
                {
                    type: "response.create",
                    response: {
                        instructions: "Reply tersely.",
                        max_output_tokens: 80,
                        output_modalities: ["text"],
                    },
                },
            ],
        });
    });

    describe("mixed-vendor history request target", () => {
        test("lowers to OpenAI Realtime", () => {
            expect(
                OpenAIRealtimeTranslator.toBody(mixedHistoryProgram),
            ).toEqual({
                model: "gpt-4o-mini",
                events: [
                    {
                        type: "response.create",
                        response: {
                            max_output_tokens: 256,
                            tool_choice: "auto",
                            instructions:
                                "use the invoice and policy tools, then answer tersely.",
                            tools: [
                                {
                                    type: "function",
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
                                            type: "output_text",
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
                                            type: "output_text",
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
                            output_modalities: ["text"],
                        },
                    },
                ],
            });
        });
    });

    describe("refund workflow request target", () => {
        test("lowers to OpenAI Realtime", () => {
            expect(
                OpenAIRealtimeTranslator.toBody(refundWorkflowProgram),
            ).toEqual({
                model: "gpt-4o-mini",
                events: [
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [
                                {
                                    type: "input_text",
                                    text: "refund invoice inv_1001 if it was paid twice.",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call",
                            call_id: "call_lookup_1|item_lookup_1",
                            name: "lookup_invoice",
                            arguments: '{"invoice_id":"inv_1001"}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: "call_lookup_1|item_lookup_1",
                            output: '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "invoice inv_1001 was paid twice. i will issue the refund.",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call",
                            call_id: "call_refund_1|item_refund_1",
                            name: "issue_refund",
                            arguments:
                                '{"invoice_id":"inv_1001","amount_cents":1250}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: "call_refund_1|item_refund_1",
                            output: '{"refund_id":"rf_900","status":"submitted"}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "refund rf_900 is submitted.",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [
                                {
                                    type: "input_text",
                                    text: "summarize the outcome in one sentence.",
                                },
                            ],
                        },
                    },
                    {
                        type: "response.create",
                        response: {
                            max_output_tokens: 512,
                            tool_choice: "auto",
                            instructions:
                                "use the billing policy. after any tool use, answer in one sentence.",
                            tools: [
                                {
                                    type: "function",
                                    name: "lookup_invoice",
                                    description: "fetch invoice state",
                                    parameters: {
                                        type: "object",
                                        properties: {
                                            invoice_id: {
                                                type: "string",
                                            },
                                        },
                                        required: ["invoice_id"],
                                    },
                                },
                                {
                                    type: "function",
                                    name: "issue_refund",
                                    description: "submit a refund",
                                    parameters: {
                                        type: "object",
                                        properties: {
                                            invoice_id: {
                                                type: "string",
                                            },
                                            amount_cents: {
                                                type: "number",
                                            },
                                        },
                                        required: [
                                            "invoice_id",
                                            "amount_cents",
                                        ],
                                    },
                                },
                            ],
                            output_modalities: ["text"],
                        },
                    },
                ],
            });
        });
    });

    describe("gemini-shaped planner request target", () => {
        test("lowers to OpenAI Realtime", () => {
            expect(
                OpenAIRealtimeTranslator.toBody(geminiPlannerProgram),
            ).toEqual({
                model: "models/gemini-3.5-flash",
                events: [
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [
                                {
                                    type: "input_text",
                                    text: "find the paris office and then check its weather",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "i am resolving the office first.",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call",
                            call_id: "call_office",
                            name: "lookup_office",
                            arguments: '{"city":"Paris"}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: "call_office",
                            output: '{"office":"Paris HQ"}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "office found. now checking the weather.",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call",
                            call_id: "call_weather",
                            name: "get_weather",
                            arguments: '{"office":"Paris HQ"}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: "call_weather",
                            output: '{"temp_c":21,"condition":"sunny"}',
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "paris hq is sunny and 21c.",
                                },
                            ],
                        },
                    },
                    {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [
                                {
                                    type: "input_text",
                                    text: "reply in one sentence",
                                },
                            ],
                        },
                    },
                    {
                        type: "response.create",
                        response: {
                            max_output_tokens: 384,
                            instructions:
                                "plan carefully, keep tool context, and answer briefly.",
                            tools: [
                                {
                                    type: "function",
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
                                    type: "function",
                                    name: "get_weather",
                                    description:
                                        "Fetch the weather for an office.",
                                    parameters: {
                                        type: "object",
                                        properties: {
                                            office: { type: "string" },
                                        },
                                        required: ["office"],
                                    },
                                },
                            ],
                            output_modalities: ["text"],
                        },
                    },
                ],
            });
        });
    });

    test("explicit translator chain can proxy openai chat over realtime", () => {
        const realtimeRequest = OpenAIRealtimeTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "gpt-realtime",
                messages: [
                    { role: "system", content: "Reply tersely." },
                    { role: "user", content: "ping" },
                ],
            }),
        );

        expect(realtimeRequest).toEqual({
            model: "gpt-realtime",
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "ping" }],
                    },
                },
                {
                    type: "response.create",
                    response: {
                        instructions: "Reply tersely.",
                        output_modalities: ["text"],
                    },
                },
            ],
        });

        const chatResponse = OpenAIChatTranslator.toResponse(
            OpenAIRealtimeTranslator.fromResponse({
                events: [
                    {
                        type: "response.done",
                        response: {
                            status: "completed",
                            model: "gpt-realtime",
                            output: [
                                {
                                    type: "message",
                                    role: "assistant",
                                    status: "completed",
                                    content: [
                                        { type: "output_text", text: "pong" },
                                    ],
                                },
                            ],
                        },
                    },
                ],
            }),
        ) as { choices: { message: { content: string } }[] };

        expect(chatResponse.choices[0]!.message.content).toBe("pong");
    });

    test("an openai chat response can back a realtime response.done event", () => {
        const realtimeResponse = OpenAIRealtimeTranslator.toResponse(
            OpenAIChatTranslator.fromResponse({
                id: "chatcmpl_1",
                object: "chat.completion",
                created: 1783049000,
                model: "gpt-4o-mini",
                choices: [
                    {
                        index: 0,
                        message: { role: "assistant", content: "pong" },
                        finish_reason: "stop",
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 2 },
            }),
        ) as { events: { response: Record<string, unknown> }[] };

        expect(realtimeResponse.events[0]!.response).toMatchObject({
            object: "realtime.response",
            model: "gpt-4o-mini",
            status: "completed",
            status_details: null,
            output: [
                {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "pong" }],
                },
            ],
            usage: { input_tokens: 10, output_tokens: 2 },
        });
    });
});
