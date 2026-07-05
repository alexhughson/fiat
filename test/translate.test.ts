// Executable documentation for the cross-dialect pipeline: requests and
// responses translating between providers, core-IR transforms, residual
// semantics, and response-onto-request chaining.

import { describe, expect, test } from "bun:test";
import {
    append,
    firstOp,
    LintError,
    opsOf,
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    type Program,
    type Stage,
} from "../src/index";
import { claudeCodeAnthropicRequest } from "./fixtures/claude_code_anthropic";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "./fixtures/request_stress";

function requestBodies(program: Program) {
    return {
        openai_chat: OpenAIChatTranslator.toBody(program),
        openai_responses: OpenAIResponsesTranslator.toBody(program),
        openai_realtime: OpenAIRealtimeTranslator.toBody(program),
        anthropic: AnthropicTranslator.toBody(program),
        gemini: GeminiTranslator.toBody(program),
    };
}

describe("request translation", () => {
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

    test("realtime response.input placement marker does not block representable request translation", () => {
        const body = OpenAIChatTranslator.toBody(
            OpenAIRealtimeTranslator.fromBody({
                model: "gpt-4o-mini",
                events: [
                    {
                        type: "response.create",
                        response: {
                            input: [
                                {
                                    type: "message",
                                    role: "user",
                                    content: [
                                        { type: "input_text", text: "hi" },
                                    ],
                                },
                            ],
                            output_modalities: ["text"],
                        },
                    },
                ],
            }),
        );

        expect(body).toEqual({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("openai responses function tool extras halt when translated cross-provider", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                OpenAIResponsesTranslator.fromBody({
                    model: "gpt-4o-mini",
                    input: "hi",
                    tools: [
                        {
                            type: "function",
                            name: "fn",
                            parameters: {},
                            strict: true,
                        },
                    ],
                }),
            ),
        ).toThrow(LintError);
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

    test("a real-shaped Claude Code Anthropic request lowers to OpenAI Chat through the library", () => {
        const core = AnthropicTranslator.fromBody(claudeCodeAnthropicRequest);
        expect(core).toContainEqual({
            op: "request.user",
            value: claudeCodeAnthropicRequest.metadata.user_id,
        });
        expect(core).toContainEqual({ op: "request.stream", value: true });
        expect(core).toContainEqual({
            op: "request.stop_sequences",
            value: ["</stop>"],
        });
        expect(core).toContainEqual({ op: "llm.thinking", effort: "medium" });
        expect(core).toContainEqual({
            op: "llm.output",
            format: "json_schema",
            name: "anthropic_output",
            schema: claudeCodeAnthropicRequest.output_config.format.schema,
        });

        const body = OpenAIChatTranslator.toBody(
            AnthropicTranslator.fromBody(claudeCodeAnthropicRequest),
        );

        expect(body).toEqual({
            model: "claude-sonnet-5",
            max_tokens: 64000,
            user: claudeCodeAnthropicRequest.metadata.user_id,
            reasoning_effort: "medium",
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "anthropic_output",
                    schema: claudeCodeAnthropicRequest.output_config.format
                        .schema,
                },
            },
            stop: ["</stop>"],
            stream: true,
            messages: [
                {
                    role: "system",
                    content:
                        "x-anthropic-billing-header: cc_version=2.1.200.c39; cc_entrypoint=sdk-cli;",
                },
                {
                    role: "system",
                    content:
                        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
                },
                {
                    role: "user",
                    content:
                        "<system-reminder>\nToday's date is 2026-07-03.\n</system-reminder>\n\n",
                },
                {
                    role: "user",
                    content:
                        "using no tools, reply with exactly: claude-proxy-ok",
                },
            ],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "Read a file.",
                        parameters:
                            claudeCodeAnthropicRequest.tools[0].input_schema,
                    },
                },
            ],
        });
    });

    test("a routed Claude Code request omits gpt-5.5 chat reasoning_effort when tools are present", () => {
        const routeToGPT55: Stage = (program) =>
            program.map((op) =>
                op.op === "llm.model" ? { ...op, model: "gpt-5.5" } : op,
            );

        let core = AnthropicTranslator.fromBody(claudeCodeAnthropicRequest);
        core = routeToGPT55(core);
        const body = OpenAIChatTranslator.toBody(core) as Record<
            string,
            unknown
        >;

        expect(body.model).toBe("gpt-5.5");
        expect(body.max_completion_tokens).toBe(64000);
        expect(body.max_tokens).toBeUndefined();
        expect(body.tools).toBeDefined();
        expect(body.reasoning_effort).toBeUndefined();
    });

    test("unsupported Anthropic thinking still fails when targeting OpenAI Chat", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                AnthropicTranslator.fromBody({
                    ...claudeCodeAnthropicRequest,
                    thinking: { type: "adaptive", display: "summarized" },
                }),
            ),
        ).toThrow(LintError);
    });

    test("unknown Anthropic context_management edits still fail when targeting OpenAI Chat", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                AnthropicTranslator.fromBody({
                    ...claudeCodeAnthropicRequest,
                    context_management: {
                        edits: [
                            {
                                type: "clear_thinking_20251015",
                                keep: "last",
                            },
                        ],
                    },
                }),
            ),
        ).toThrow(LintError);
    });

    test("unsupported Anthropic effort values still fail when targeting OpenAI Chat", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                AnthropicTranslator.fromBody({
                    ...claudeCodeAnthropicRequest,
                    output_config: {
                        ...claudeCodeAnthropicRequest.output_config,
                        effort: "max",
                    },
                }),
            ),
        ).toThrow(LintError);

        expect(() =>
            OpenAIChatTranslator.toBody(
                AnthropicTranslator.fromBody({
                    ...claudeCodeAnthropicRequest,
                    output_config: {
                        ...claudeCodeAnthropicRequest.output_config,
                        effort: 123,
                    },
                }),
            ),
        ).toThrow("output_config.effort");
    });

    test("a mixed-vendor history lowers to the expected shape in every request target", () => {
        expect(requestBodies(mixedHistoryProgram)).toEqual({
            openai_chat: {
                model: "gpt-4o-mini",
                max_tokens: 256,
                tool_choice: "auto",
                messages: [
                    {
                        role: "developer",
                        content:
                            "use the invoice and policy tools, then answer tersely.",
                    },
                    {
                        role: "user",
                        content:
                            "check invoice INV-7 and the refund policy for pro annual",
                    },
                    {
                        role: "assistant",
                        content: "i am checking the invoice and the policy now.",
                        tool_calls: [
                            {
                                id: "call_invoice",
                                type: "function",
                                function: {
                                    name: "lookup_invoice",
                                    arguments: '{"invoice_id":"INV-7"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_policy",
                                type: "function",
                                function: {
                                    name: "lookup_policy",
                                    arguments: '{"plan":"pro_annual"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_invoice",
                        content: '{"status":"paid","refundable":true}',
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_policy",
                        content: '{"window_days":30}',
                    },
                    {
                        role: "assistant",
                        content:
                            "the invoice is paid and refundable within 30 days.",
                    },
                    { role: "user", content: "answer in one line" },
                ],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "lookup_invoice",
                            description: "Fetch invoice status by invoice id.",
                            parameters: {
                                type: "object",
                                properties: {
                                    invoice_id: { type: "string" },
                                },
                                required: ["invoice_id"],
                            },
                        },
                    },
                    {
                        type: "function",
                        function: {
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
                    },
                ],
            },
            openai_responses: {
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
            },
            openai_realtime: {
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
                                    description:
                                        "Fetch refund policy by plan.",
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
                                    output:
                                        '{"status":"paid","refundable":true}',
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
            },
            anthropic: {
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
                        content: [
                            { type: "text", text: "answer in one line" },
                        ],
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
            },
            gemini: {
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
            },
        });
    });

    test("a refund workflow with composite call ids lowers to the expected shape in every request target", () => {
        expect(requestBodies(refundWorkflowProgram)).toEqual({
            openai_chat: {
                model: "gpt-4o-mini",
                max_tokens: 512,
                tool_choice: "auto",
                messages: [
                    {
                        role: "developer",
                        content:
                            "use the billing policy. after any tool use, answer in one sentence.",
                    },
                    {
                        role: "user",
                        content:
                            "refund invoice inv_1001 if it was paid twice.",
                    },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_lookup_1",
                                type: "function",
                                function: {
                                    name: "lookup_invoice",
                                    arguments:
                                        '{"invoice_id":"inv_1001"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_lookup_1",
                        content:
                            '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
                    },
                    {
                        role: "assistant",
                        content:
                            "invoice inv_1001 was paid twice. i will issue the refund.",
                        tool_calls: [
                            {
                                id: "call_refund_1",
                                type: "function",
                                function: {
                                    name: "issue_refund",
                                    arguments:
                                        '{"invoice_id":"inv_1001","amount_cents":1250}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_refund_1",
                        content: '{"refund_id":"rf_900","status":"submitted"}',
                    },
                    {
                        role: "assistant",
                        content: "refund rf_900 is submitted.",
                    },
                    {
                        role: "user",
                        content:
                            "summarize the outcome in one sentence.",
                    },
                ],
                tools: [
                    {
                        type: "function",
                        function: {
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
                    },
                    {
                        type: "function",
                        function: {
                            name: "issue_refund",
                            description: "submit a refund",
                            parameters: {
                                type: "object",
                                properties: {
                                    invoice_id: { type: "string" },
                                    amount_cents: { type: "number" },
                                },
                                required: [
                                    "invoice_id",
                                    "amount_cents",
                                ],
                            },
                        },
                    },
                ],
            },
            openai_responses: {
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
                        output:
                            '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
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
            },
            openai_realtime: {
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
                            output:
                                '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
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
            },
            anthropic: {
                model: "gpt-4o-mini",
                max_tokens: 512,
                tool_choice: { type: "auto" },
                system:
                    "use the billing policy. after any tool use, answer in one sentence.",
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
            },
            gemini: {
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
                        parts: [
                            { text: "refund rf_900 is submitted." },
                        ],
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
                                    required: [
                                        "invoice_id",
                                        "amount_cents",
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
        });
    });

    test("a gemini-shaped planner transcript lowers to the expected shape in every request target", () => {
        expect(requestBodies(geminiPlannerProgram)).toEqual({
            openai_chat: {
                model: "models/gemini-3.5-flash",
                max_tokens: 384,
                messages: [
                    {
                        role: "system",
                        content:
                            "plan carefully, keep tool context, and answer briefly.",
                    },
                    {
                        role: "user",
                        content:
                            "find the paris office and then check its weather",
                    },
                    {
                        role: "assistant",
                        content: "i am resolving the office first.",
                        tool_calls: [
                            {
                                id: "call_office",
                                type: "function",
                                function: {
                                    name: "lookup_office",
                                    arguments: '{"city":"Paris"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_office",
                        content: '{"office":"Paris HQ"}',
                    },
                    {
                        role: "assistant",
                        content:
                            "office found. now checking the weather.",
                        tool_calls: [
                            {
                                id: "call_weather",
                                type: "function",
                                function: {
                                    name: "get_weather",
                                    arguments: '{"office":"Paris HQ"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_weather",
                        content: '{"temp_c":21,"condition":"sunny"}',
                    },
                    {
                        role: "assistant",
                        content: "paris hq is sunny and 21c.",
                    },
                    { role: "user", content: "reply in one sentence" },
                ],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "lookup_office",
                            description: "Resolve an office name from a city.",
                            parameters: {
                                type: "object",
                                properties: { city: { type: "string" } },
                                required: ["city"],
                            },
                        },
                    },
                    {
                        type: "function",
                        function: {
                            name: "get_weather",
                            description: "Fetch the weather for an office.",
                            parameters: {
                                type: "object",
                                properties: { office: { type: "string" } },
                                required: ["office"],
                            },
                        },
                    },
                ],
            },
            openai_responses: {
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
            },
            openai_realtime: {
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
            },
            anthropic: {
                model: "models/gemini-3.5-flash",
                max_tokens: 384,
                system:
                    "plan carefully, keep tool context, and answer briefly.",
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
            },
            gemini: {
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
                        parts: [
                            { text: "paris hq is sunny and 21c." },
                        ],
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
                    },
                ],
            },
        });
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

    test("an endpoint-only param that nothing consumed halts the translation", () => {
        expect(() =>
            AnthropicTranslator.toBody(
                OpenAIChatTranslator.fromBody(bodyWithResidual(undefined)),
            ),
        ).toThrow(LintError);
    });

    test("a transform can mark a residual droppable, and then it is silently dropped by design", () => {
        const allowDroppingLogitBias: Stage = (program) =>
            program.map((op) =>
                op.op === "openai_chat.body_field" &&
                (op as { key?: string }).key === "logit_bias"
                    ? { ...op, required: false }
                    : op,
            );

        let core = OpenAIChatTranslator.fromBody(bodyWithResidual(undefined));
        core = allowDroppingLogitBias(core);
        const body = AnthropicTranslator.toBody(core) as Record<
            string,
            unknown
        >;

        expect(body.logit_bias).toBeUndefined();
        expect(body.messages).toEqual([
            { role: "user", content: [{ type: "text", text: "hi" }] },
        ]);
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

describe("response translation and chaining", () => {
    const anthropicResponse = {
        id: "msg_01ABC",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "It is correct." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 9 },
    };

    test("an anthropic response becomes an openai response — the proxy use case", () => {
        const openaiResponse = OpenAIChatTranslator.toResponse(
            AnthropicTranslator.fromResponse(anthropicResponse),
        ) as Record<string, unknown>;

        expect(openaiResponse.model).toBe("claude-sonnet-4-6");
        expect(openaiResponse.choices).toEqual([
            {
                index: 0,
                message: { role: "assistant", content: "It is correct." },
                finish_reason: "stop",
                logprobs: null,
            },
        ]);
        expect(openaiResponse.usage).toEqual({
            prompt_tokens: 20,
            completion_tokens: 9,
        });
        // Protocol boilerplate is synthesized when the source has none to map.
        expect(openaiResponse.object).toBe("chat.completion");
    });

    test("a responses tool call can become an openai chat response", () => {
        const openaiChatResponse = OpenAIChatTranslator.toResponse(
            OpenAIResponsesTranslator.fromResponse({
                id: "resp_123",
                object: "response",
                created_at: 1783049000,
                status: "completed",
                model: "gpt-4o-mini",
                output: [
                    {
                        id: "fc_123",
                        type: "function_call",
                        status: "completed",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                ],
                usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
                incomplete_details: null,
            }),
        ) as Record<string, unknown>;

        expect(
            (
                openaiChatResponse.choices as {
                    message: unknown;
                    finish_reason: string;
                }[]
            )[0],
        ).toMatchObject({
            message: {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "get_weather",
                            arguments: '{"city":"Paris"}',
                        },
                    },
                ],
            },
            finish_reason: "tool_calls",
        });
    });

    test("a realtime response.done text event can become an openai chat response", () => {
        const openaiChatResponse = OpenAIChatTranslator.toResponse(
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
                            usage: { input_tokens: 12, output_tokens: 2 },
                        },
                    },
                ],
            }),
        ) as Record<string, unknown>;

        expect(openaiChatResponse.model).toBe("gpt-realtime");
        expect(
            (
                openaiChatResponse.choices as {
                    message: unknown;
                    finish_reason: string;
                }[]
            )[0],
        ).toMatchObject({
            message: { role: "assistant", content: "pong" },
            finish_reason: "stop",
        });
        expect(openaiChatResponse.usage).toEqual({
            prompt_tokens: 12,
            completion_tokens: 2,
        });
    });

    test("realtime response output metadata does not block chat translation", () => {
        const openaiChatResponse = OpenAIChatTranslator.toResponse(
            OpenAIRealtimeTranslator.fromResponse({
                events: [
                    {
                        type: "response.done",
                        response: {
                            status: "completed",
                            model: "gpt-realtime-2",
                            output: [
                                {
                                    id: "item_1",
                                    type: "message",
                                    role: "assistant",
                                    status: "completed",
                                    phase: "final_answer",
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

        expect(openaiChatResponse.choices[0]!.message.content).toBe("pong");
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

    test("a responses content_filter incomplete response becomes an openai chat content_filter response", () => {
        const openaiChatResponse = OpenAIChatTranslator.toResponse(
            OpenAIResponsesTranslator.fromResponse({
                id: "resp_filtered",
                object: "response",
                created_at: 1783049003,
                status: "incomplete",
                model: "gpt-4o-mini",
                output: [
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "" }],
                    },
                ],
                incomplete_details: { reason: "content_filter" },
            }),
        ) as { choices: { finish_reason: string | null }[] };

        expect(openaiChatResponse.choices[0]!.finish_reason).toBe(
            "content_filter",
        );
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

    test("appending a response program to a request program makes the next request", () => {
        const request = OpenAIChatTranslator.fromBody({
            model: "gpt-4o",
            messages: [{ role: "user", content: "Was I double charged?" }],
        });
        const response = OpenAIChatTranslator.fromResponse({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1700000000,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "No, it is correct.",
                    },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 12,
                completion_tokens: 6,
                total_tokens: 18,
            },
        });

        const nextTurn = append(append(request, ...response), {
            op: "llm.text",
            role: "user",
            content: "Are you sure?",
        });

        // response.* and residual bookkeeping ops don't get re-sent; the
        // assistant turn does.
        expect(OpenAIChatTranslator.toBody(nextTurn)).toEqual({
            model: "gpt-4o",
            messages: [
                { role: "user", content: "Was I double charged?" },
                { role: "assistant", content: "No, it is correct." },
                { role: "user", content: "Are you sure?" },
            ],
        });

        expect(opsOf(nextTurn, "response.usage")).toHaveLength(1);
    });

    test("appending a refusal-only openai chat response keeps the assistant turn", () => {
        const request = OpenAIChatTranslator.fromBody({
            model: "gpt-4o",
            messages: [{ role: "user", content: "Can you do that?" }],
        });
        const response = OpenAIChatTranslator.fromResponse({
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
        });

        expect(
            OpenAIChatTranslator.toBody(append(request, ...response)),
        ).toEqual({
            model: "gpt-4o",
            messages: [
                { role: "user", content: "Can you do that?" },
                { role: "assistant", content: "cannot do that" },
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

describe("response stream translation", () => {
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
