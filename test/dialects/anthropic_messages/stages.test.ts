// Executable documentation for each anthropic_messages raise/lower stage in
// isolation — one test per stage function, showing its one job and that
// unrelated ops pass through untouched. Pipeline-level (end-to-end) behavior
// lives in anthropic_messages.test.ts; do not duplicate it here.

import { describe, expect, test } from "bun:test";
import {
    raiseMessages,
    raiseOutputConfig,
    raiseRequestParams,
    raiseStopReasons,
    raiseUsage,
} from "../../../src/dialects/anthropic_messages/raise";
import {
    collectAssistantMessage,
    applyRequestTextMeta,
    applyRequestToolResultMeta,
    dropEmptyText,
    lintMidConversationSystem,
    lowerThinking,
    lowerRequestTexts,
    lowerStructuredOutput,
    lowerStopReasons,
    lowerToolCalls,
    lowerToolResults,
    lowerUsageCounts,
    mergeAdjacentSameRole,
} from "../../../src/dialects/anthropic_messages/lower";

describe("raise stages", () => {
    test("raiseMessages flattens a wire message's content blocks into core ops, leaving other ops alone", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "hi" },
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "get_weather",
                            input: { city: "Paris" },
                        },
                    ],
                },
            },
        ];

        expect(raiseMessages(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "hi" },
            {
                op: "llm.tool_call",
                id: "t1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
        ]);
    });

    test("raiseOutputConfig maps Anthropic json_schema format and effort onto core ops", () => {
        expect(
            raiseOutputConfig([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.output_config",
                    value: {
                        effort: "medium",
                        format: {
                            type: "json_schema",
                            schema: { type: "object" },
                        },
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.thinking", effort: "medium" },
            {
                op: "llm.output",
                format: "json_schema",
                name: "anthropic_output",
                schema: { type: "object" },
            },
        ]);
    });

    test("raiseOutputConfig still maps effort when format has unsupported Anthropic details", () => {
        const original = {
            effort: "medium",
            format: {
                type: "json_schema",
                schema: { type: "object" },
                extra: true,
            },
        };

        expect(
            raiseOutputConfig([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.output_config",
                    value: original,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.thinking", effort: "medium" },
            {
                op: "anthropic_messages.output_config",
                value: { format: original.format },
            },
        ]);
    });

    test("raiseRequestParams maps shared Anthropic request params onto core ops and marks housekeeping droppable", () => {
        expect(
            raiseRequestParams([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.metadata",
                    value: { user_id: "user-123" },
                },
                { op: "request.stream", value: true },
                {
                    op: "anthropic_messages.thinking_config",
                    value: { type: "adaptive", display: "omitted" },
                },
                {
                    op: "anthropic_messages.context_management",
                    value: {
                        edits: [
                            {
                                type: "clear_thinking_20251015",
                                keep: "all",
                            },
                        ],
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "request.user", value: "user-123" },
            { op: "request.stream", value: true },
            {
                op: "anthropic_messages.thinking_config",
                value: { type: "adaptive", display: "omitted" },
                required: false,
            },
            {
                op: "anthropic_messages.context_management",
                value: {
                    edits: [
                        {
                            type: "clear_thinking_20251015",
                            keep: "all",
                        },
                    ],
                },
                required: false,
            },
        ]);
    });

    test("raiseStopReasons maps the wire stop_reason value onto response.stop, leaving other ops alone", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "anthropic_messages.stop_reason", value: "end_turn" },
        ];

        expect(raiseStopReasons(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("raiseUsage splits cross-provider counts onto response.usage and keeps vendor-specific fields as a droppable residual", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.usage",
                usage: {
                    input_tokens: 20,
                    output_tokens: 9,
                    cache_read_input_tokens: 3,
                },
            },
        ];

        expect(raiseUsage(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
            {
                op: "anthropic_messages.usage",
                usage: { cache_read_input_tokens: 3 },
                required: false,
            },
        ]);
    });
});

