import { describe, expect, test } from "bun:test";
import {
    GeminiTranslator,
    LintError,
    OpenAIResponsesTranslator,
} from "../../../src/index";
import { OpenAIResponsesDialect } from "../../../src/dialects/openai_responses/index";

const replayedCall = {
    type: "function_call",
    id: "fc_replay_alpha_81",
    call_id: "call_replay_alpha_81",
    name: "lookup",
    arguments: '{"key":"alpha"}',
};

const replayedResult = {
    type: "function_call_output",
    call_id: "call_replay_alpha_81",
    output: '{"value":17}',
};

describe("openai_responses requests", () => {
    test("a responses body becomes core ops and round-trips", () => {
        const body = {
            model: "gpt-4o-mini",
            instructions: "Reply tersely.",
            max_output_tokens: 80,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
                {
                    type: "function_call_output",
                    call_id: "call_1",
                    output: '{"ok":true}',
                },
            ],
            tools: [
                {
                    type: "function",
                    name: "get_weather",
                    description: "Get weather for a city.",
                    parameters: {
                        type: "object",
                        properties: { city: { type: "string" } },
                        required: ["city"],
                    },
                },
            ],
            tool_choice: { type: "function", name: "get_weather" },
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o-mini" },
            { op: "llm.text", role: "system", content: "Reply tersely." },
            { op: "llm.max_output_tokens", value: 80 },
            { op: "llm.text", role: "user", content: "hi" },
            { op: "llm.tool_result", id: "call_1", content: '{"ok":true}' },
            {
                op: "llm.tool",
                name: "get_weather",
                description: "Get weather for a city.",
                inputSchema: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                },
            },
            { op: "llm.tool_choice", value: { name: "get_weather" } },
        ]);
        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("assistant history text raises from a string or a text part and lowers as string content", () => {
        const user = {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
        };
        const body = {
            model: "gpt-4o-mini",
            input: [
                user,
                { type: "message", role: "assistant", content: "hello" },
            ],
        };
        const withPart = (type: string) => ({
            model: "gpt-4o-mini",
            input: [
                user,
                {
                    type: "message",
                    role: "assistant",
                    content: [{ type, text: "hello" }],
                },
            ],
        });
        const program = [
            { op: "llm.model", model: "gpt-4o-mini" },
            { op: "llm.text", role: "user", content: "hi" },
            { op: "llm.text", role: "assistant", content: "hello" },
        ];

        expect(OpenAIResponsesTranslator.fromBody(body)).toEqual(program);
        expect(
            OpenAIResponsesTranslator.fromBody(withPart("output_text")),
        ).toEqual(program);
        expect(
            OpenAIResponsesTranslator.fromBody(withPart("input_text")),
        ).toEqual(program);
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(body);
        expect(OpenAIResponsesDialect.request.toWire(program)).toEqual(body);
    });

    test("function tool extras round-trip in the responses dialect", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            ],
            tools: [
                { type: "function", name: "fn", parameters: {}, strict: true },
            ],
        };

        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("instructions raise ahead of the conversation when the body writes input first", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            ],
            temperature: 0.2,
            instructions: "Reply tersely.",
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o-mini" },
            { op: "llm.text", role: "system", content: "Reply tersely." },
            { op: "llm.text", role: "user", content: "hi" },
            { op: "llm.temperature", value: 0.2 },
        ]);
        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("custom grammar tools stay as responses-only tool residuals", () => {
        const customTool = {
            type: "custom",
            name: "apply_patch",
            format: {
                type: "grammar",
                syntax: "lark",
                definition: "start: /.+/",
            },
        };
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "patch the file" }],
                },
            ],
            tools: [customTool],
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toContainEqual({
            op: "openai_responses.tool",
            tool: customTool,
            appliesTo: "request",
        });
        expect(
            OpenAIResponsesTranslator.toBody([
                { op: "llm.model", model: "gpt-4o-mini" },
                { op: "llm.text", role: "user", content: "patch the file" },
                {
                    op: "openai_responses.tool",
                    tool: customTool,
                    appliesTo: "request",
                },
            ]),
        ).toEqual(body);
        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("custom grammar tool choice stays as a responses-only residual", () => {
        const body = {
            model: "gpt-4o-mini",
            input: "patch the file",
            tools: [
                {
                    type: "custom",
                    name: "apply_patch",
                    format: {
                        type: "grammar",
                        syntax: "lark",
                        definition: "start: /.+/",
                    },
                },
            ],
            tool_choice: { type: "custom", name: "apply_patch" },
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toContainEqual({
            op: "openai_responses.tool_choice",
            value: body.tool_choice,
        });
        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual({
            ...body,
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "patch the file" }],
                },
            ],
        });
    });

    test("input_image URL parts raise to portable image ops and round-trip", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "what is this?" },
                        {
                            type: "input_image",
                            image_url: "https://example.com/invoice.png",
                        },
                        { type: "input_text", text: "answer briefly" },
                    ],
                },
            ],
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o-mini" },
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
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("input_image data URLs normalize to portable base64", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: "data:image/jpeg;base64,anBn",
                        },
                    ],
                },
            ],
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toContainEqual({
            op: "llm.image",
            role: "user",
            source: {
                type: "base64",
                mediaType: "image/jpeg",
                data: "anBn",
            },
        });
    });

    test("file-backed input_image stays a native Responses residual", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "what is this?" },
                        {
                            type: "input_image",
                            file_id: "file_123",
                        },
                    ],
                },
            ],
        };

        expect(OpenAIResponsesTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o-mini" },
            {
                op: "openai_responses.input",
                item: body.input[0],
                preservesContent: true,
            },
        ]);
        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("non-image input_image data URLs do not enter the portable image op", () => {
        expect(() =>
            OpenAIResponsesTranslator.fromBody({
                model: "gpt-4o-mini",
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [
                            {
                                type: "input_image",
                                image_url: "data:application/pdf;base64,cGRm",
                            },
                        ],
                    },
                ],
            }),
        ).toThrow("expected an image/* data URL");
    });

    test("reasoning requests serialize effort and encrypted-content include", () => {
        expect(
            OpenAIResponsesTranslator.toBody([
                { op: "llm.model", model: "gpt-5.4" },
                { op: "llm.thinking", effort: "high" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "gpt-5.4",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            ],
            reasoning: { effort: "high", summary: "auto" },
            include: ["reasoning.encrypted_content"],
        });
    });

    test("minimal hosted server tools raise to core and lower from name-only choice", () => {
        const program = OpenAIResponsesTranslator.fromBody({
            model: "gpt-4o-mini",
            input: "search current docs",
            tools: [{ type: "web_search_preview" }],
            tool_choice: { type: "web_search_preview" },
        });

        expect(program).toContainEqual({
            op: "llm.server_tool",
            name: "web_search",
            kind: "web_search",
        });
        expect(program).toContainEqual({
            op: "llm.tool_choice",
            value: { name: "web_search" },
        });
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual({
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "search current docs" },
                    ],
                },
            ],
            tools: [{ type: "web_search_preview" }],
            tool_choice: { type: "web_search_preview" },
        });
    });

    test("provider-configured hosted tools round-trip as responses residuals", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "search my files" }],
                },
            ],
            tools: [
                {
                    type: "file_search",
                    vector_store_ids: ["vs_123"],
                    max_num_results: 5,
                },
                {
                    type: "mcp",
                    server_label: "deepwiki",
                    server_url: "https://mcp.example.test",
                },
            ],
        };

        const program = OpenAIResponsesTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "openai_responses.tool",
            tool: body.tools[0],
            appliesTo: "request",
        });
        expect(program).toContainEqual({
            op: "openai_responses.tool",
            tool: body.tools[1],
            appliesTo: "request",
        });
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(body);
    });

    test("provider-specific hosted tool choice round-trips as a responses residual", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "search my files" }],
                },
            ],
            tools: [
                {
                    type: "mcp",
                    server_label: "deepwiki",
                    server_url: "https://mcp.example.test",
                },
            ],
            tool_choice: {
                type: "mcp",
                server_label: "deepwiki",
                name: "ask_question",
            },
        };

        const program = OpenAIResponsesTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "openai_responses.tool_choice",
            value: body.tool_choice,
        });
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(body);
    });

    test("configured recognized hosted tool choice round-trips instead of becoming core choice", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "search the web" }],
                },
            ],
            tools: [
                {
                    type: "web_search_preview",
                    search_context_size: "low",
                },
            ],
            tool_choice: { type: "web_search_preview" },
        };

        const program = OpenAIResponsesTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "openai_responses.tool",
            tool: body.tools[0],
            appliesTo: "request",
        });
        expect(program).toContainEqual({
            op: "openai_responses.tool_choice",
            value: body.tool_choice,
        });
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(body);
    });

    test("version-pinned hosted tool types round-trip as responses residuals", () => {
        const body = {
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "search the web" }],
                },
            ],
            tools: [{ type: "web_search_preview_2025_03_11" }],
            tool_choice: { type: "web_search_preview_2025_03_11" },
        };

        expect(
            OpenAIResponsesTranslator.toBody(
                OpenAIResponsesTranslator.fromBody(body),
            ),
        ).toEqual(body);
    });

    test("name-only tool choice fails when declarations collide", () => {
        expect(() =>
            OpenAIResponsesTranslator.toBody([
                { op: "llm.model", model: "gpt-4o-mini" },
                {
                    op: "llm.tool",
                    name: "web_search",
                    inputSchema: { type: "object" },
                },
                {
                    op: "llm.server_tool",
                    name: "web_search",
                    kind: "web_search",
                },
                { op: "llm.tool_choice", value: { name: "web_search" } },
            ]),
        ).toThrow(LintError);
    });

    test("legacy response envelope params do not leak into request bodies", () => {
        const body = OpenAIResponsesTranslator.toBody([
            { op: "llm.model", model: "gpt-4o-mini" },
            { op: "llm.text", role: "user", content: "hi" },
            {
                op: "openai_responses.body_field",
                key: "id",
                value: "resp_legacy",
            },
            {
                op: "openai_responses.body_field",
                key: "user",
                value: "user-1234",
            },
        ]);

        expect(body).toEqual({
            model: "gpt-4o-mini",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            ],
            user: "user-1234",
        });
    });

    test("core tool calls lower to function_call input items", () => {
        expect(
            OpenAIResponsesTranslator.toBody([
                { op: "llm.model", model: "gpt-4o-mini" },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual({
            model: "gpt-4o-mini",
            input: [
                {
                    type: "function_call",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            ],
        });
    });

    test("a replayed function call keeps its call id and item id in separate ops", () => {
        const body = {
            model: "glm-5.3",
            input: [replayedCall, replayedResult],
        };
        const program = OpenAIResponsesTranslator.fromBody(body);

        expect(program).toEqual([
            { op: "llm.model", model: "glm-5.3" },
            {
                op: "llm.tool_call",
                id: "call_replay_alpha_81",
                name: "lookup",
                arguments: { key: "alpha" },
            },
            {
                op: "openai_responses.function_call_item",
                of: "call_replay_alpha_81",
                itemId: "fc_replay_alpha_81",
            },
            {
                op: "llm.tool_result",
                id: "call_replay_alpha_81",
                content: '{"value":17}',
            },
        ]);
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(body);
    });

    test("a function call item id resolves to the nearest earlier op with its call id", () => {
        const model = { op: "llm.model", model: "glm-5.3" } as const;
        const call = {
            op: "llm.tool_call",
            id: "call_reused",
            name: "lookup",
            arguments: { key: "alpha" },
        } as const;
        const result = {
            op: "llm.tool_result",
            id: "call_reused",
            content: '{"value":17}',
        } as const;
        const item = (itemId: string) =>
            ({
                op: "openai_responses.function_call_item",
                of: "call_reused",
                itemId,
            }) as const;

        expect(
            OpenAIResponsesTranslator.toBody([
                model,
                call,
                item("fc_first"),
                result,
                call,
                item("fc_second"),
            ]),
        ).toMatchObject({
            input: [
                { type: "function_call", id: "fc_first" },
                { type: "function_call_output", call_id: "call_reused" },
                { type: "function_call", id: "fc_second" },
            ],
        });
        expect(() =>
            OpenAIResponsesTranslator.toBody([
                model,
                call,
                result,
                item("fc_late"),
            ]),
        ).toThrow("does not resolve to an earlier llm.tool_call");
    });

    test("one replayed Responses call and result lower to Gemini", () => {
        const program = OpenAIResponsesTranslator.fromBody({
            model: "glm-5.3",
            input: [replayedCall, replayedResult],
        });

        expect(GeminiTranslator.toBody(program)).toEqual({
            model: "glm-5.3",
            contents: [
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "lookup",
                                args: { key: "alpha" },
                                id: "call_replay_alpha_81",
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
                                name: "lookup",
                                response: { value: 17 },
                                id: "call_replay_alpha_81",
                            },
                        },
                    ],
                },
            ],
        });
    });

    test("two parallel replayed Responses calls and results lower to Gemini", () => {
        const betaCall = {
            type: "function_call",
            id: "fc_replay_beta_82",
            call_id: "call_replay_beta_82",
            name: "lookup",
            arguments: '{"key":"beta"}',
        };
        const betaResult = {
            type: "function_call_output",
            call_id: "call_replay_beta_82",
            output: '{"value":18}',
        };
        const program = OpenAIResponsesTranslator.fromBody({
            model: "glm-5.3",
            input: [replayedCall, betaCall, replayedResult, betaResult],
        });

        expect(GeminiTranslator.toBody(program)).toEqual({
            model: "glm-5.3",
            contents: [
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "lookup",
                                args: { key: "alpha" },
                                id: "call_replay_alpha_81",
                            },
                            thoughtSignature:
                                "skip_thought_signature_validator",
                        },
                        {
                            functionCall: {
                                name: "lookup",
                                args: { key: "beta" },
                                id: "call_replay_beta_82",
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
                                name: "lookup",
                                response: { value: 17 },
                                id: "call_replay_alpha_81",
                            },
                        },
                        {
                            functionResponse: {
                                name: "lookup",
                                response: { value: 18 },
                                id: "call_replay_beta_82",
                            },
                        },
                    ],
                },
            ],
        });
    });
});

