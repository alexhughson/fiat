// Executable documentation for the openai_chat dialect: what each wire
// payload looks like as a core-IR program, and that the mapping round-trips.

import { describe, expect, test } from "bun:test";
import { LintError, OpenAIChatTranslator } from "../../../src/index";

describe("openai_chat requests", () => {
    test("a chat body becomes a flat program of core ops", () => {
        const program = OpenAIChatTranslator.fromBody({
            model: "gpt-4o",
            temperature: 0.2,
            max_tokens: 800,
            messages: [
                { role: "system", content: "You are an omniscient AI" },
                { role: "user", content: "Hello" },
                { role: "assistant", content: "I am an omniscient ai" },
            ],
        });

        expect(program).toEqual([
            { op: "llm.model", model: "gpt-4o" },
            { op: "llm.temperature", value: 0.2 },
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

    test("core programs serialize back to the same wire body", () => {
        const body = {
            model: "gpt-4o",
            messages: [{ role: "user", content: "What's on invoice INV-7?" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "list_invoices",
                        description: "List customer invoices.",
                        parameters: {
                            type: "object",
                            properties: { customer_id: { type: "string" } },
                        },
                    },
                },
            ],
            tool_choice: "auto",
        };

        expect(
            OpenAIChatTranslator.toBody(OpenAIChatTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("image URL parts raise to portable image ops and round-trip", () => {
        const body = {
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "what is this?" },
                        {
                            type: "image_url",
                            image_url: {
                                url: "https://example.com/invoice.png",
                            },
                        },
                        { type: "text", text: "answer briefly" },
                    ],
                },
            ],
        };

        expect(OpenAIChatTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o" },
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
            OpenAIChatTranslator.toBody(OpenAIChatTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("image data URLs normalize to portable base64 and lower back to data URLs", () => {
        const body = {
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: "data:image/png;base64,aW1hZ2U=",
                            },
                        },
                    ],
                },
            ],
        };

        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.image",
            role: "user",
            source: {
                type: "base64",
                mediaType: "image/png",
                data: "aW1hZ2U=",
            },
        });
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("image metadata fails loudly until a dialect image meta op exists", () => {
        expect(() =>
            OpenAIChatTranslator.fromBody({
                model: "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: "https://example.com/invoice.png",
                                    detail: "high",
                                },
                            },
                        ],
                    },
                ],
            }),
        ).toThrow("unsupported fields detail");
    });

    test("non-image data URLs do not enter the portable image op", () => {
        expect(() =>
            OpenAIChatTranslator.fromBody({
                model: "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: "data:application/pdf;base64,cGRm",
                                },
                            },
                        ],
                    },
                ],
            }),
        ).toThrow("expected an image/* data URL");
    });

    test("shared request controls round-trip through core ops", () => {
        const body = {
            model: "gpt-5.5",
            user: "user-123",
            stream: true,
            stop: ["</stop>"],
            reasoning_effort: "high",
            messages: [{ role: "user", content: "hi" }],
        };

        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "request.user",
            value: "user-123",
        });
        expect(program).toContainEqual({ op: "request.stream", value: true });
        expect(program).toContainEqual({
            op: "request.stop_sequences",
            value: ["</stop>"],
        });
        expect(program).toContainEqual({ op: "llm.thinking", effort: "high" });
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("gpt-5 chat serializes max output tokens as max_completion_tokens", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-5.5" },
                { op: "llm.max_output_tokens", value: 800 },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "gpt-5.5",
            max_completion_tokens: 800,
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("reasoning chat models lower system text as developer messages", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-5.4" },
                { op: "llm.text", role: "system", content: "Use policy." },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "gpt-5.4",
            messages: [
                { role: "developer", content: "Use policy." },
                { role: "user", content: "hi" },
            ],
        });
    });

    test("o-series chat serializes max output tokens as max_completion_tokens", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "o3-mini" },
                { op: "llm.max_output_tokens", value: 800 },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "o3-mini",
            max_completion_tokens: 800,
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("max_completion_tokens round-trips for models that require it", () => {
        const body = {
            model: "o4-mini",
            max_completion_tokens: 800,
            messages: [{ role: "user", content: "hi" }],
        };

        expect(
            OpenAIChatTranslator.toBody(OpenAIChatTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("older chat models still serialize max output tokens as max_tokens", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-4o" },
                { op: "llm.max_output_tokens", value: 800 },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "gpt-4o",
            max_tokens: 800,
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("json_schema response_format extras are preserved as OpenAI residuals", () => {
        const body = {
            model: "gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "answer",
                    schema: { type: "object" },
                    strict: true,
                },
            },
        };

        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.output",
            format: "json_schema",
            name: "answer",
            schema: { type: "object" },
        });
        expect(program).toContainEqual({
            op: "openai_chat.response_format",
            value: body.response_format,
        });
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("gpt-5.5 chat omits reasoning_effort when function tools are present", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-5.5" },
                { op: "llm.thinking", effort: "medium" },
                {
                    op: "llm.tool",
                    name: "read_file",
                    inputSchema: { type: "object" },
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "gpt-5.5",
            messages: [{ role: "user", content: "hi" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "read_file",
                        parameters: { type: "object" },
                    },
                },
            ],
        });
    });

    test("developer request messages round-trip as developer", () => {
        const body = {
            model: "gpt-4o",
            messages: [
                { role: "developer", content: "Use the billing policy." },
                { role: "user", content: "Was I double charged?" },
            ],
        };

        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "openai_chat.message_meta",
            message: { role: "developer" },
            appliesTo: "request",
        });
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("a multi-part developer message keeps developer on every lowered message", () => {
        // Multi-part content raises to one llm.text per part (parts become
        // separate messages by canonicalization), so the developer role meta
        // repeats after each part — otherwise only the last would lower as
        // developer and the rest would silently fall back to system.
        const body = {
            model: "gpt-4o",
            messages: [
                {
                    role: "developer",
                    content: [
                        { type: "text", text: "policy a" },
                        { type: "text", text: "policy b" },
                    ],
                },
                { role: "user", content: "hi" },
            ],
        };

        expect(
            OpenAIChatTranslator.toBody(OpenAIChatTranslator.fromBody(body)),
        ).toEqual({
            model: "gpt-4o",
            messages: [
                { role: "developer", content: "policy a" },
                { role: "developer", content: "policy b" },
                { role: "user", content: "hi" },
            ],
        });
    });

    test("tool calls flatten to llm.tool_call with parsed arguments, and regroup on the way out", () => {
        const body = {
            model: "gpt-4o",
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
                { role: "tool", tool_call_id: "call_1", content: '["INV-7"]' },
            ],
            tools: [],
        };

        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toEqual([
            { op: "llm.model", model: "gpt-4o" },
            { op: "llm.text", role: "user", content: "Check my invoices" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "list_invoices",
                arguments: { customer_id: "c_9" },
            },
            { op: "llm.tool_result", id: "call_1", content: '["INV-7"]' },
        ]);

        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("tool history replay without current tools serializes an empty tools array", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-4o" },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "read_file",
                    arguments: { path: "a.txt" },
                },
                {
                    op: "llm.tool_result",
                    id: "call_1",
                    content: "contents",
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "gpt-4o",
            messages: [
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: {
                                name: "read_file",
                                arguments: '{"path":"a.txt"}',
                            },
                        },
                    ],
                },
                {
                    role: "tool",
                    tool_call_id: "call_1",
                    content: "contents",
                },
                { role: "user", content: "hi" },
            ],
            tools: [],
        });
    });

    test("Responses-style item ids are stripped from Chat tool call ids", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-4o" },
                {
                    op: "llm.tool_call",
                    id: "call_1|fc_abcdefghijklmnopqrstuvwxyz",
                    name: "read_file",
                    arguments: { path: "a.txt" },
                },
                {
                    op: "llm.tool_result",
                    id: "call_1|fc_abcdefghijklmnopqrstuvwxyz",
                    content: "contents",
                },
            ]),
        ).toMatchObject({
            messages: [
                {
                    tool_calls: [
                        {
                            id: "call_1",
                        },
                    ],
                },
                {
                    tool_call_id: "call_1",
                },
            ],
        });
    });

    test("overlong tool call ids are truncated to Chat's limit", () => {
        const longId = `call_${"x".repeat(80)}`;

        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-4o" },
                {
                    op: "llm.tool_call",
                    id: longId,
                    name: "read_file",
                    arguments: { path: "a.txt" },
                },
            ]),
        ).toMatchObject({
            messages: [
                {
                    tool_calls: [
                        {
                            id: longId.slice(0, 40),
                        },
                    ],
                },
            ],
        });
    });

    test("parallel tool calls lower into one assistant message", () => {
        const body = OpenAIChatTranslator.toBody([
            { op: "llm.model", model: "gpt-4o" },
            { op: "llm.tool_call", id: "call_1", name: "first", arguments: {} },
            {
                op: "llm.tool_call",
                id: "call_2",
                name: "second",
                arguments: { ok: true },
            },
        ]);

        expect(body).toEqual({
            model: "gpt-4o",
            messages: [
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: { name: "first", arguments: "{}" },
                        },
                        {
                            id: "call_2",
                            type: "function",
                            function: {
                                name: "second",
                                arguments: '{"ok":true}',
                            },
                        },
                    ],
                },
            ],
            tools: [],
        });
    });

    test("empty string content is represented, not dropped", () => {
        const body = {
            model: "gpt-4o",
            messages: [{ role: "user", content: "" }],
        };

        expect(OpenAIChatTranslator.fromBody(body)).toEqual([
            { op: "llm.model", model: "gpt-4o" },
            { op: "llm.text", role: "user", content: "" },
        ]);
        expect(
            OpenAIChatTranslator.toBody(OpenAIChatTranslator.fromBody(body)),
        ).toEqual(body);
    });

    test("unmapped body keys survive as openai_chat.body_field residuals and round-trip", () => {
        const body = {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            logit_bias: { "50256": -100 },
        };

        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "openai_chat.body_field",
            key: "logit_bias",
            value: { "50256": -100 },
        });
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("legacy response envelope params do not leak into request bodies", () => {
        const body = OpenAIChatTranslator.toBody([
            { op: "llm.model", model: "gpt-4o" },
            { op: "llm.text", role: "user", content: "hi" },
            {
                op: "openai_chat.body_field",
                key: "id",
                value: "chatcmpl-legacy",
            },
            { op: "openai_chat.body_field", key: "user", value: "user-1234" },
        ]);

        expect(body).toEqual({
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            user: "user-1234",
        });
    });

    test("malformed tool call arguments halt instead of degrading", () => {
        expect(() =>
            OpenAIChatTranslator.fromBody({
                model: "gpt-4o",
                messages: [
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: { name: "f", arguments: "{oops" },
                            },
                        ],
                    },
                ],
            }),
        ).toThrow("not valid JSON");
    });
});

