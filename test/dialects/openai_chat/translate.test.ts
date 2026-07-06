import { describe, expect, spyOn, test } from "bun:test";
import {
    append,
    opsOf,
    AnthropicTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    type Stage,
} from "../../../src/index";
import { claudeCodeAnthropicRequest } from "../../fixtures/claude_code_anthropic";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "../../fixtures/request_stress";

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

const anthropicResponse = {
    id: "msg_01ABC",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "It is correct." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 9 },
};

describe("openai_chat translation", () => {
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

    test("openai responses function tool extras warn and drop when translated cross-provider", () => {
        withWarnSpy((warn) => {
            const body = OpenAIChatTranslator.toBody(
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
            ) as Record<string, unknown>;

            expect(body.tools).toEqual([
                {
                    type: "function",
                    function: { name: "fn", parameters: {} },
                },
            ]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "openai_responses.tool_meta"',
                ),
            );
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

    test("unsupported Anthropic thinking warns and drops when targeting OpenAI Chat", () => {
        withWarnSpy((warn) => {
            const body = OpenAIChatTranslator.toBody(
                AnthropicTranslator.fromBody({
                    ...claudeCodeAnthropicRequest,
                    thinking: { type: "adaptive", display: "summarized" },
                }),
            ) as Record<string, unknown>;

            expect(body.messages).toBeDefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "anthropic_messages.thinking_config"',
                ),
            );
        });
    });

    test("unknown Anthropic context_management edits warn and drop when targeting OpenAI Chat", () => {
        withWarnSpy((warn) => {
            const body = OpenAIChatTranslator.toBody(
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
            ) as Record<string, unknown>;

            expect(body.messages).toBeDefined();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "anthropic_messages.context_management"',
                ),
            );
        });
    });

    test("unsupported core thinking effort values still fail when targeting OpenAI Chat", () => {
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
        ).toThrow(
            'reasoning_effort does not support llm.thinking effort "max"',
        );

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

    describe("mixed-vendor history request target", () => {
        test("lowers to OpenAI Chat", () => {
            expect(OpenAIChatTranslator.toBody(mixedHistoryProgram)).toEqual({
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
                        content:
                            "i am checking the invoice and the policy now.",
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
            });
        });
    });

    describe("refund workflow request target", () => {
        test("lowers to OpenAI Chat", () => {
            expect(OpenAIChatTranslator.toBody(refundWorkflowProgram)).toEqual({
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
                                    arguments: '{"invoice_id":"inv_1001"}',
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
                        content: "summarize the outcome in one sentence.",
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
                                required: ["invoice_id", "amount_cents"],
                            },
                        },
                    },
                ],
            });
        });
    });

    describe("gemini-shaped planner request target", () => {
        test("lowers to OpenAI Chat", () => {
            expect(OpenAIChatTranslator.toBody(geminiPlannerProgram)).toEqual({
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
                        content: "office found. now checking the weather.",
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
            });
        });
    });

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
});