describe("lower request stages", () => {
    test("lowerThinking maps core effort to Anthropic adaptive thinking", () => {
        expect(
            lowerThinking([
                { op: "llm.model", model: "m" },
                { op: "llm.thinking", effort: "medium" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.thinking",
                adaptiveEffort: "medium",
                display: "omitted",
            },
        ]);
    });

    test("lowerThinking preserves a raw Anthropic thinking param while carrying core effort", () => {
        expect(
            lowerThinking([
                { op: "llm.model", model: "m" },
                {
                    op: "anthropic_messages.thinking_config",
                    value: { type: "adaptive", display: "omitted" },
                    required: false,
                },
                { op: "llm.thinking", effort: "medium" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.thinking_config",
                value: { type: "adaptive", display: "omitted" },
                required: false,
            },
            {
                op: "anthropic_messages.output_config",
                value: { effort: "medium" },
            },
        ]);
    });

    test("lintMidConversationSystem throws when a system op appears after the conversation has started", () => {
        expect(() =>
            lintMidConversationSystem([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "user", content: "first" },
                { op: "llm.text", role: "system", content: "late instruction" },
            ]),
        ).toThrow("system text after conversation start cannot be hoisted");
    });

    test("lowerStructuredOutput maps llm.output to output_config.format", () => {
        expect(
            lowerStructuredOutput([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "check",
                    schema: {},
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.output_config",
                value: {
                    format: {
                        type: "json_schema",
                        schema: {},
                    },
                },
            },
        ]);
    });

    test("applyRequestTextMeta reattaches adjacent Anthropic cache metadata to text blocks", () => {
        expect(
            applyRequestTextMeta([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "system", content: "system" },
                {
                    op: "anthropic_messages.text_meta",
                    fields: { cache_control: { type: "ephemeral" } },
                    required: false,
                },
                { op: "llm.text", role: "user", content: "hi" },
                {
                    op: "anthropic_messages.text_meta",
                    fields: { cache_control: { type: "ephemeral" } },
                    required: false,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.system_block",
                block: {
                    type: "text",
                    text: "system",
                    cache_control: { type: "ephemeral" },
                },
            },
            {
                op: "anthropic_messages.content_block",
                role: "user",
                block: {
                    type: "text",
                    text: "hi",
                    cache_control: { type: "ephemeral" },
                },
            },
        ]);
    });

    test("applyRequestToolResultMeta reattaches adjacent Anthropic cache metadata to tool_result blocks", () => {
        expect(
            applyRequestToolResultMeta([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.tool_result",
                    id: "toolu_1",
                    content: "done",
                },
                {
                    op: "anthropic_messages.tool_result_meta",
                    fields: { cache_control: { type: "ephemeral" } },
                    required: false,
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.content_block",
                role: "user",
                block: {
                    type: "tool_result",
                    tool_use_id: "toolu_1",
                    content: "done",
                    cache_control: { type: "ephemeral" },
                },
            },
        ]);
    });

    test("dropEmptyText filters out llm.text ops with empty content and keeps everything else", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "" },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        expect(dropEmptyText(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);
    });

    test("lowerRequestTexts turns non-system llm.text into a single-block wire message, leaving system text as a core op", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "system", content: "be nice" },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        expect(lowerRequestTexts(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "system", content: "be nice" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "hi" }],
                },
            },
        ]);
    });

    test("lowerToolCalls turns llm.tool_call into a single-block assistant tool_use message", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "llm.tool_call",
                id: "t1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
        ];

        expect(lowerToolCalls(program)).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "get_weather",
                            input: { city: "Paris" },
                        },
                    ],
                },
            },
        ]);
    });

    test("lowerToolResults turns llm.tool_result into a single-block user tool_result message", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "llm.tool_result", id: "t1", content: "72F", isError: true },
        ];

        expect(lowerToolResults(program)).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "t1",
                            content: "72F",
                            is_error: true,
                        },
                    ],
                },
            },
        ]);
    });

    test("mergeAdjacentSameRole folds consecutive same-role wire messages into one message's block list", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "first" }],
                },
            },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [{ type: "text", text: "second" }],
                },
            },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "reply" }],
                },
            },
        ];

        expect(mergeAdjacentSameRole(program)).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "user",
                    content: [
                        { type: "text", text: "first" },
                        { type: "text", text: "second" },
                    ],
                },
            },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "reply" }],
                },
            },
        ]);
    });
});

describe("lower response stages", () => {
    test("lowerStopReasons maps response.stop back onto the wire stop_reason op", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ];

        expect(lowerStopReasons(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "anthropic_messages.stop_reason", value: "end_turn" },
        ]);
    });

    test("lowerUsageCounts turns response.usage back into the wire usage op's input_tokens/output_tokens shape", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
        ];

        expect(lowerUsageCounts(program)).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "anthropic_messages.usage",
                usage: { input_tokens: 20, output_tokens: 9 },
            },
        ]);
    });

    test("collectAssistantMessage collapses response text and tool-call ops into one assistant message appended at the end", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "let me check" },
            {
                op: "llm.tool_call",
                id: "t1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "response.stop", reason: "tool_use" },
        ];

        expect(collectAssistantMessage(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "tool_use" },
            {
                op: "anthropic_messages.message",
                message: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "let me check" },
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "get_weather",
                            input: { city: "Paris" },
                        },
                    ],
                },
            },
        ]);
    });
});
