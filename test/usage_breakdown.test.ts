// Executable documentation for the response.usage reshape: core holds the
// token-count parts, and each dialect computes its own totals from them. The
// numbers throughout are the worked examples of the row 10 design: a response
// whose usage holds 52 fresh input tokens, 2048 tokens read from the cache,
// 500 tokens written to the cache, 57 plain output tokens, and 40 reasoning
// tokens; and the Gemini tool-use example with 33 tool-use prompt tokens.

import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
} from "../src/index";

// The response body Anthropic's Messages API returns to a proxy which fronts
// Anthropic for chat clients: the same bill anthropic reports natively.
const anthropicBody = {
    id: "msg_usage",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "hi there" }],
    stop_reason: "end_turn",
    usage: {
        input_tokens: 52,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 2048,
        output_tokens: 97,
        output_tokens_details: { thinking_tokens: 40 },
    },
};

// The response body OpenAI's Chat Completions API returns to a proxy which
// fronts OpenAI: the same bill in chat's shape, totals with details inside.
const chatBody = {
    id: "chatcmpl_usage",
    object: "chat.completion",
    created: 1783049000,
    model: "gpt-5.2",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "hi there" },
            finish_reason: "stop",
            logprobs: null,
        },
    ],
    usage: {
        prompt_tokens: 2600,
        completion_tokens: 97,
        total_tokens: 2697,
        prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 500 },
        completion_tokens_details: { reasoning_tokens: 40 },
    },
};

// The response body OpenAI's Responses API returns to a proxy which fronts
// OpenAI: the same bill under the Responses field names.
const responsesBody = {
    id: "resp_usage",
    object: "response",
    created_at: 1783049000,
    status: "completed",
    model: "gpt-5.2",
    output: [
        {
            type: "message",
            id: "msg_usage",
            status: "completed",
            role: "assistant",
            content: [
                { type: "output_text", text: "hi there", annotations: [] },
            ],
        },
    ],
    usage: {
        input_tokens: 2600,
        input_tokens_details: { cached_tokens: 2048, cache_write_tokens: 500 },
        output_tokens: 97,
        output_tokens_details: { reasoning_tokens: 40 },
        total_tokens: 2697,
    },
};

// The response body OpenAI's Realtime API returns inside its response.done
// event: the realtime guide's own numbers, with the modality breakdowns.
const realtimeBody = {
    events: [
        {
            type: "response.done",
            response: {
                id: "resp_usage",
                object: "realtime.response",
                status: "completed",
                model: "gpt-realtime",
                output: [
                    {
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "hi there" }],
                    },
                ],
                usage: {
                    input_tokens: 132,
                    input_token_details: {
                        cached_tokens: 64,
                        text_tokens: 68,
                    },
                    output_tokens: 121,
                    output_token_details: { text_tokens: 121 },
                    total_tokens: 253,
                },
            },
        },
    ],
};

// The response body Gemini's API returns to a proxy which fronts Gemini:
// the tool-use example, with the tool-use prompt tokens beside the totals.
const geminiBody = {
    responseId: "resp_usage",
    model: "gemini-2.5-pro",
    candidates: [
        {
            content: { role: "model", parts: [{ text: "hi there" }] },
            finishReason: "STOP",
        },
    ],
    usageMetadata: {
        promptTokenCount: 2600,
        cachedContentTokenCount: 2048,
        toolUsePromptTokenCount: 33,
        thoughtsTokenCount: 40,
        candidatesTokenCount: 57,
        totalTokenCount: 2730,
    },
};

// The core program the first four bodies raise to: the parts, no total.
const usageCounts = {
    op: "response.usage",
    inputTokens: 52,
    cacheReadTokens: 2048,
    cacheWriteTokens: 500,
    outputTokens: 57,
    reasoningTokens: 40,
} as const;
const usageProgram = [usageCounts];

describe("usage breakdown home round trips", () => {
    test("anthropic_messages: the wire reports every part, so the program holds all five and the body comes back identical", () => {
        const program = AnthropicTranslator.fromResponse(anthropicBody);
        expect(program).toContainEqual({
            op: "response.usage",
            inputTokens: 52,
            cacheReadTokens: 2048,
            cacheWriteTokens: 500,
            outputTokens: 57,
            reasoningTokens: 40,
        });
        expect(AnthropicTranslator.toResponse(program)).toEqual(anthropicBody);
    });

    test("openai_chat: the totals fold the parts back in, so the body comes back identical", () => {
        const program = OpenAIChatTranslator.fromResponse(chatBody);
        expect(program).toContainEqual(usageCounts);
        expect(OpenAIChatTranslator.toResponse(program)).toEqual(chatBody);
    });

    test("openai_responses: the totals fold the parts back in, so the body comes back identical", () => {
        const program = OpenAIResponsesTranslator.fromResponse(responsesBody);
        expect(program).toContainEqual(usageCounts);
        expect(OpenAIResponsesTranslator.toResponse(program)).toEqual(
            responsesBody,
        );
    });

    test("openai_realtime: the cached detail splits out, the modality fields stay in a residual, and the body comes back identical", () => {
        const program = OpenAIRealtimeTranslator.fromResponse(realtimeBody);
        expect(program).toContainEqual({
            op: "response.usage",
            inputTokens: 68,
            cacheReadTokens: 64,
            outputTokens: 121,
        });
        expect(OpenAIRealtimeTranslator.toResponse(program)).toEqual(
            realtimeBody,
        );
    });

    test("gemini: the tool-use prompt count travels in the core op, and the body comes back identical", () => {
        const program = GeminiTranslator.fromResponse(geminiBody);
        expect(program).toContainEqual({
            op: "response.usage",
            inputTokens: 552,
            cacheReadTokens: 2048,
            toolUsePromptTokens: 33,
            outputTokens: 57,
            reasoningTokens: 40,
        });
        expect(GeminiTranslator.toResponse(program)).toEqual(geminiBody);
    });
});