describe("openai_responses responses", () => {
    const wireResponse = {
        id: "resp_123",
        object: "response",
        created_at: 1783049000,
        status: "completed",
        model: "gpt-4o-mini",
        output: [
            {
                id: "msg_123",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                    {
                        type: "output_text",
                        text: "pong",
                        annotations: [],
                        logprobs: [],
                    },
                ],
            },
        ],
        usage: {
            input_tokens: 12,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 2,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 14,
        },
        incomplete_details: null,
    };

    test("text responses raise to assistant text, usage, stop, and response-only residuals", () => {
        expect(OpenAIResponsesTranslator.fromResponse(wireResponse)).toEqual([
            { op: "response.id", id: "resp_123" },
            {
                op: "openai_responses.body_field",
                key: "object",
                value: "response",
                appliesTo: "response",
            },
            {
                op: "openai_responses.body_field",
                key: "created_at",
                value: 1783049000,
                appliesTo: "response",
            },
            {
                op: "openai_responses.body_field",
                key: "status",
                value: "completed",
                appliesTo: "response",
            },
            { op: "llm.model", model: "gpt-4o-mini" },
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_responses.output_meta",
                item: {
                    id: "msg_123",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [
                        {
                            type: "output_text",
                            text: "pong",
                            annotations: [],
                            logprobs: [],
                        },
                    ],
                },
                appliesTo: "response",
            },
            {
                op: "response.usage",
                inputTokens: 12,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 2,
                reasoningTokens: 0,
            },
            {
                op: "openai_responses.body_field",
                key: "incomplete_details",
                value: null,
                appliesTo: "response",
            },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("responses round-trip", () => {
        expect(
            OpenAIResponsesTranslator.toResponse(
                OpenAIResponsesTranslator.fromResponse(wireResponse),
            ),
        ).toEqual(wireResponse);
    });

    test("completed responses without incomplete_details round-trip without adding it", () => {
        const response = {
            id: "resp_minimal_completed",
            object: "response",
            created_at: 1783049001,
            status: "completed",
            model: "gpt-4o-mini",
            output: [
                {
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [
                        {
                            type: "output_text",
                            text: "ok",
                            annotations: [],
                            logprobs: [],
                        },
                    ],
                },
            ],
        };

        expect(
            OpenAIResponsesTranslator.toResponse(
                OpenAIResponsesTranslator.fromResponse(response),
            ),
        ).toEqual(response);
    });

    test("multi-message responses preserve output item status and content metadata", () => {
        const response = {
            id: "resp_complex",
            object: "response",
            created_at: 1783049002,
            status: "completed",
            model: "gpt-4o-mini",
            output: [
                {
                    id: "msg_1",
                    type: "message",
                    status: "in_progress",
                    role: "assistant",
                    content: [
                        {
                            type: "output_text",
                            text: "first",
                            annotations: [
                                {
                                    type: "url_citation",
                                    url: "https://example.com/1",
                                },
                            ],
                            logprobs: [{ token: "first", logprob: -0.1 }],
                        },
                    ],
                },
                {
                    id: "msg_2",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [
                        {
                            type: "output_text",
                            text: "second",
                            annotations: [
                                {
                                    type: "url_citation",
                                    url: "https://example.com/2",
                                },
                            ],
                            logprobs: [{ token: "second", logprob: -0.2 }],
                        },
                    ],
                },
            ],
            usage: {
                input_tokens: 3,
                input_tokens_details: {
                    cached_tokens: 0,
                    cache_write_tokens: 0,
                },
                output_tokens: 2,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 5,
            },
            incomplete_details: null,
        };

        expect(
            OpenAIResponsesTranslator.toResponse(
                OpenAIResponsesTranslator.fromResponse(response),
            ),
        ).toEqual(response);
    });

    test("content_filter incomplete responses raise a core stop reason", () => {
        const program = OpenAIResponsesTranslator.fromResponse({
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
        });

        expect(program).toContainEqual({
            op: "response.stop",
            reason: "content_filter",
        });
    });

    test("unknown incomplete response reasons halt instead of disappearing", () => {
        expect(() =>
            OpenAIResponsesTranslator.fromResponse({
                id: "resp_unknown",
                object: "response",
                created_at: 1783049004,
                status: "incomplete",
                model: "gpt-4o-mini",
                output: [
                    {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "" }],
                    },
                ],
                incomplete_details: { reason: "server_tool_timeout" },
            }),
        ).toThrow(LintError);
    });

    test("unrepresentable stop reasons do not lower to max_output_tokens", () => {
        for (const reason of [
            "pause_turn",
            "model_context_window_exceeded",
        ] as const) {
            expect(() =>
                OpenAIResponsesTranslator.toResponse([
                    { op: "llm.model", model: "gpt-4o-mini" },
                    {
                        op: "llm.text",
                        role: "assistant",
                        content: "still working",
                    },
                    { op: "response.stop", reason },
                ]),
            ).toThrow(LintError);
        }
    });

    test("stale output metadata mismatches halt instead of synthesizing wrong wire", () => {
        expect(() =>
            OpenAIResponsesTranslator.toResponse([
                { op: "llm.model", model: "gpt-4o-mini" },
                { op: "llm.text", role: "assistant", content: "first" },
                {
                    op: "llm.text",
                    role: "assistant",
                    content: "unexpected extra text",
                },
                {
                    op: "openai_responses.output_meta",
                    item: {
                        type: "message",
                        role: "assistant",
                        content: [
                            {
                                type: "output_text",
                                text: "first",
                                annotations: [],
                                logprobs: [],
                            },
                        ],
                    },
                    appliesTo: "response",
                },
            ]),
        ).toThrow(LintError);
    });

    test("function_call output without an item id round-trips without generating one", () => {
        const body = {
            id: "resp_no_item_id",
            object: "response",
            created_at: 1783049001,
            status: "completed",
            model: "gpt-4o-mini",
            output: [
                {
                    type: "function_call",
                    status: "completed",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            ],
        };

        expect(
            OpenAIResponsesTranslator.toResponse(
                OpenAIResponsesTranslator.fromResponse(body),
            ),
        ).toEqual(body);
    });

    test("function_call output separates call and item ids and round-trips", () => {
        const body = {
            id: "resp_456",
            object: "response",
            created_at: 1783049001,
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
            usage: {
                input_tokens: 10,
                input_tokens_details: {
                    cached_tokens: 0,
                    cache_write_tokens: 0,
                },
                output_tokens: 4,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: 14,
            },
            incomplete_details: null,
        };
        const program = OpenAIResponsesTranslator.fromResponse(body);

        expect(program).toContainEqual({
            op: "llm.tool_call",
            id: "call_1",
            name: "get_weather",
            arguments: { city: "Paris" },
        });
        expect(program).toContainEqual({
            op: "openai_responses.function_call_item",
            of: "call_1",
            itemId: "fc_123",
        });
        expect(program).toContainEqual({
            op: "response.stop",
            reason: "tool_use",
        });
        expect(OpenAIResponsesTranslator.toResponse(program)).toEqual(body);

        const gemini = GeminiTranslator.toResponse(program) as {
            candidates: {
                content: { parts: { functionCall: Record<string, unknown> }[] };
            }[];
        };
        expect(gemini.candidates[0]!.content.parts).toEqual([
            {
                functionCall: {
                    name: "get_weather",
                    args: { city: "Paris" },
                    id: "call_1",
                },
            },
        ]);
    });
});
