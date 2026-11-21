import { describe, expect, test } from "bun:test";
import {
    raiseContents,
    raiseFinishReasons,
    raiseStreamContents,
    raiseUsage,
} from "../../../src/dialects/gemini/raise";

describe("gemini raise stages", () => {
    test("raiseContents turns a gemini.content op into core ops for each part", () => {
        expect(
            raiseContents([
                { op: "llm.model", model: "m" },
                {
                    op: "gemini.content",
                    content: { role: "user", parts: [{ text: "hi" }] },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);
    });

    test("raiseStreamContents maps model stream parts to generic stream deltas", () => {
        expect(
            raiseStreamContents([
                {
                    op: "gemini.content",
                    content: {
                        role: "model",
                        parts: [
                            { text: "hi" },
                            {
                                functionCall: {
                                    id: "call_1",
                                    name: "lookup",
                                    args: { q: "weather" },
                                },
                            },
                        ],
                    },
                    appliesTo: "response",
                },
            ]),
        ).toEqual([
            { op: "response.text_delta", role: "assistant", content: "hi" },
            {
                op: "response.tool_call_delta",
                index: 1,
                id: "call_1",
                name: "lookup",
                arguments: '{"q":"weather"}',
            },
        ]);
    });

    test("raiseFinishReasons maps a gemini.finish_reason op onto response.stop", () => {
        expect(
            raiseFinishReasons([
                { op: "llm.model", model: "m" },
                { op: "gemini.finish_reason", value: "STOP" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "end_turn" },
        ]);
    });

    test("raiseFinishReasons maps a finishReason with no core spelling onto the nearest reason and keeps the value beside it", () => {
        expect(
            raiseFinishReasons([
                { op: "llm.model", model: "m" },
                { op: "gemini.finish_reason", value: "RECITATION" },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.stop", reason: "content_filter", id: "stop_1" },
            {
                op: "gemini.finish_reason",
                value: "RECITATION",
                of: "stop_1",
                appliesTo: "response",
            },
        ]);
    });

    test("raiseFinishReasons passes a value no core reason shares the meaning of through unchanged", () => {
        expect(
            raiseFinishReasons([
                {
                    op: "gemini.finish_reason",
                    value: "BRAND_NEW_FILTER",
                    appliesTo: "response",
                },
            ]),
        ).toEqual([
            {
                op: "gemini.finish_reason",
                value: "BRAND_NEW_FILTER",
                appliesTo: "response",
            },
        ]);
    });

    test("raiseFinishReasons reads STOP together with the candidate parts: a functionCall raises tool_use, and no side op is written", () => {
        expect(
            raiseFinishReasons([
                {
                    op: "gemini.content",
                    content: {
                        role: "model",
                        parts: [
                            { functionCall: { id: "c1", name: "f", args: {} } },
                        ],
                    },
                    appliesTo: "response",
                },
                { op: "gemini.finish_reason", value: "STOP" },
            ]),
        ).toEqual([
            {
                op: "gemini.content",
                content: {
                    role: "model",
                    parts: [
                        { functionCall: { id: "c1", name: "f", args: {} } },
                    ],
                },
                appliesTo: "response",
            },
            { op: "response.stop", reason: "tool_use" },
        ]);
    });

    test("raiseFinishReasons raises MALFORMED_FUNCTION_CALL as tool_use only when the candidate holds the call", () => {
        const callContent = {
            op: "gemini.content",
            content: {
                role: "model",
                parts: [{ functionCall: { id: "c1", name: "f", args: {} } }],
            },
            appliesTo: "response",
        } as const;
        const textContent = {
            op: "gemini.content",
            content: { role: "model", parts: [{ text: "partial" }] },
            appliesTo: "response",
        } as const;
        expect(
            raiseFinishReasons([
                callContent,
                {
                    op: "gemini.finish_reason",
                    value: "MALFORMED_FUNCTION_CALL",
                },
            ]),
        ).toEqual([
            callContent,
            { op: "response.stop", reason: "tool_use", id: "stop_1" },
            {
                op: "gemini.finish_reason",
                value: "MALFORMED_FUNCTION_CALL",
                of: "stop_1",
                appliesTo: "response",
            },
        ]);
        expect(
            raiseFinishReasons([
                textContent,
                {
                    op: "gemini.finish_reason",
                    value: "MALFORMED_FUNCTION_CALL",
                    appliesTo: "response",
                },
            ]),
        ).toEqual([
            textContent,
            {
                op: "gemini.finish_reason",
                value: "MALFORMED_FUNCTION_CALL",
                appliesTo: "response",
            },
        ]);
    });

    test("raiseUsage splits gemini.usage into response.usage plus a droppable residual for vendor-only fields", () => {
        expect(
            raiseUsage([
                { op: "llm.model", model: "m" },
                {
                    op: "gemini.usage",
                    usage: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 2,
                        totalTokenCount: 12,
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 10, outputTokens: 2 },
            {
                op: "gemini.usage",
                usage: { totalTokenCount: 12 },
            },
        ]);
    });
});