describe("openai_chat responses", () => {
    const wireResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: "No, it is correct." },
                finish_reason: "stop",
                logprobs: null,
            },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
    };

    test("a response raises to the same op vocabulary as requests", () => {
        // Op order follows wire key order; envelope params are born droppable.
        expect(OpenAIChatTranslator.fromResponse(wireResponse)).toEqual([
            { op: "response.id", id: "chatcmpl-123" },
            {
                op: "openai_chat.body_field",
                key: "object",
                value: "chat.completion",
                appliesTo: "response",
            },
            {
                op: "openai_chat.body_field",
                key: "created",
                value: 1700000000,
                appliesTo: "response",
            },
            { op: "llm.model", model: "gpt-4o" },
            {
                op: "llm.text",
                role: "assistant",
                content: "No, it is correct.",
            },
            { op: "response.stop", reason: "end_turn" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
            // Vendor-specific counts stay in the stream as an ignorable residual:
            // other dialects drop it, openai_chat merges it back into wire usage.
            {
                op: "openai_chat.usage",
                usage: { total_tokens: 29 },
                appliesTo: "response",
            },
        ]);
    });

    test("responses round-trip", () => {
        const program = OpenAIChatTranslator.fromResponse(wireResponse);
        expect(OpenAIChatTranslator.toResponse(program)).toEqual(wireResponse);
    });

    test("usage with cache read tokens and response id round-trip", () => {
        const response = {
            id: "chatcmpl-cache",
            object: "chat.completion",
            created: 1700000000,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "cached" },
                    finish_reason: "stop",
                    logprobs: null,
                },
            ],
            usage: {
                prompt_tokens: 1200,
                completion_tokens: 40,
                total_tokens: 1240,
                prompt_tokens_details: { cached_tokens: 1152 },
            },
        };

        const program = OpenAIChatTranslator.fromResponse(response);
        expect(program).toContainEqual({
            op: "response.id",
            id: "chatcmpl-cache",
        });
        expect(program).toContainEqual({
            op: "response.usage",
            inputTokens: 1200,
            outputTokens: 40,
            cacheReadTokens: 1152,
        });
        expect(OpenAIChatTranslator.toResponse(program)).toEqual(response);
    });

    test("usage prompt_tokens_details with cache and audio tokens round-trip", () => {
        const response = {
            id: "chatcmpl-cache-audio",
            object: "chat.completion",
            created: 1700000000,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "cached" },
                    finish_reason: "stop",
                    logprobs: null,
                },
            ],
            usage: {
                prompt_tokens: 1200,
                completion_tokens: 40,
                total_tokens: 1240,
                prompt_tokens_details: {
                    cached_tokens: 1152,
                    audio_tokens: 0,
                },
            },
        };

        const program = OpenAIChatTranslator.fromResponse(response);
        expect(OpenAIChatTranslator.toResponse(program)).toEqual(response);
    });

    test("response-only assistant metadata round-trips without leaking into requests", () => {
        const response = {
            id: "chatcmpl-refusal",
            object: "chat.completion",
            created: 1700000001,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        refusal: "cannot",
                        annotations: [
                            {
                                type: "url_citation",
                                url: "https://example.com",
                            },
                        ],
                        audio: { id: "audio_1" },
                    },
                    finish_reason: "stop",
                    logprobs: null,
                },
            ],
        };

        const program = OpenAIChatTranslator.fromResponse(response);
        expect(OpenAIChatTranslator.toResponse(program)).toEqual(response);
        expect(program).toContainEqual({
            op: "llm.text",
            role: "assistant",
            content: "cannot",
        });
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-4o" },
                { op: "llm.text", role: "assistant", content: "cannot" },
                {
                    op: "openai_chat.message_meta",
                    message: {
                        refusal: "cannot",
                        annotations: [{ type: "url_citation" }],
                        audio: { id: "audio_1" },
                    },
                    appliesTo: "response",
                },
            ]),
        ).toEqual({
            model: "gpt-4o",
            messages: [{ role: "assistant", content: "cannot" }],
        });
    });

    test("stale refusal metadata does not synthesize conflicting response wire", () => {
        expect(() =>
            OpenAIChatTranslator.toResponse([
                { op: "llm.model", model: "gpt-4o" },
                { op: "llm.text", role: "assistant", content: "changed text" },
                {
                    op: "openai_chat.message_meta",
                    message: { refusal: "cannot", content: null },
                    appliesTo: "response",
                },
            ]),
        ).toThrow(LintError);
    });

    test("content_filter finish_reason has a core stop reason", () => {
        const program = OpenAIChatTranslator.fromResponse({
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: null },
                    finish_reason: "content_filter",
                },
            ],
        });

        expect(program).toContainEqual({
            op: "response.stop",
            reason: "content_filter",
        });
    });

    test("unrepresentable stop reasons do not lower to length", () => {
        expect(() =>
            OpenAIChatTranslator.toResponse([
                { op: "llm.model", model: "gpt-4o" },
                { op: "llm.text", role: "assistant", content: "still working" },
                {
                    op: "response.stop",
                    reason: "model_context_window_exceeded",
                },
            ]),
        ).toThrow(LintError);
    });
});
