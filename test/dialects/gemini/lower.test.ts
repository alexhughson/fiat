import { describe, expect, test } from "bun:test";
import type { Program } from "../../../src/core/ops";
import {
    applyRequestPartMeta,
    collectModelContent,
    collectStreamModelContent,
    lintMidConversationSystem,
    lowerStructuredOutput,
    lowerThinking,
    lowerRequestTexts,
    lowerStopReasons,
    lowerToolCalls,
    lowerToolResults,
    lowerUsageCounts,
    mergeAdjacentContents,
} from "../../../src/dialects/gemini/lower";

describe("gemini lower request stages", () => {
    test("lintMidConversationSystem passes when system text comes before contents", () => {
        const program: Program = [
            { op: "llm.text", role: "system", content: "be terse" },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        expect(lintMidConversationSystem(program)).toEqual(program);
    });

    test("lowerThinking maps Gemini 3 thinking effort to thinkingLevel", () => {
        expect(
            lowerThinking([
                { op: "llm.model", model: "models/gemini-3.5-flash" },
                { op: "llm.thinking", effort: "low" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "models/gemini-3.5-flash" },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingLevel: "low" } },
            },
        ]);
    });

    test("lowerStructuredOutput maps llm.output to generationConfig.responseMimeType and responseSchema", () => {
        expect(
            lowerStructuredOutput([
                { op: "llm.model", model: "m" },
                {
                    op: "llm.output",
                    format: "json_schema",
                    name: "answer",
                    schema: {
                        type: "object",
                        properties: { ok: { type: "boolean" } },
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "gemini.generation_config",
                value: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "object",
                        properties: { ok: { type: "boolean" } },
                    },
                },
            },
        ]);
    });

    test("lowerToolResults resolves the functionResponse name from the matching earlier llm.tool_call", () => {
        expect(
            lowerToolResults([
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
                { op: "llm.tool_result", id: "call_1", content: '{"temp_c":21}' },
            ]),
        ).toEqual([
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            {
                op: "gemini.content",
                content: {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "get_weather",
                                response: { temp_c: 21 },
                                id: "call_1",
                            },
                        },
                    ],
                },
            },
        ]);
    });

    test("lowerRequestTexts turns user/assistant llm.text into a gemini.content and leaves system text untouched", () => {
        expect(
            lowerRequestTexts([
                { op: "llm.text", role: "system", content: "be terse" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual([
            { op: "llm.text", role: "system", content: "be terse" },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "hi" }] },
            },
        ]);
    });

    test("lowerToolCalls turns llm.tool_call into a model-role gemini.content with a functionCall part", () => {
        expect(
            lowerToolCalls([
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "get_weather",
                    arguments: { city: "Paris" },
                },
            ]),
        ).toEqual([
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "get_weather",
                                args: { city: "Paris" },
                                id: "call_1",
                            },
                        },
                    ],
                },
            },
        ]);
    });

    test("applyRequestPartMeta reattaches thoughtSignature to the adjacent lowered part", () => {
        expect(
            applyRequestPartMeta([
                {
                    op: "gemini.content",
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { city: "Paris" },
                                    id: "call_1",
                                },
                            },
                        ],
                    },
                },
                {
                    op: "gemini.part_meta",
                    part: {
                        kind: "functionCall",
                        index: 0,
                        id: "call_1",
                        meta: { thoughtSignature: "sig" },
                    },
                    required: false,
                },
            ]),
        ).toEqual([
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "get_weather",
                                args: { city: "Paris" },
                                id: "call_1",
                            },
                            thoughtSignature: "sig",
                        },
                    ],
                },
            },
        ]);
    });

    test("mergeAdjacentContents merges two adjacent same-role contents into one content with both parts", () => {
        expect(
            mergeAdjacentContents([
                { op: "llm.model", model: "m" },
                {
                    op: "gemini.content",
                    content: { role: "user", parts: [{ text: "hi" }] },
                },
                {
                    op: "gemini.content",
                    content: { role: "user", parts: [{ text: "there" }] },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "gemini.content",
                content: {
                    role: "user",
                    parts: [{ text: "hi" }, { text: "there" }],
                },
            },
        ]);
    });
});

describe("gemini lower response stages", () => {
    test("lowerStopReasons maps response.stop onto a gemini.finish_reason op", () => {
        expect(
            lowerStopReasons([
                { op: "llm.model", model: "m" },
                { op: "response.stop", reason: "end_turn" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "gemini.finish_reason", value: "STOP" },
        ]);
    });

    test("lowerUsageCounts maps response.usage onto a gemini.usage op with the wire field names", () => {
        expect(
            lowerUsageCounts([
                { op: "llm.model", model: "m" },
                { op: "response.usage", inputTokens: 10, outputTokens: 2 },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "gemini.usage",
                usage: { promptTokenCount: 10, candidatesTokenCount: 2 },
            },
        ]);
    });

    test("collectModelContent collapses response text and tool_call ops into one model gemini.content", () => {
        expect(
            collectModelContent([
                { op: "llm.model", model: "m" },
                { op: "llm.text", role: "assistant", content: "here you go" },
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
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        { text: "here you go" },
                        {
                            functionCall: {
                                name: "get_weather",
                                args: { city: "Paris" },
                                id: "call_1",
                            },
                        },
                    ],
                },
                appliesTo: "response",
            },
        ]);
    });

    test("collectStreamModelContent collapses generic stream deltas into one response gemini.content", () => {
        expect(
            collectStreamModelContent([
                { op: "response.text_delta", role: "assistant", content: "hi" },
                {
                    op: "response.tool_call_delta",
                    index: 1,
                    id: "call_1",
                    name: "lookup",
                    arguments: '{"q":"weather"}',
                },
            ]),
        ).toEqual([
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        { text: "hi" },
                        {
                            functionCall: {
                                name: "lookup",
                                args: { q: "weather" },
                                id: "call_1",
                            },
                        },
                    ],
                },
                appliesTo: "response",
            },
        ]);
    });
});
