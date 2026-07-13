// Executable documentation for the anthropic_messages dialect.

import { describe, expect, spyOn, test } from "bun:test";
import {
    AnthropicTranslator,
    LintError,
    OpenAIChatTranslator,
} from "../../../src/index";

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

describe("anthropic_messages requests", () => {
    test("system string and content blocks flatten to the same core ops openai produces", () => {
        const program = AnthropicTranslator.fromBody({
            model: "claude-sonnet-4-6",
            max_tokens: 800,
            system: "You are an omniscient AI",
            messages: [
                { role: "user", content: "Hello" },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "I am an omniscient ai" }],
                },
            ],
        });

        expect(program).toEqual([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.max_output_tokens", value: 800 },
            {
                op: "llm.text",
                role: "system",
                content: "You are an omniscient AI",
            },
            { op: "llm.text", role: "user", content: "Hello" },
            {
                op: "llm.text",
                role: "assistant",
                content: "I am an omniscient ai",
            },
        ]);
    });

    test("top-level system is raised before messages even when the JSON body lists messages first", () => {
        const program = AnthropicTranslator.fromBody({
            model: "claude-sonnet-4-6",
            max_tokens: 800,
            messages: [{ role: "user", content: "Hello" }],
            system: [
                {
                    type: "text",
                    text: "You are an omniscient AI",
                    cache_control: { type: "ephemeral" },
                },
            ],
        });

        expect(program).toEqual([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.max_output_tokens", value: 800 },
            {
                op: "llm.text",
                role: "system",
                content: "You are an omniscient AI",
            },
            {
                op: "anthropic_messages.text_meta",
                fields: { cache_control: { type: "ephemeral" } },
            },
            { op: "llm.text", role: "user", content: "Hello" },
        ]);
    });

    test("shared request controls raise to portable core ops and serialize home", () => {
        const body = {
            model: "claude-sonnet-5",
            max_tokens: 800,
            metadata: { user_id: "user-123" },
            stream: true,
            stop_sequences: ["</stop>"],
            thinking: { type: "adaptive", display: "omitted" },
            output_config: { effort: "medium" },
            messages: [{ role: "user", content: "hi" }],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "request.user",
            value: "user-123",
        });
        expect(program).toContainEqual({ op: "request.stream", value: true });
        expect(program).toContainEqual({
            op: "request.stop_sequences",
            value: ["</stop>"],
        });
        expect(program).toContainEqual({
            op: "llm.thinking",
            effort: "medium",
        });
        expect(AnthropicTranslator.toBody(program)).toEqual({
            ...body,
            messages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
            ],
        });
    });

    test("tool use round-trips through the core IR", () => {
        const body = {
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
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
                            id: "toolu_1",
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
                            tool_use_id: "toolu_1",
                            content: '["INV-7"]',
                        },
                    ],
                },
            ],
            tools: [
                {
                    name: "list_invoices",
                    description: "List customer invoices.",
                    input_schema: {
                        type: "object",
                        properties: { customer_id: { type: "string" } },
                    },
                },
            ],
            tool_choice: { type: "auto" },
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.tool_call",
            id: "toolu_1",
            name: "list_invoices",
            arguments: { customer_id: "c_9" },
        });
        expect(program).toContainEqual({
            op: "llm.tool_result",
            id: "toolu_1",
            content: '["INV-7"]',
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("provider-specific tool fields are preserved instead of normalized away", () => {
        const body = {
            model: "claude-sonnet-5",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "search current docs" }],
                },
            ],
            tools: [
                {
                    type: "web_search_20260318",
                    name: "web_search",
                    max_uses: 3,
                    allowed_callers: ["direct"],
                    response_inclusion: "excluded",
                },
                {
                    name: "write_report",
                    description: "Write a report.",
                    strict: true,
                    eager_input_streaming: true,
                    cache_control: { type: "ephemeral" },
                    input_schema: {
                        type: "object",
                        properties: { title: { type: "string" } },
                        required: ["title"],
                    },
                },
            ],
            tool_choice: { type: "tool", name: "web_search" },
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "anthropic_messages.tool",
            tool: body.tools[0],
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.tool_meta",
            name: "write_report",
            fields: {
                strict: true,
                eager_input_streaming: true,
                cache_control: { type: "ephemeral" },
            },
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("unknown server tool versions stay residual instead of being rewritten", () => {
        const body = {
            model: "claude-sonnet-5",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "search current docs" }],
                },
            ],
            tools: [{ type: "web_search_20991231", name: "web_search" }],
            tool_choice: { type: "tool", name: "web_search" },
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "anthropic_messages.tool",
            tool: body.tools[0],
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("minimal server tools raise to portable core server tools", () => {
        const body = {
            model: "claude-sonnet-5",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "search current docs" }],
                },
            ],
            tools: [
                { type: "web_search_20260318", name: "web_search" },
                { type: "code_execution_20260521", name: "code_execution" },
            ],
            tool_choice: { type: "tool", name: "web_search" },
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.server_tool",
            name: "web_search",
            kind: "web_search",
        });
        expect(program).toContainEqual({
            op: "llm.server_tool",
            name: "code_execution",
            kind: "code_execution",
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("text-only tool_result content arrays raise to core result and preserve Anthropic shape", () => {
        const body = {
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_1",
                            content: [
                                { type: "text", text: "first" },
                                { type: "text", text: "second" },
                            ],
                        },
                    ],
                },
            ],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.tool_result",
            id: "toolu_1",
            content: "firstsecond",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.tool_result_meta",
            id: "toolu_1",
            fields: { content: body.messages[0]!.content[0]!.content },
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("cached tool_result content raises to core result plus Anthropic metadata", () => {
        const body = {
            model: "claude-opus-4-8",
            max_tokens: 100,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_1",
                            content: "Task created",
                            cache_control: { type: "ephemeral" },
                        },
                    ],
                },
            ],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.tool_result",
            id: "toolu_1",
            content: "Task created",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.tool_result_meta",
            id: "toolu_1",
            fields: { cache_control: { type: "ephemeral" } },
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("errored tool_result raises to core result plus required Anthropic metadata", () => {
        const body = {
            model: "claude-opus-4-8",
            max_tokens: 100,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "toolu_1",
                            content: "permission denied",
                            is_error: true,
                        },
                    ],
                },
            ],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.tool_result",
            id: "toolu_1",
            content: "permission denied",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.tool_result_meta",
            id: "toolu_1",
            is_error: true,
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("tool metadata can appear before the core tool without duplicating the tool", () => {
        const body = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.max_output_tokens", value: 100 },
            {
                op: "anthropic_messages.tool_meta",
                name: "lookup_customer",
                fields: { strict: true },
            },
            {
                op: "llm.tool",
                name: "lookup_customer",
                inputSchema: { type: "object" },
            },
            { op: "llm.text", role: "user", content: "lookup c_1" },
        ]) as { tools: unknown[] };

        expect(body.tools).toEqual([
            {
                name: "lookup_customer",
                strict: true,
                input_schema: { type: "object" },
            },
        ]);
    });

    test("documents stay residual while images and cached text raise to core ops", () => {
        const body = {
            model: "claude-opus-4-8",
            max_tokens: 512,
            system: [
                {
                    type: "text",
                    text: "Keep the uploaded context cached.",
                    cache_control: { type: "ephemeral" },
                },
            ],
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "document",
                            source: {
                                type: "url",
                                url: "https://example.com/paper.pdf",
                            },
                            citations: { enabled: true },
                        },
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: "image/png",
                                data: "iVBORw0KGgo=",
                            },
                        },
                        { type: "text", text: "summarize these" },
                    ],
                },
            ],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.text",
            role: "system",
            content: "Keep the uploaded context cached.",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.text_meta",
            fields: { cache_control: { type: "ephemeral" } },
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.content_block",
            block: body.messages[0]!.content[0],
            role: "user",
            preservesContent: true,
        });
        expect(program).toContainEqual({
            op: "llm.image",
            role: "user",
            source: {
                type: "base64",
                mediaType: "image/png",
                data: "iVBORw0KGgo=",
            },
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("image URL blocks raise to portable image ops", () => {
        const body = {
            model: "claude-opus-4-8",
            max_tokens: 512,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this?" },
                        {
                            type: "image",
                            source: {
                                type: "url",
                                url: "https://example.com/invoice.png",
                            },
                        },
                        { type: "text", text: "answer briefly" },
                    ],
                },
            ],
        };

        expect(AnthropicTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "claude-opus-4-8" },
            { op: "llm.max_output_tokens", value: 512 },
            { op: "llm.text", role: "user", content: "what is this?" },
            {
                op: "llm.image",
                role: "user",
                source: {
                    type: "url",
                    url: "https://example.com/invoice.png",
                },
            },
            { op: "llm.text", role: "user", content: "answer briefly" },
        ]);
        expect(
            AnthropicTranslator.toBody(AnthropicTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("non-image base64 image blocks stay native residuals", () => {
        const body = {
            model: "claude-opus-4-8",
            max_tokens: 512,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: "application/pdf",
                                data: "cGRm",
                            },
                        },
                    ],
                },
            ],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "anthropic_messages.content_block",
            block: body.messages[0]!.content[0],
            role: "user",
            preservesContent: true,
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("cached assistant text in request history round-trips as request content", () => {
        const body = {
            model: "claude-opus-4-8",
            max_tokens: 100,
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "cached assistant",
                            cache_control: { type: "ephemeral" },
                        },
                    ],
                },
            ],
        };

        const program = AnthropicTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.text",
            role: "assistant",
            content: "cached assistant",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.text_meta",
            fields: { cache_control: { type: "ephemeral" } },
        });
        expect(AnthropicTranslator.toBody(program)).toEqual(body);
    });

    test("lowering merges consecutive same-role ops into one alternating-turn message", () => {
        const body = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.max_output_tokens", value: 100 },
            { op: "llm.text", role: "user", content: "first" },
            { op: "llm.text", role: "user", content: "second" },
        ]) as { messages: unknown[] };

        expect(body.messages).toEqual([
            {
                role: "user",
                content: [
                    { type: "text", text: "first" },
                    { type: "text", text: "second" },
                ],
            },
        ]);
    });

    test("the default-max-tokens legalization fills in the required cap", () => {
        const body = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.text", role: "user", content: "hi" },
        ]) as { max_tokens: number };

        expect(body.max_tokens).toBe(4096);
    });

    test("empty text raises faithfully but is dropped when lowering — the API rejects empty text blocks", () => {
        // Real behavior, verified live: the Messages API 400s with "text content
        // blocks must be non-empty". openai clients routinely send content: ""
        // on tool-call turns, so cross-provider traffic hits this constantly.
        // The program keeps the op (raising never loses information); the
        // dropEmptyText lower stage removes it because it carries no meaning.
        const body = {
            model: "claude-haiku-4-5",
            max_tokens: 100,
            messages: [{ role: "user", content: "" }],
        };

        expect(AnthropicTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "claude-haiku-4-5" },
            { op: "llm.max_output_tokens", value: 100 },
            { op: "llm.text", role: "user", content: "" },
        ]);
        expect(
            AnthropicTranslator.toBody(AnthropicTranslator.fromBody(body)),
        ).toEqual({
            model: "claude-haiku-4-5",
            max_tokens: 100,
            messages: [],
        });

        // The shape that matters on real traffic: an assistant tool-call turn
        // with content: "" lowers to a bare tool_use block, no empty text.
        const assistantCall = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-haiku-4-5" },
            { op: "llm.max_output_tokens", value: 100 },
            { op: "llm.text", role: "user", content: "weather?" },
            { op: "llm.text", role: "assistant", content: "" },
            {
                op: "llm.tool_call",
                id: "t1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
        ]) as { messages: unknown[] };
        expect(assistantCall.messages[1]).toEqual({
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: "t1",
                    name: "get_weather",
                    input: { city: "Paris" },
                },
            ],
        });
    });

    test("lowering never mutates the caller's program — repeated toBody is idempotent", () => {
        // A residual message op flows through lowering by reference; the merge
        // stage used to push lowered blocks into ITS content array, corrupting
        // the caller's program so each toBody call grew the message again.
        const residualMessage = {
            role: "user",
            content: [{ type: "text", text: "from residual" }],
        };
        const program = [
            { op: "llm.model", model: "claude-haiku-4-5" },
            { op: "llm.max_output_tokens", value: 100 },
            { op: "anthropic_messages.message", message: residualMessage },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        const first = AnthropicTranslator.toBody(program);
        const second = AnthropicTranslator.toBody(program);
        expect(second).toEqual(first);
        expect(residualMessage.content).toEqual([
            { type: "text", text: "from residual" },
        ]);
    });

    test("late system text lints instead of being hoisted ahead of earlier user text", () => {
        expect(() =>
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-haiku-4-5" },
                { op: "llm.max_output_tokens", value: 100 },
                { op: "llm.text", role: "user", content: "first" },
                { op: "llm.text", role: "system", content: "late instruction" },
                { op: "llm.text", role: "user", content: "second" },
            ]),
        ).toThrow(LintError);
    });

    test("late system blocks lint after residual media content too", () => {
        expect(() =>
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-opus-4-8" },
                { op: "llm.max_output_tokens", value: 100 },
                {
                    op: "anthropic_messages.content_block",
                    role: "user",
                    block: {
                        type: "image",
                        source: {
                            type: "url",
                            url: "https://example.com/a.png",
                        },
                    },
                },
                {
                    op: "anthropic_messages.system_block",
                    block: { type: "text", text: "late" },
                },
            ]),
        ).toThrow("system block after conversation start");
    });

    test("new models drop unsupported sampling params unless strict mode is requested", () => {
        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-5" },
                { op: "llm.temperature", value: 0.2 },
                { op: "llm.max_output_tokens", value: 1 },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "claude-sonnet-5",
            max_tokens: 1,
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hi" }],
                },
            ],
        });

        expect(() =>
            AnthropicTranslator.toBody(
                [
                    { op: "llm.model", model: "claude-sonnet-5" },
                    { op: "llm.temperature", value: 0.2 },
                    { op: "llm.max_output_tokens", value: 1 },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow("explicit temperature is rejected");

        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-opus-4-8" },
                { op: "llm.max_output_tokens", value: 1 },
                {
                    op: "anthropic_messages.sampling",
                    key: "top_p",
                    value: 0.9,
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).not.toHaveProperty("top_p");

        expect(() =>
            AnthropicTranslator.toBody(
                [
                    { op: "llm.model", model: "claude-opus-4-8" },
                    { op: "llm.max_output_tokens", value: 1 },
                    {
                        op: "anthropic_messages.sampling",
                        key: "top_p",
                        value: 0.9,
                    },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow("explicit top_p is rejected");

        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-haiku-4-5" },
                { op: "llm.temperature", value: 0.2 },
                { op: "llm.max_output_tokens", value: 1 },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({ temperature: 0.2 });
    });

    test("thinking requests drop explicit sampling params even on models that otherwise accept them", () => {
        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-4-5-20250929" },
                { op: "llm.temperature", value: 0.2 },
                { op: "llm.max_output_tokens", value: 4096 },
                { op: "llm.thinking", effort: "high" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).not.toHaveProperty("temperature");
    });

    test("thinking legalization uses adaptive effort for newer Sonnet and manual budget tokens for Sonnet 4.5", () => {
        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-5" },
                { op: "llm.max_output_tokens", value: 2048 },
                { op: "llm.thinking", effort: "high" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
        });

        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-5" },
                { op: "llm.max_output_tokens", value: 2048 },
                {
                    op: "anthropic_messages.thinking",
                    adaptiveEffort: "medium",
                    manualBudgetTokens: 1024,
                    display: "omitted",
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            thinking: { type: "adaptive", display: "omitted" },
            output_config: { effort: "medium" },
        });

        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-4-5-20250929" },
                { op: "llm.max_output_tokens", value: 2048 },
                {
                    op: "anthropic_messages.thinking",
                    manualBudgetTokens: 1024,
                    display: "omitted",
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            thinking: {
                type: "enabled",
                budget_tokens: 1024,
                display: "omitted",
            },
        });
    });

    test("consecutive tool results lower into one user message", () => {
        const body = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-haiku-4-5" },
            { op: "llm.max_output_tokens", value: 1024 },
            { op: "llm.tool_result", id: "call_a", content: "A" },
            { op: "llm.tool_result", id: "call_b", content: "B" },
        ]);

        expect(body).toEqual({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "call_a",
                            content: "A",
                        },
                        {
                            type: "tool_result",
                            tool_use_id: "call_b",
                            content: "B",
                        },
                    ],
                },
            ],
        });
    });

    test("adaptive thinking effort merges with structured output config", () => {
        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-5" },
                { op: "llm.max_output_tokens", value: 2048 },
                {
                    op: "anthropic_messages.thinking",
                    adaptiveEffort: "low",
                    manualBudgetTokens: 1024,
                },
                { op: "llm.text", role: "user", content: "extract" },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "invoice",
                    schema: {
                        type: "object",
                        properties: { total: { type: "number" } },
                        required: ["total"],
                        additionalProperties: false,
                    },
                },
            ]),
        ).toMatchObject({
            output_config: {
                effort: "low",
                format: {
                    type: "json_schema",
                    schema: {
                        type: "object",
                        properties: { total: { type: "number" } },
                        required: ["total"],
                        additionalProperties: false,
                    },
                },
            },
        });
    });

    test("unsupported effort levels clamp for the target model unless strict mode is requested", () => {
        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-4-6" },
                { op: "llm.max_output_tokens", value: 2048 },
                {
                    op: "anthropic_messages.thinking",
                    adaptiveEffort: "xhigh",
                    manualBudgetTokens: 1024,
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
        });

        expect(() =>
            AnthropicTranslator.toBody(
                [
                    { op: "llm.model", model: "claude-sonnet-4-6" },
                    { op: "llm.max_output_tokens", value: 2048 },
                    {
                        op: "anthropic_messages.thinking",
                        adaptiveEffort: "xhigh",
                        manualBudgetTokens: 1024,
                    },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow('effort "xhigh" is not supported');
    });

    test("manual thinking budget is clamped below max_tokens unless strict mode is requested", () => {
        expect(
            AnthropicTranslator.toBody([
                { op: "llm.model", model: "claude-sonnet-4-5-20250929" },
                { op: "llm.max_output_tokens", value: 1024 },
                {
                    op: "anthropic_messages.thinking",
                    manualBudgetTokens: 1024,
                },
            ]),
        ).toMatchObject({
            thinking: {
                type: "enabled",
                budget_tokens: 1023,
            },
        });

        expect(() =>
            AnthropicTranslator.toBody(
                [
                    { op: "llm.model", model: "claude-sonnet-4-5-20250929" },
                    { op: "llm.max_output_tokens", value: 1024 },
                    {
                        op: "anthropic_messages.thinking",
                        manualBudgetTokens: 1024,
                    },
                ],
                { strict: true },
            ),
        ).toThrow("budget_tokens must be less than max_tokens");
    });
});

