// Executable documentation for each openai_chat raise/lower stage in
// isolation — one happy-path test per stage function, showing exactly what
// that stage rewrites and that everything else passes through untouched.
// Pipeline-level (fromBody/toBody round-trip) behavior lives in
// openai_chat.test.ts; this file is about the individual stages.

import { describe, expect, test } from "bun:test";
import {
    raiseMessages,
    raiseFinishReasons,
    raiseUsage,
} from "../../../src/dialects/openai_chat/raise";
import {
    lowerRequest,
    lowerRequestTexts,
    lowerToolCalls,
    lowerToolResults,
    applyRequestMessageMeta,
    mergeToolCallMessages,
    lowerStopReasons,
    lowerUsageCounts,
    collectAssistantMessage,
} from "../../../src/dialects/openai_chat/lower";

describe("raise stages", () => {
    test("raiseMessages flattens a wire message into its core ops", () => {
        const program = raiseMessages([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: { role: "user", content: "hi" },
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);
    });

    test("raiseFinishReasons maps the wire finish_reason string onto response.stop", () => {
        const program = raiseFinishReasons([
            { op: "llm.model", model: "m" },
            { op: "openai_chat.finish_reason", value: "stop" },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("raiseUsage splits cross-provider counts onto response.usage, keeping the rest as a droppable residual", () => {
        const program = raiseUsage([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.usage",
                usage: {
                    prompt_tokens: 20,
                    completion_tokens: 9,
                    total_tokens: 29,
                },
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
            {
                op: "openai_chat.usage",
                usage: { total_tokens: 29 },
                required: false,
            },
        ]);
    });
});

describe("lower request stages", () => {
    test("lowerRequest lowers core request ops and leaves Anthropic residuals for residual policy", () => {
        const program = lowerRequest([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
            {
                op: "anthropic_messages.text_meta",
                fields: { cache_control: { type: "ephemeral" } },
                required: false,
            },
            { op: "request.user", value: "user-123" },
            { op: "llm.thinking", effort: "medium" },
            { op: "request.stream", value: true },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.message",
                message: { role: "user", content: "hi" },
            },
            {
                op: "anthropic_messages.text_meta",
                fields: { cache_control: { type: "ephemeral" } },
                required: false,
            },
            { op: "request.user", value: "user-123" },
            { op: "llm.thinking", effort: "medium" },
            { op: "request.stream", value: true },
        ]);
    });

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
                required: false,
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

describe("lower response stages", () => {
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

    test("lowerUsageCounts renames the core count fields onto wire usage field names", () => {
        const program = lowerUsageCounts([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.usage",
                usage: { prompt_tokens: 20, completion_tokens: 9 },
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
                required: false,
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
