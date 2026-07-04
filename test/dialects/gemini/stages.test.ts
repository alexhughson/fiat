// These tests document each gemini raise/lower stage in isolation: call the
// stage function directly with a minimal program and check the exact output.
// Pipeline-level (wire round-trip) behavior lives in gemini.test.ts.

import { describe, expect, test } from "bun:test";
import type { Program } from "../../../src/core/ops";
import { LintError } from "../../../src/core/pass";
import {
    raiseContents,
    raiseFinishReasons,
    raiseUsage,
} from "../../../src/dialects/gemini/raise";
import {
    applyRequestPartMeta,
    collectModelContent,
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

describe("raiseContents", () => {
    test("turns a gemini.content op into core ops for each part, passing other ops through", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "hi" }] },
            },
        ];

        expect(raiseContents(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);
    });

    test("keeps request-native parts as gemini.content residuals between raised core text parts", () => {
        const program = [
            {
                op: "gemini.content",
                content: {
                    role: "user",
                    parts: [
                        { text: "look" },
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: "abc",
                            },
                        },
                        { text: "now" },
                    ],
                },
            },
        ];

        expect(raiseContents(program)).toEqual([
            { op: "llm.text", role: "user", content: "look" },
            {
                op: "gemini.content",
                content: {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: "abc",
                            },
                        },
                    ],
                },
            },
            { op: "llm.text", role: "user", content: "now" },
        ]);
    });
});

describe("raiseFinishReasons", () => {
    test("maps a gemini.finish_reason op onto response.stop, passing other ops through", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "gemini.finish_reason", value: "STOP" },
        ];

        expect(raiseFinishReasons(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });
});

describe("raiseUsage", () => {
    test("splits gemini.usage into response.usage plus a droppable residual for vendor-only fields", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "gemini.usage",
                usage: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 2,
                    totalTokenCount: 12,
                },
            },
        ];

        expect(raiseUsage(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 10, outputTokens: 2 },
            {
                op: "gemini.usage",
                usage: { totalTokenCount: 12 },
                required: false,
            },
        ]);
    });

    test("emits no residual when every usage field is a cross-provider count", () => {
        const program = [
            {
                op: "gemini.usage",
                usage: { promptTokenCount: 5, candidatesTokenCount: 1 },
            },
        ];

        expect(raiseUsage(program)).toEqual([
            { op: "response.usage", inputTokens: 5, outputTokens: 1 },
        ]);
    });
});

describe("lintMidConversationSystem", () => {
    test("passes a program through unchanged when system text comes first", () => {
        const program = [
            { op: "llm.text", role: "system", content: "be terse" },
            { op: "llm.text", role: "user", content: "hi" },
        ];

        expect(lintMidConversationSystem(program)).toEqual(program);
    });

    test("throws when system text follows the start of the conversation, since lowering would silently hoist it", () => {
        const program = [
            { op: "llm.text", role: "user", content: "hi" },
            { op: "llm.text", role: "system", content: "be terse" },
        ];

        expect(() => lintMidConversationSystem(program)).toThrow(LintError);
        expect(() => lintMidConversationSystem(program)).toThrow(
            "system text after contents cannot be hoisted",
        );
    });
});

describe("lowerStructuredOutput", () => {
    test("maps llm.output to generationConfig.responseMimeType and responseSchema", () => {
        const program: Program = [
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
        ];

        expect(lowerStructuredOutput(program)).toEqual([
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

    test("throws when llm.output would overwrite existing Gemini response schema config", () => {
        const program: Program = [
            {
                op: "gemini.generation_config",
                value: { responseSchema: { type: "string" } },
            },
            {
                op: "llm.output",
                format: "json_schema",
                name: "answer",
                schema: { type: "object" },
            },
        ];

        expect(() => lowerStructuredOutput(program)).toThrow(LintError);
        expect(() => lowerStructuredOutput(program)).toThrow(
            "llm.output conflicts",
        );
    });
});

describe("lowerThinking", () => {
    test("maps Gemini 3 thinking effort to thinkingLevel", () => {
        const program: Program = [
            { op: "llm.model", model: "models/gemini-3.5-flash" },
            { op: "llm.thinking", effort: "low" },
        ];

        expect(lowerThinking(program)).toEqual([
            { op: "llm.model", model: "models/gemini-3.5-flash" },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingLevel: "low" } },
            },
        ]);
    });

    test("maps Gemini 2.5 thinking effort to a token budget", () => {
        const program: Program = [
            { op: "llm.model", model: "models/gemini-2.5-flash" },
            { op: "llm.thinking", effort: "high" },
        ];

        expect(lowerThinking(program)).toEqual([
            { op: "llm.model", model: "models/gemini-2.5-flash" },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingBudget: 8192 } },
            },
        ]);
    });

    test("throws when llm.thinking conflicts with native thinkingConfig", () => {
        const program: Program = [
            { op: "llm.model", model: "models/gemini-3.5-flash" },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingLevel: "medium" } },
            },
            { op: "llm.thinking", effort: "high" },
        ];

        expect(() => lowerThinking(program)).toThrow(LintError);
        expect(() => lowerThinking(program)).toThrow(
            "conflicts with existing generationConfig.thinkingConfig",
        );
    });
});