describe("usage breakdown across dialects", () => {
    test("the worked program lowers to anthropic_messages and chat, and both raise the same parts back", () => {
        const anthropic = AnthropicTranslator.toResponse(
            usageProgram,
        ) as Record<string, unknown>;
        expect(anthropic.usage).toEqual({
            input_tokens: 52,
            cache_read_input_tokens: 2048,
            cache_creation_input_tokens: 500,
            output_tokens: 97,
            output_tokens_details: { thinking_tokens: 40 },
        });

        const chat = OpenAIChatTranslator.toResponse(usageProgram) as Record<
            string,
            unknown
        >;
        expect(chat.usage).toEqual({
            prompt_tokens: 2600,
            prompt_tokens_details: {
                cached_tokens: 2048,
                cache_write_tokens: 500,
            },
            completion_tokens: 97,
            completion_tokens_details: { reasoning_tokens: 40 },
            total_tokens: 2697,
        });

        expect(AnthropicTranslator.fromResponse(anthropic)).toContainEqual(
            usageCounts,
        );
        expect(OpenAIChatTranslator.fromResponse(chat)).toContainEqual(
            usageCounts,
        );
    });

    test("an Anthropic response lowered to the chat body the proxy hands its client keeps every shared count", () => {
        const chat = OpenAIChatTranslator.toResponse(
            AnthropicTranslator.fromResponse(anthropicBody),
        ) as Record<string, unknown>;
        expect(chat.usage).toEqual(chatBody.usage);
    });

    test("a chat response lowered to the Anthropic body the proxy hands its client keeps every shared count", () => {
        const anthropic = AnthropicTranslator.toResponse(
            OpenAIChatTranslator.fromResponse(chatBody),
        ) as Record<string, unknown>;
        expect(anthropic.usage).toEqual(anthropicBody.usage);
    });

    test("the worked program lowered to gemini loses the cache-write part to the prompt total, and the raise names it unknown", () => {
        const gemini = GeminiTranslator.toResponse(usageProgram) as Record<
            string,
            unknown
        >;
        expect(gemini.usageMetadata).toEqual({
            promptTokenCount: 2600,
            cachedContentTokenCount: 2048,
            candidatesTokenCount: 57,
            thoughtsTokenCount: 40,
            totalTokenCount: 2697,
        });
        expect(GeminiTranslator.fromResponse(gemini)).toContainEqual({
            op: "response.usage",
            inputTokens: 552,
            cacheReadTokens: 2048,
            outputTokens: 57,
            reasoningTokens: 40,
        });
    });

    test("the worked program lowered to openai_realtime loses the cache-write and reasoning parts to the totals, and the raise names them unknown", () => {
        const realtime = OpenAIRealtimeTranslator.toResponse([
            { op: "llm.text", role: "assistant", content: "hi there" },
            ...usageProgram,
        ]) as { events: { response: { usage: unknown } }[] };
        expect(realtime.events[0]!.response.usage).toEqual({
            input_tokens: 2600,
            input_token_details: { cached_tokens: 2048 },
            output_tokens: 97,
            total_tokens: 2697,
        });
        expect(OpenAIRealtimeTranslator.fromResponse(realtime)).toContainEqual({
            op: "response.usage",
            inputTokens: 552,
            cacheReadTokens: 2048,
            outputTokens: 97,
        });
    });

    test("a gemini response lowered to the chat body folds the tool-use prompt count into the prompt total", () => {
        const chat = OpenAIChatTranslator.toResponse(
            GeminiTranslator.fromResponse(geminiBody),
        ) as Record<string, unknown>;
        expect(chat.usage).toEqual({
            prompt_tokens: 2633,
            prompt_tokens_details: { cached_tokens: 2048 },
            completion_tokens: 97,
            completion_tokens_details: { reasoning_tokens: 40 },
            total_tokens: 2730,
        });
        // Chat's wire has no tool-use field, so the 33 no longer separates on
        // the way back up, and chat's reference defaults the missing
        // cache_write_tokens key to a reported zero.
        expect(OpenAIChatTranslator.fromResponse(chat)).toContainEqual({
            op: "response.usage",
            inputTokens: 585,
            cacheReadTokens: 2048,
            cacheWriteTokens: 0,
            outputTokens: 57,
            reasoningTokens: 40,
        });
    });
});

describe("usage totals are derived, never carried", () => {
    test("a gemini body whose totalTokenCount disagrees with its parts loses the disagreeing total on the way through", () => {
        const disagreeing = {
            ...geminiBody,
            usageMetadata: {
                ...geminiBody.usageMetadata,
                totalTokenCount: 9999,
            },
        };
        const roundTripped = GeminiTranslator.toResponse(
            GeminiTranslator.fromResponse(disagreeing),
        ) as Record<string, unknown>;
        expect(roundTripped.usageMetadata).toEqual(geminiBody.usageMetadata);
    });

    test("a chat body whose total_tokens disagrees with its parts loses the disagreeing total on the way through", () => {
        const disagreeing = {
            ...chatBody,
            usage: { ...chatBody.usage, total_tokens: 9999 },
        };
        const roundTripped = OpenAIChatTranslator.toResponse(
            OpenAIChatTranslator.fromResponse(disagreeing),
        ) as Record<string, unknown>;
        expect(roundTripped.usage).toEqual(chatBody.usage);
    });
});
