import { describe, expect, test } from "bun:test";
import {
    lowerRequestTexts,
    lowerToolCalls,
    lowerToolResults,
    applyRequestMessageMeta,
    mergeToolCallMessages,
    lowerStopReasons,
    lowerUsageCounts,
    collectAssistantMessage,
} from "../../../src/dialects/openai_chat/lower";

describe("openai_chat lower request stages", () => {
    test("lowerRequestTexts turns an llm.text op into a wire message", () => {
        const program = lowerRequestTexts([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: { role: "user", content: "hi" },
            },
        ]);
    });

    test("lowerToolCalls turns an llm.tool_call op into a bare assistant message with one wire tool call", () => {
        const program = lowerToolCalls([
            { op: "llm.model", model: "m" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "list_invoices",
                arguments: { customer_id: "c_9" },
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: {
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
            },
        ]);
    });

    test("lowerToolResults turns an llm.tool_result op into a tool-role wire message", () => {
        const program = lowerToolResults([
            { op: "llm.model", model: "m" },
            { op: "llm.tool_result", id: "call_1", content: '["INV-7"]' },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: {
                    role: "tool",
                    tool_call_id: "call_1",
                    content: '["INV-7"]',
                },
            },
        ]);
    });

    test("applyRequestMessageMeta folds developer-role meta into the message op it follows", () => {
        const program = applyRequestMessageMeta([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: { role: "system", content: "policy" },
            },
            {
                op: "openai_chat.message_meta",
                message: { role: "developer" },
                appliesTo: "request",
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: { role: "developer", content: "policy" },
            },
        ]);
    });

    test("mergeToolCallMessages folds a tool-calls-only assistant message into the preceding assistant message", () => {
        const program = mergeToolCallMessages([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: { role: "assistant", content: "checking" },
            },
            {
                op: "openai_chat.message",
                message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: { name: "f", arguments: "{}" },
                        },
                    ],
                },
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: {
                    role: "assistant",
                    content: "checking",
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: { name: "f", arguments: "{}" },
                        },
                    ],
                },
            },
        ]);
    });
});

describe("openai_chat lower response stages", () => {
    test("lowerStopReasons maps response.stop onto the wire finish_reason string", () => {
        const program = lowerStopReasons([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "tool_use" },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            { op: "openai_chat.finish_reason", value: "tool_calls" },
        ]);
    });

    test("lowerUsageCounts sums the core parts into the wire totals and writes the optional details only for present parts", () => {
        const program = lowerUsageCounts([
            { op: "llm.model", model: "m" },
            {
                op: "response.usage",
                inputTokens: 52,
                cacheReadTokens: 2048,
                cacheWriteTokens: 500,
                toolUsePromptTokens: 33,
                outputTokens: 57,
                reasoningTokens: 40,
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.usage",
                usage: {
                    prompt_tokens: 2633,
                    prompt_tokens_details: {
                        cached_tokens: 2048,
                        cache_write_tokens: 500,
                    },
                    completion_tokens: 97,
                    completion_tokens_details: { reasoning_tokens: 40 },
                    total_tokens: 2730,
                },
            },
        ]);
    });

    test("lowerUsageCounts omits a total whose sums are not both known", () => {
        const program = lowerUsageCounts([
            { op: "response.usage", outputTokens: 9 },
        ]);

        expect(program).toEqual([
            {
                op: "openai_chat.usage",
                usage: { completion_tokens: 9 },
            },
        ]);
    });

    test("collectAssistantMessage collapses text, tool calls, and meta from the whole response into one wire message", () => {
        const program = collectAssistantMessage([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "checking" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "list_invoices",
                arguments: { customer_id: "c_9" },
            },
            {
                op: "openai_chat.message_meta",
                message: { annotations: [] },
                appliesTo: "response",
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: {
                    role: "assistant",
                    content: "checking",
                    annotations: [],
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
            },
        ]);
    });
});