describe("lowerToolResults", () => {
    test("resolves the functionResponse name from the matching earlier llm.tool_call and consumes its part_meta residual", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: '{"temp_c":21}' },
            {
                op: "gemini.part_meta",
                part: {
                    kind: "functionResponse",
                    index: 0,
                    id: "call_1",
                    name: "get_weather",
                    response: { temp_c: 21 },
                },
                required: false,
            },
        ];

        expect(lowerToolResults(program)).toEqual([
            { op: "llm.model", model: "m" },
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

    test("falls back to the tool_call name and re-parses the JSON content when there is no part_meta residual", () => {
        const program = [
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
            { op: "llm.tool_result", id: "call_1", content: '{"temp_c":21}' },
        ];

        expect(lowerToolResults(program)).toEqual([
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
});

describe("lowerRequestTexts", () => {
    test("turns user/assistant llm.text into a gemini.content, leaving system text and other ops untouched", () => {
        const program = [
            { op: "llm.text", role: "system", content: "be terse" },
            { op: "llm.text", role: "user", content: "hi" },
            { op: "llm.model", model: "m" },
        ];

        expect(lowerRequestTexts(program)).toEqual([
            { op: "llm.text", role: "system", content: "be terse" },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "hi" }] },
            },
            { op: "llm.model", model: "m" },
        ]);
    });
});

describe("lowerToolCalls", () => {
    test("turns llm.tool_call into a model-role gemini.content with a functionCall part, passing other ops through", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
        ];

        expect(lowerToolCalls(program)).toEqual([
            { op: "llm.model", model: "m" },
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
});

describe("applyRequestPartMeta", () => {
    test("reattaches thoughtSignature to the adjacent lowered model part and consumes the residual", () => {
        const program: Program = [
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
        ];

        expect(applyRequestPartMeta(program)).toEqual([
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

    test("removes a synthesized functionCall id while preserving thoughtSignature", () => {
        const program: Program = [
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "get_weather",
                                args: { city: "Paris" },
                                id: "gemini_call_0",
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
                    id: "gemini_call_0",
                    idSource: "synthesized",
                    meta: { thoughtSignature: "sig" },
                },
                required: false,
            },
        ];

        expect(applyRequestPartMeta(program)).toEqual([
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "get_weather",
                                args: { city: "Paris" },
                            },
                            thoughtSignature: "sig",
                        },
                    ],
                },
            },
        ]);
    });

    test("throws when a part_meta residual is no longer adjacent to its lowered part", () => {
        const program: Program = [
            {
                op: "gemini.content",
                content: { role: "model", parts: [{ text: "pong" }] },
            },
            { op: "llm.model", model: "m" },
            {
                op: "gemini.part_meta",
                part: {
                    kind: "text",
                    index: 0,
                    meta: { thoughtSignature: "sig" },
                },
                required: false,
            },
        ];

        expect(() => applyRequestPartMeta(program)).toThrow(LintError);
        expect(() => applyRequestPartMeta(program)).toThrow(
            "cannot reapply text part_meta",
        );
    });

    test("throws when functionCall part_meta id no longer matches the adjacent lowered part", () => {
        const program: Program = [
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "get_weather",
                                args: { city: "Paris" },
                                id: "call_2",
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
                    meta: { thoughtSignature: "sig_for_call_1" },
                },
                required: false,
            },
        ];

        expect(() => applyRequestPartMeta(program)).toThrow(LintError);
        expect(() => applyRequestPartMeta(program)).toThrow(
            "cannot apply functionCall part_meta for call_1 to call_2",
        );
    });
});

describe("mergeAdjacentContents", () => {
    test("merges two adjacent same-role single-part contents into one content with both parts", () => {
        const program = [
            { op: "llm.model", model: "m" },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "hi" }] },
            },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "there" }] },
            },
        ];

        expect(mergeAdjacentContents(program)).toEqual([
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

    test("keeps same-role contents separate when an unrelated op sits between them", () => {
        const program = [
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "hi" }] },
            },
            { op: "llm.model", model: "m" },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "there" }] },
            },
        ];

        expect(mergeAdjacentContents(program)).toEqual(program);
    });
});

describe("lowerStopReasons", () => {
    test("maps response.stop onto a gemini.finish_reason op, passing other ops through", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ];

        expect(lowerStopReasons(program)).toEqual([
            { op: "llm.model", model: "m" },
            { op: "gemini.finish_reason", value: "STOP" },
        ]);
    });
});

describe("lowerUsageCounts", () => {
    test("maps response.usage onto a gemini.usage op with the wire field names, passing other ops through", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 10, outputTokens: 2 },
        ];

        expect(lowerUsageCounts(program)).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "gemini.usage",
                usage: { promptTokenCount: 10, candidatesTokenCount: 2 },
            },
        ]);
    });
});

describe("collectModelContent", () => {
    test("collapses response text and tool_call ops into one model gemini.content appended at the end", () => {
        const program = [
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "assistant", content: "here you go" },
            {
                op: "llm.tool_call",
                id: "call_1",
                name: "get_weather",
                arguments: { city: "Paris" },
            },
        ];

        expect(collectModelContent(program)).toEqual([
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

    test("re-applies a response part_meta residual onto its part by index and consumes it", () => {
        const program: Program = [
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "gemini.part_meta",
                part: {
                    kind: "text",
                    index: 0,
                    meta: { thoughtSignature: "sig" },
                },
                required: false,
            },
        ];

        expect(collectModelContent(program)).toEqual([
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [{ text: "pong", thoughtSignature: "sig" }],
                },
                appliesTo: "response",
            },
        ]);
    });
});