describe("anthropic_messages responses", () => {
    const wireResponse = {
        id: "msg_01ABC",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "No, it is correct." }],
        stop_reason: "end_turn",
        usage: {
            input_tokens: 20,
            output_tokens: 9,
            cache_read_input_tokens: 0,
        },
    };

    test("responses raise to core ops plus an ignorable vendor-usage residual", () => {
        // The message raises first; the rest follows wire key order.
        expect(AnthropicTranslator.fromResponse(wireResponse)).toEqual([
            {
                op: "llm.text",
                role: "assistant",
                content: "No, it is correct.",
            },
            { op: "response.id", id: "msg_01ABC" },
            {
                op: "anthropic_messages.body_field",
                key: "type",
                value: "message",
                appliesTo: "response",
            },
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "response.stop", reason: "end_turn" },
            {
                op: "response.usage",
                inputTokens: 20,
                outputTokens: 9,
                cacheReadTokens: 0,
            },
        ]);
    });

    test("usage with cache read and write tokens round-trip", () => {
        const response = {
            id: "msg_cache",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "cached" }],
            stop_reason: "end_turn",
            usage: {
                input_tokens: 1200,
                output_tokens: 40,
                cache_read_input_tokens: 1152,
                cache_creation_input_tokens: 64,
            },
        };

        const program = AnthropicTranslator.fromResponse(response);
        expect(program).toContainEqual({
            op: "response.id",
            id: "msg_cache",
        });
        expect(program).toContainEqual({
            op: "response.usage",
            inputTokens: 1200,
            outputTokens: 40,
            cacheReadTokens: 1152,
            cacheWriteTokens: 64,
        });
        expect(AnthropicTranslator.toResponse(program)).toEqual(response);
    });

    test("responses round-trip", () => {
        const program = AnthropicTranslator.fromResponse(wireResponse);
        expect(AnthropicTranslator.toResponse(program)).toEqual(wireResponse);
    });

    test("thinking response blocks survive as anthropic residuals and round-trip before text", () => {
        const response = {
            id: "msg_thinking",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [
                {
                    type: "thinking",
                    thinking: "",
                    signature: "sig_1",
                },
                { type: "text", text: "The answer is 42." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
        };

        const program = AnthropicTranslator.fromResponse(response);
        expect(program).toContainEqual({
            op: "anthropic_messages.content_block",
            block: {
                type: "thinking",
                thinking: "",
                signature: "sig_1",
            },
            role: "assistant",
            appliesTo: "response",
        });
        expect(program).toContainEqual({
            op: "llm.text",
            role: "assistant",
            content: "The answer is 42.",
        });
        expect(AnthropicTranslator.toResponse(program)).toEqual(response);
    });

    test("thinking response blocks keep their relative order with surrounding text", () => {
        const response = {
            id: "msg_interleaved_thinking",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [
                { type: "text", text: "first" },
                { type: "thinking", thinking: "", signature: "sig_1" },
                { type: "text", text: "second" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
        };

        const program = AnthropicTranslator.fromResponse(response);
        expect(AnthropicTranslator.toResponse(program)).toEqual(response);
    });

    test("server tool response blocks preserve exact Anthropic shape", () => {
        const response = {
            id: "msg_server_tool",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-8",
            content: [
                {
                    type: "server_tool_use",
                    id: "srvtoolu_123",
                    name: "web_search",
                    input: { query: "Anthropic tool reference" },
                },
                {
                    type: "web_search_tool_result",
                    tool_use_id: "srvtoolu_123",
                    content: [
                        {
                            type: "web_search_result",
                            title: "Tool reference",
                            url: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference",
                            encrypted_content: "enc_123",
                        },
                    ],
                },
                {
                    type: "text",
                    text: "I found the tool reference.",
                    citations: [
                        {
                            type: "web_search_result_location",
                            url: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference",
                            encrypted_index: "idx_123",
                        },
                    ],
                },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
        };

        const program = AnthropicTranslator.fromResponse(response);
        expect(program).toContainEqual({
            op: "anthropic_messages.content_block",
            block: response.content[0],
            role: "assistant",
            appliesTo: "response",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.content_block",
            block: response.content[1],
            role: "assistant",
            appliesTo: "response",
        });
        expect(program).toContainEqual({
            op: "anthropic_messages.content_block",
            block: response.content[2],
            role: "assistant",
            appliesTo: "response",
        });
        expect(AnthropicTranslator.toResponse(program)).toEqual(response);
    });

    test("newer stop reasons have core mappings", () => {
        for (const [wire, core] of [
            ["refusal", "refusal"],
            ["pause_turn", "pause_turn"],
            ["model_context_window_exceeded", "model_context_window_exceeded"],
        ] as const) {
            expect(
                AnthropicTranslator.fromResponse({
                    role: "assistant",
                    model: "claude-opus-4-8",
                    content: [],
                    stop_reason: wire,
                    usage: { input_tokens: 1, output_tokens: 1 },
                }),
            ).toContainEqual({ op: "response.stop", reason: core });
        }
    });
});

describe("anthropic_messages response streams", () => {
    test("text deltas raise and lower", () => {
        const event = {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
        };

        const program = AnthropicTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            { op: "response.text_delta", index: 0, content: "hi" },
        ]);
        expect(AnthropicTranslator.toStreamResponse(program)).toEqual(event);
    });

    test("tool use starts raise and lower without parsing streamed input", () => {
        const event = {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: "toolu_1",
                name: "lookup",
                input: {},
            },
        };

        const program = AnthropicTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            {
                op: "response.tool_call_delta",
                index: 0,
                id: "toolu_1",
                name: "lookup",
            },
        ]);
        expect(AnthropicTranslator.toStreamResponse(program)).toEqual(event);
    });

    test("tool input json fragments raise and lower as raw strings", () => {
        const event = {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"x"' },
        };

        const program = AnthropicTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            {
                op: "response.tool_call_delta",
                index: 0,
                arguments: '{"x"',
            },
        ]);
        expect(AnthropicTranslator.toStreamResponse(program)).toEqual(event);
    });

    test("message_delta stop reason and usage raise and lower", () => {
        const event = {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 4 },
        };

        const program = AnthropicTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            { op: "response.stop", reason: "end_turn" },
            { op: "response.usage", outputTokens: 4 },
        ]);
        expect(AnthropicTranslator.toStreamResponse(program)).toEqual(event);
    });

    test("message_delta with cache token usage raises and lowers", () => {
        const event = {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {
                input_tokens: 1200,
                output_tokens: 40,
                cache_read_input_tokens: 1152,
                cache_creation_input_tokens: 64,
            },
        };

        const program = AnthropicTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            { op: "response.stop", reason: "end_turn" },
            {
                op: "response.usage",
                inputTokens: 1200,
                outputTokens: 40,
                cacheReadTokens: 1152,
                cacheWriteTokens: 64,
            },
        ]);
        expect(AnthropicTranslator.toStreamResponse(program)).toEqual(event);
    });

    test("message_stop raises and lowers as a droppable anthropic residual", () => {
        const event = { type: "message_stop" };

        const program = AnthropicTranslator.fromStreamResponse(event);
        expect(program).toEqual([
            {
                op: "anthropic_messages.stream_event",
                event,
                appliesTo: "response",
            },
        ]);
        expect(AnthropicTranslator.toStreamResponse(program)).toEqual(event);
    });

    test("complete response core lowers to a readable Anthropic stream event sequence", () => {
        const events = AnthropicTranslator.toStreamResponses([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.text", role: "assistant", content: "hello" },
            {
                op: "llm.tool_call",
                id: "toolu_1",
                name: "lookup",
                arguments: { query: "metamodel" },
            },
            { op: "response.stop", reason: "tool_use" },
            { op: "response.usage", inputTokens: 12, outputTokens: 4 },
        ]) as Record<string, unknown>[];

        expect(events.map((event) => event.type)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);
        expect(events[0]).toMatchObject({
            type: "message_start",
            message: {
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [],
                usage: { input_tokens: 12, output_tokens: 4 },
            },
        });
        expect(events[2]).toEqual({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hello" },
        });
        expect(events[5]).toEqual({
            type: "content_block_delta",
            index: 1,
            delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({ query: "metamodel" }),
            },
        });
        expect(events[7]).toEqual({
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { input_tokens: 12, output_tokens: 4 },
        });
    });

    test("OpenAI chat response IR lowers directly to Anthropic stream events", () => {
        const core = OpenAIChatTranslator.fromResponse({
            id: "chatcmpl_1",
            object: "chat.completion",
            created: 0,
            model: "gpt-5.5",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "from openai" },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5,
            },
        }).map((op) =>
            op.op === "llm.model" ? { ...op, model: "claude-sonnet-4-6" } : op,
        );

        const events = AnthropicTranslator.toStreamResponses(core) as Record<
            string,
            unknown
        >[];

        expect(events.map((event) => event.type)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);
        expect(events[2]).toEqual({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "from openai" },
        });
        expect(events[4]).toEqual({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { input_tokens: 3, output_tokens: 2 },
        });
    });

    test("foreign stream residuals warn and drop around complete response lowering", () => {
        withWarnSpy((warn) => {
            const events = AnthropicTranslator.toStreamResponses([
                { op: "llm.model", model: "claude-sonnet-4-6" },
                {
                    op: "openai_chat.stream_choice_param",
                    key: "logprobs",
                    value: null,
                    appliesTo: "response",
                },
                { op: "llm.text", role: "assistant", content: "hello" },
            ]) as Record<string, unknown>[];

            expect(events.map((event) => event.type)).toEqual([
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_stop",
            ]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "openai_chat.stream_choice_param"',
                ),
            );
        });
    });

    test("foreign-only plural stream conversion returns no events after warning", () => {
        withWarnSpy((warn) => {
            expect(
                AnthropicTranslator.toStreamResponses([
                    {
                        op: "openai_chat.stream_choice_param",
                        key: "logprobs",
                        value: null,
                        appliesTo: "response",
                    },
                ]),
            ).toEqual([]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "openai_chat.stream_choice_param"',
                ),
            );
        });
    });

    test("complete response stream lowering rejects mixed delta ops", () => {
        expect(() =>
            AnthropicTranslator.toStreamResponses([
                { op: "llm.model", model: "claude-sonnet-4-6" },
                { op: "llm.text", role: "assistant", content: "hello" },
                { op: "response.text_delta", index: 0, content: "again" },
            ]),
        ).toThrow("cannot mix complete response blocks with stream delta ops");
    });

    test("empty complete responses still lower to a complete stream envelope", () => {
        const events = AnthropicTranslator.toStreamResponses([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.text", role: "assistant", content: "" },
            { op: "response.stop", reason: "end_turn" },
            { op: "response.usage", inputTokens: 2, outputTokens: 0 },
        ]) as Record<string, unknown>[];

        expect(events).toEqual([
            expect.objectContaining({
                type: "message_start",
                message: expect.objectContaining({
                    model: "claude-sonnet-4-6",
                    content: [],
                }),
            }),
            {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { input_tokens: 2, output_tokens: 0 },
            },
            { type: "message_stop" },
        ]);
    });

    test("Anthropic-native response blocks lower to raw stream block events", () => {
        const events = AnthropicTranslator.toStreamResponses([
            { op: "llm.model", model: "claude-opus-4-8" },
            {
                op: "anthropic_messages.content_block",
                role: "assistant",
                appliesTo: "response",
                block: {
                    type: "server_tool_use",
                    id: "srvtoolu_123",
                    name: "web_search",
                    input: { query: "Anthropic tool reference" },
                },
            },
            {
                op: "anthropic_messages.content_block",
                role: "assistant",
                appliesTo: "response",
                block: {
                    type: "web_search_tool_result",
                    tool_use_id: "srvtoolu_123",
                    content: [
                        {
                            type: "web_search_result",
                            title: "Tool reference",
                            url: "https://example.test/tool-reference",
                        },
                    ],
                },
            },
            { op: "response.stop", reason: "end_turn" },
        ]) as Record<string, unknown>[];

        expect(events.map((event) => event.type)).toEqual([
            "message_start",
            "content_block_start",
            "content_block_stop",
            "content_block_start",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]);
        expect(events[1]).toMatchObject({
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "server_tool_use",
                id: "srvtoolu_123",
                name: "web_search",
                input: { query: "Anthropic tool reference" },
            },
        });
        expect(events[3]).toMatchObject({
            type: "content_block_start",
            index: 1,
            content_block: {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_123",
            },
        });
    });

    test("unsupported stream events throw", () => {
        expect(() =>
            AnthropicTranslator.fromStreamResponse({ type: "ping" }),
        ).toThrow(LintError);
    });
});
