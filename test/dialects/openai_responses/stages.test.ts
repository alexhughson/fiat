// These tests document each openai_responses raise/lower stage in isolation —
// calling the stage function directly with a minimal program and checking the
// exact output. Pipeline-level (fromBody/toBody/fromResponse/toResponse)
// behavior lives in openai_responses.test.ts; do not duplicate it here.

import { describe, expect, test } from "bun:test";
import {
    raiseFinishReasons,
    raiseInputs,
    raiseOutputs,
    raiseUsage,
} from "../../../src/dialects/openai_responses/raise";
import {
    collectOutputItems,
    lowerRequestTexts,
    lowerStopReasons,
    lowerToolCalls,
    lowerToolResults,
    lowerUsageCounts,
    rejectStructuredOutput,
} from "../../../src/dialects/openai_responses/lower";

describe("raise stages", () => {
    test("raiseInputs dispatches each wire input item type to its core op, leaving other ops alone", () => {
        expect(
            raiseInputs([
                { op: "llm.model", model: "m" },
                {
                    op: "openai_responses.input",
                    item: { type: "message", role: "user", content: "hi" },
                },
                {
                    op: "openai_responses.input",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                },
                {
                    op: "openai_responses.input",
                    item: {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: "72F",
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: "72F" },
        ]);
    });

    test("raiseOutputs turns a wire output item into its core op plus an output_meta residual that remembers the original wire shape", () => {
        expect(
            raiseOutputs([
                { op: "llm.model", model: "m" },
                {
                    op: "openai_responses.output",
                    item: {
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [
                            {
                                type: "output_text",
                                text: "pong",
                                annotations: [],
                                logprobs: [],
                            },
                        ],
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_responses.output_meta",
                item: {
                    type: "message",
                    role: "assistant",
                    status: "completed",
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
                required: false,
            },
        ]);
    });

    test("raiseFinishReasons maps the wire finish_reason to a core response.stop", () => {
        expect(
            raiseFinishReasons([
                { op: "llm.model", model: "m" },
                { op: "openai_responses.finish_reason", reason: "tool_use" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "tool_use" },
        ]);
    });

    test("raiseUsage splits the wire usage object into the cross-provider counts plus a droppable residual for the rest", () => {
        expect(
            raiseUsage([
                { op: "llm.model", model: "m" },
                {
                    op: "openai_responses.usage",
                    usage: {
                        input_tokens: 12,
                        output_tokens: 2,
                        total_tokens: 14,
                    },
                    appliesTo: "response",
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            {
                op: "openai_responses.usage",
                usage: { total_tokens: 14 },
                appliesTo: "response",
                required: false,
            },
        ]);
    });
});

describe("lower request stages", () => {
    test("rejectStructuredOutput halts because structured output has no responses-dialect mapping yet", () => {
        expect(() =>
            rejectStructuredOutput([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "answer",
                    schema: {},
                },
            ]),
        ).toThrow();
    });

    test("lowerRequestTexts converts non-system core text to a message input item, leaving system text (handled elsewhere as instructions) untouched", () => {
        expect(
            lowerRequestTexts([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "system", content: "sys" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "system", content: "sys" },
            {
                op: "openai_responses.input",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "hi" }],
                },
            },
        ]);
    });

    test("lowerToolCalls converts a core tool call into a function_call input item, stringifying its arguments", () => {
        expect(
            lowerToolCalls([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            },
        ]);
    });

    test("lowerToolResults converts a core tool result into a function_call_output input item", () => {
        expect(
            lowerToolResults([
                { op: "llm.model", model: "m" },
                { op: "llm.tool_result", id: "call_1", content: "72F" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call_output",
                    call_id: "call_1",
                    output: "72F",
                },
            },
        ]);
    });
});

describe("lower response stages", () => {
    test("lowerStopReasons narrows core stop reasons onto the four wire finish reasons, e.g. refusal collapses into content_filter", () => {
        expect(
            lowerStopReasons([
                { op: "llm.model", model: "m" },
                { op: "response.stop", reason: "refusal" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "openai_responses.finish_reason", reason: "content_filter" },
        ]);
    });

    test("lowerUsageCounts renames the core count fields to the wire's snake_case usage shape", () => {
        expect(
            lowerUsageCounts([
                { op: "llm.model", model: "m" },
                { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.usage",
                usage: { input_tokens: 12, output_tokens: 2 },
            },
        ]);
    });

    test("collectOutputItems reunites pending core ops with output_meta templates in order, and synthesizes an item for anything left over", () => {
        // The output_meta here is a template: it carries the wire id/content shape
        // from the original response, and consumes the one pending llm.text op
        // that precedes it (splicing the real text into the template's content
        // part, keeping the meta's id "msg_1"). The trailing llm.tool_call has no
        // meta after it, so collectOutputItems synthesizes a plain function_call
        // item for it instead of dropping it.
        expect(
            collectOutputItems([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "assistant", content: "hi" },
                {
                    op: "openai_responses.output_meta",
                    item: {
                        id: "msg_1",
                        type: "message",
                        content: [
                            {
                                type: "output_text",
                                text: "placeholder",
                                annotations: [],
                                logprobs: [],
                            },
                        ],
                    },
                    appliesTo: "response",
                    required: false,
                },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "openai_responses.output",
                item: {
                    id: "msg_1",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: "hi",
                            annotations: [],
                            logprobs: [],
                        },
                    ],
                },
            },
            {
                op: "openai_responses.output",
                item: {
                    type: "function_call",
                    status: "completed",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            },
        ]);
    });
});
