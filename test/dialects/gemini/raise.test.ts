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
