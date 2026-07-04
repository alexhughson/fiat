// Each raise/lower pipeline for openai_realtime is a list of Stage functions
// (Program -> Program). These tests call one stage at a time and check its
// exact output, so each stage's single job is documented next to its name.
// Pipeline-level round-trips (the full raise/lower composition through
// Translator.toBody/fromBody) live in openai_realtime.test.ts — not repeated
// here.

import { describe, expect, test } from "bun:test";
import type { Op } from "../../../src/core/ops";
import {
    raiseFinishReasons,
    raiseItems,
    raiseOutputs,
    raiseUsage,
} from "../../../src/dialects/openai_realtime/raise";
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

describe("raise stages", () => {
    test("raiseItems unwraps a conversation.item.create message into llm.text, leaving other ops alone", () => {
        const program: Op[] = [
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
        ];

        expect(raiseItems(program)).toEqual([
            { op: "llm.text", role: "user", content: "hi" },
            residual,
        ]);
    });

    test("raiseOutputs turns a response output item into llm.text plus a droppable output_meta residual carrying its id", () => {
        const program: Op[] = [
            {
                op: "openai_realtime.output",
                item: {
                    type: "message",
                    id: "item_1",
                    status: "completed",
                    role: "assistant",
                    content: [{ type: "output_text", text: "pong" }],
                },
            },
            residual,
        ];

        expect(raiseOutputs(program)).toEqual([
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_realtime.output_meta",
                item: { type: "message", id: "item_1", status: "completed" },
                appliesTo: "response",
                required: false,
            },
            residual,
        ]);
    });

    test("raiseFinishReasons maps the wire finish reason onto response.stop", () => {
        const program: Op[] = [
            { op: "openai_realtime.finish_reason", reason: "tool_use" },
            residual,
        ];

        expect(raiseFinishReasons(program)).toEqual([
            { op: "response.stop", reason: "tool_use" },
            residual,
        ]);
    });

    test("raiseUsage splits cross-provider counts onto response.usage and keeps vendor-specific fields as a required:false residual", () => {
        const program: Op[] = [
            {
                op: "openai_realtime.usage",
                usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
            },
            residual,
        ];

        expect(raiseUsage(program)).toEqual([
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            {
                op: "openai_realtime.usage",
                usage: { total_tokens: 14 },
                required: false,
            },
            residual,
        ]);
    });
});

describe("lower request stages", () => {
    test("rejectSessionConfig allows llm.model for realtime calls but still rejects unsupported sampling", () => {
        expect(
            rejectSessionConfig([{ op: "llm.model", model: "gpt-realtime" }]),
        ).toEqual([{ op: "llm.model", model: "gpt-realtime" }]);
        expect(() =>
            rejectSessionConfig([{ op: "llm.temperature", value: 0.2 }]),
        ).toThrow("does not map llm.temperature");
    });

    test("lintMidConversationSystem throws on a system message that arrives after the conversation has started", () => {
        expect(() =>
            lintMidConversationSystem([
                { op: "llm.text", role: "user", content: "hi" },
                { op: "llm.text", role: "system", content: "new rules" },
            ]),
        ).toThrow("cannot lower interleaved system text");
    });

    test("lowerRequestTexts turns non-system llm.text into a conversation.item.create message event, leaving system text for the session instructions slot", () => {
        const program: Op[] = [
            { op: "llm.text", role: "system", content: "be terse" },
            { op: "llm.text", role: "user", content: "hi" },
            residual,
        ];

        expect(lowerRequestTexts(program)).toEqual([
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

    test("lowerToolCalls turns llm.tool_call into a conversation.item.create function_call event with stringified arguments", () => {
        const program: Op[] = [
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            residual,
        ];

        expect(lowerToolCalls(program)).toEqual([
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
        const program: Op[] = [
            { op: "llm.tool_result", id: "call_1", content: "22 degrees" },
            residual,
        ];

        expect(lowerToolResults(program)).toEqual([
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

    test("lowerToolResults rejects an errored tool result because function_call_output has no error flag on the wire", () => {
        expect(() =>
            lowerToolResults([
                {
                    op: "llm.tool_result",
                    id: "call_1",
                    content: "failed",
                    isError: true,
                },
            ]),
        ).toThrow("no error flag");
    });

    test("collectRequestItems reapplies realtime item metadata to lowered text", () => {
        const program: Op[] = [
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
        ];

        expect(collectRequestItems(program)).toEqual([
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

describe("lower response stages", () => {
    test("lowerStopReasons maps response.stop onto the wire finish reason", () => {
        const program: Op[] = [
            { op: "response.stop", reason: "max_tokens" },
            residual,
        ];

        expect(lowerStopReasons(program)).toEqual([
            { op: "openai_realtime.finish_reason", reason: "max_tokens" },
            residual,
        ]);
    });

    test("lowerUsageCounts folds response.usage back into an openai_realtime.usage envelope", () => {
        const program: Op[] = [
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            residual,
        ];

        expect(lowerUsageCounts(program)).toEqual([
            {
                op: "openai_realtime.usage",
                usage: { input_tokens: 12, output_tokens: 2 },
            },
            residual,
        ]);
    });

    test("collectOutputItems closes assistant text into a message item at each output_meta boundary, and matches a tool call to its meta by call_id", () => {
        const program: Op[] = [
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_realtime.output_meta",
                item: { type: "message", id: "item_1", status: "completed" },
                appliesTo: "response",
                required: false,
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
                required: false,
            },
            residual,
        ];

        expect(collectOutputItems(program)).toEqual([
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
