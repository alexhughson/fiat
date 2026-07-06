import { describe, expect, test } from "bun:test";
import type { Op } from "../../../src/core/ops";
import {
    collectOutputItems,
    lintMidConversationSystem,
    lowerRequestTexts,
    collectRequestItems,
    lowerStopReasons,
    lowerToolCalls,
    lowerToolResults,
    lowerUsageCounts,
    rejectSessionConfig,
} from "../../../src/dialects/openai_realtime/lower";

const residual: Op = { op: "openai_realtime.body_field", key: "x", value: 1 };

describe("openai_realtime lower request stages", () => {
    test("rejectSessionConfig allows request data that has no session-only config", () => {
        expect(
            rejectSessionConfig([{ op: "llm.model", model: "gpt-realtime" }]),
        ).toEqual([{ op: "llm.model", model: "gpt-realtime" }]);
    });

    test("lintMidConversationSystem passes when system text comes before conversation events", () => {
        const program: Op[] = [
            { op: "llm.text", role: "system", content: "rules" },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        expect(lintMidConversationSystem(program)).toEqual(program);
    });

    test("lowerRequestTexts turns non-system llm.text into a conversation.item.create message event", () => {
        expect(
            lowerRequestTexts([
                { op: "llm.text", role: "system", content: "be terse" },
                { op: "llm.text", role: "user", content: "hi" },
                residual,
            ]),
        ).toEqual([
            { op: "llm.text", role: "system", content: "be terse" },
            {
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "hi" }],
                    },
                },
            },
            residual,
        ]);
    });

    test("lowerToolCalls turns llm.tool_call into a conversation.item.create function_call event", () => {
        expect(
            lowerToolCalls([
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
                residual,
            ]),
        ).toEqual([
            {
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                },
            },
            residual,
        ]);
    });

    test("lowerToolResults turns llm.tool_result into a conversation.item.create function_call_output event", () => {
        expect(
            lowerToolResults([
                { op: "llm.tool_result", id: "call_1", content: "22 degrees" },
                residual,
            ]),
        ).toEqual([
            {
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: "22 degrees",
                    },
                },
            },
            residual,
        ]);
    });

    test("collectRequestItems reapplies realtime item metadata to lowered text", () => {
        expect(
            collectRequestItems([
                {
                    op: "openai_realtime.item",
                    event: {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: "first" }],
                        },
                    },
                },
                {
                    op: "openai_realtime.item",
                    event: {
                        type: "conversation.item.create",
                        item: {
                            type: "message",
                            role: "user",
                            content: [{ type: "input_text", text: "second" }],
                        },
                    },
                },
                {
                    op: "openai_realtime.item_meta",
                    event: {
                        type: "conversation.item.create",
                        event_id: "event_1",
                        item: {
                            type: "message",
                            id: "item_1",
                            role: "user",
                            content: [
                                { type: "input_text", text: "old first" },
                                { type: "input_text", text: "old second" },
                            ],
                        },
                    },
                    appliesTo: "request",
                },
            ]),
        ).toEqual([
            {
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    event_id: "event_1",
                    item: {
                        type: "message",
                        id: "item_1",
                        role: "user",
                        content: [
                            { type: "input_text", text: "first" },
                            { type: "input_text", text: "second" },
                        ],
                    },
                },
            },
        ]);
    });
});

describe("openai_realtime lower response stages", () => {
    test("lowerStopReasons maps response.stop onto the wire finish reason", () => {
        expect(
            lowerStopReasons([
                { op: "response.stop", reason: "max_tokens" },
                residual,
            ]),
        ).toEqual([
            { op: "openai_realtime.finish_reason", reason: "max_tokens" },
            residual,
        ]);
    });

    test("lowerUsageCounts folds response.usage back into an openai_realtime.usage envelope", () => {
        expect(
            lowerUsageCounts([
                { op: "response.usage", inputTokens: 12, outputTokens: 2 },
                residual,
            ]),
        ).toEqual([
            {
                op: "openai_realtime.usage",
                usage: { input_tokens: 12, output_tokens: 2 },
            },
            residual,
        ]);
    });

    test("collectOutputItems closes assistant text at output_meta boundaries and matches tool calls by call_id", () => {
        expect(
            collectOutputItems([
                { op: "llm.text", role: "assistant", content: "pong" },
                {
                    op: "openai_realtime.output_meta",
                    item: {
                        type: "message",
                        id: "item_1",
                        status: "completed",
                    },
                    appliesTo: "response",
                },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
                {
                    op: "openai_realtime.output_meta",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        id: "item_2",
                        status: "completed",
                    },
                    appliesTo: "response",
                },
                residual,
            ]),
        ).toEqual([
            residual,
            {
                op: "openai_realtime.output",
                item: {
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    id: "item_1",
                    content: [{ type: "output_text", text: "pong" }],
                },
            },
            {
                op: "openai_realtime.output",
                item: {
                    type: "function_call",
                    status: "completed",
                    call_id: "call_1",
                    id: "item_2",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            },
        ]);
    });
});
