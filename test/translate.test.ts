// Executable documentation for the cross-dialect pipeline: requests and
// responses translating between providers, core-IR passes, residual
// semantics, and response-onto-request chaining.

import { describe, expect, test } from "bun:test";
import {
    append,
    LintError,
    opsOf,
    translateRequest,
    translateResponse,
    translateStreamResponse,
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    type Pass,
} from "../src/index";
import { claudeCodeAnthropicRequest } from "./fixtures/claude_code_anthropic";

describe("request translation", () => {
    test("an openai body becomes an anthropic body: system message moves to the system param", () => {
        const anthropicBody = translateRequest(
            {
                model: "claude-sonnet-4-6",
                max_tokens: 800,
                messages: [
                    { role: "system", content: "You are an omniscient AI" },
                    { role: "user", content: "Hello" },
                ],
            },
            { from: OpenAIChatTranslator, to: AnthropicTranslator },
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
        const anthropicBody = translateRequest(
            {
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
            },
            { from: OpenAIChatTranslator, to: AnthropicTranslator },
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

    test("core-IR passes run between raise and lower — e.g. rerouting the model", () => {
        const rerouteToHaiku: Pass = {
            name: "reroute-to-haiku",
            run: (program) =>
                program.map((op) =>
                    op.op === "llm.model"
                        ? { op: "llm.model", model: "claude-haiku-4-5" }
                        : op,
                ),
        };

        const body = translateRequest(
            {
                model: "gpt-4o",
                max_tokens: 100,
                messages: [{ role: "user", content: "hi" }],
            },
            {
                from: OpenAIChatTranslator,
                to: AnthropicTranslator,
                passes: [rerouteToHaiku],
            },
        ) as { model: string };

        expect(body.model).toBe("claude-haiku-4-5");
    });

    test("an openai chat request can lower to the responses input shape", () => {
        const body = translateRequest(
            {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "hi" }],
            },
            { from: OpenAIChatTranslator, to: OpenAIResponsesTranslator },
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
        const body = translateRequest(
            {
                model: "gpt-realtime",
                messages: [
                    { role: "system", content: "Reply tersely." },
                    { role: "user", content: "hi" },
                ],
                max_tokens: 80,
            },
            { from: OpenAIChatTranslator, to: OpenAIRealtimeTranslator },
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
        const body = translateRequest(
            {
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
            },
            { from: OpenAIRealtimeTranslator, to: OpenAIChatTranslator },
        );

        expect(body).toEqual({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("openai responses function tool extras halt when translated cross-provider", () => {
        expect(() =>
            translateRequest(
                {
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
                },
                { from: OpenAIResponsesTranslator, to: OpenAIChatTranslator },
            ),
        ).toThrow(LintError);
    });

    test("portable server tools translate from Anthropic to OpenAI Responses by name", () => {
        const body = translateRequest(
            {
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
            },
            { from: AnthropicTranslator, to: OpenAIResponsesTranslator },
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
        const body = translateRequest(
            {
                model: "models/gemini-3.5-flash",
                max_tokens: 80,
                temperature: 0.2,
                messages: [
                    { role: "system", content: "Reply tersely." },
                    { role: "user", content: "hi" },
                ],
            },
            { from: OpenAIChatTranslator, to: GeminiTranslator },
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

        const body = translateRequest(claudeCodeAnthropicRequest, {
            from: AnthropicTranslator,
            to: OpenAIChatTranslator,
        });

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
        const routeToGPT55: Pass = {
            name: "route-to-gpt-5.5",
            run: (program) =>
                program.map((op) =>
                    op.op === "llm.model" ? { ...op, model: "gpt-5.5" } : op,
                ),
        };

        const body = translateRequest(claudeCodeAnthropicRequest, {
            from: AnthropicTranslator,
            to: OpenAIChatTranslator,
            passes: [routeToGPT55],
        }) as Record<string, unknown>;

        expect(body.model).toBe("gpt-5.5");
        expect(body.max_completion_tokens).toBe(64000);
        expect(body.max_tokens).toBeUndefined();
        expect(body.tools).toBeDefined();
        expect(body.reasoning_effort).toBeUndefined();
    });

    test("unsupported Anthropic thinking still fails when targeting OpenAI Chat", () => {
        expect(() =>
            translateRequest(
                {
                    ...claudeCodeAnthropicRequest,
                    thinking: { type: "adaptive", display: "summarized" },
                },
                { from: AnthropicTranslator, to: OpenAIChatTranslator },
            ),
        ).toThrow(LintError);
    });

    test("unknown Anthropic context_management edits still fail when targeting OpenAI Chat", () => {
        expect(() =>
            translateRequest(
                {
                    ...claudeCodeAnthropicRequest,
                    context_management: {
                        edits: [
                            {
                                type: "clear_thinking_20251015",
                                keep: "last",
                            },
                        ],
                    },
                },
                { from: AnthropicTranslator, to: OpenAIChatTranslator },
            ),
        ).toThrow(LintError);
    });

    test("unsupported Anthropic effort values still fail when targeting OpenAI Chat", () => {
        expect(() =>
            translateRequest(
                {
                    ...claudeCodeAnthropicRequest,
                    output_config: {
                        ...claudeCodeAnthropicRequest.output_config,
                        effort: "max",
                    },
                },
                { from: AnthropicTranslator, to: OpenAIChatTranslator },
            ),
        ).toThrow(LintError);

        expect(() =>
            translateRequest(
                {
                    ...claudeCodeAnthropicRequest,
                    output_config: {
                        ...claudeCodeAnthropicRequest.output_config,
                        effort: 123,
                    },
                },
                { from: AnthropicTranslator, to: OpenAIChatTranslator },
            ),
        ).toThrow("output_config.effort");
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
            translateRequest(bodyWithResidual(undefined), {
                from: OpenAIChatTranslator,
                to: AnthropicTranslator,
            }),
        ).toThrow(LintError);
    });

    test("a pass can mark a residual droppable, and then it is silently dropped by design", () => {
        const allowDroppingLogitBias: Pass = {
            name: "allow-dropping-logit-bias",
            run: (program) =>
                program.map((op) =>
                    op.op === "openai_chat.body_field" &&
                    (op as { key?: string }).key === "logit_bias"
                        ? { ...op, required: false }
                        : op,
                ),
        };

        const body = translateRequest(bodyWithResidual(undefined), {
            from: OpenAIChatTranslator,
            to: AnthropicTranslator,
            passes: [allowDroppingLogitBias],
        }) as Record<string, unknown>;

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
        const roundTripped = translateRequest(original, {
            from: OpenAIChatTranslator,
            to: OpenAIChatTranslator,
        });
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
        const openaiResponse = translateResponse(anthropicResponse, {
            from: AnthropicTranslator,
            to: OpenAIChatTranslator,
        }) as Record<string, unknown>;

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
        const openaiChatResponse = translateResponse(
            {
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
            },
            { from: OpenAIResponsesTranslator, to: OpenAIChatTranslator },
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
        const openaiChatResponse = translateResponse(
            {
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
            },
            { from: OpenAIRealtimeTranslator, to: OpenAIChatTranslator },
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
        const openaiChatResponse = translateResponse(
            {
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
            },
            { from: OpenAIRealtimeTranslator, to: OpenAIChatTranslator },
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
        const realtimeResponse = translateResponse(
            {
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
            },
            { from: OpenAIChatTranslator, to: OpenAIRealtimeTranslator },
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
        const openaiChatResponse = translateResponse(
            {
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
            },
            { from: OpenAIResponsesTranslator, to: OpenAIChatTranslator },
        ) as { choices: { finish_reason: string | null }[] };

        expect(openaiChatResponse.choices[0]!.finish_reason).toBe(
            "content_filter",
        );
    });

    test("pause_turn does not become max_output_tokens when targeting openai responses", () => {
        expect(() =>
            translateResponse(
                {
                    id: "msg_pause",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-4-6",
                    content: [{ type: "text", text: "still working" }],
                    stop_reason: "pause_turn",
                    usage: { input_tokens: 1, output_tokens: 2 },
                },
                { from: AnthropicTranslator, to: OpenAIResponsesTranslator },
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
        const response = translateResponse(
            {
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
            },
            { from: OpenAIChatTranslator, to: OpenAIResponsesTranslator },
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

        const translated = translateStreamResponse(event, {
            from: AnthropicTranslator,
            to: AnthropicTranslator,
            passes: [
                {
                    name: "capture-stream-op",
                    run: (program) => {
                        seen.push(...program);
                        return program;
                    },
                },
            ],
        });

        expect(seen).toEqual([
            { op: "response.text_delta", index: 0, content: "hi" },
        ]);
        expect(translated).toEqual(event);
    });
});
