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

    test("raiseUsage splits gemini.usage into the core parts plus a residual for the modality lists and the service tier", () => {
        expect(
            raiseUsage([
                { op: "llm.model", model: "m" },
                {
                    op: "gemini.usage",
                    usage: {
                        promptTokenCount: 2600,
                        cachedContentTokenCount: 2048,
                        toolUsePromptTokenCount: 33,
                        thoughtsTokenCount: 40,
                        candidatesTokenCount: 57,
                        totalTokenCount: 2730,
                        promptTokensDetails: [
                            { modality: "TEXT", tokenCount: 552 },
                        ],
                        serviceTier: "standard",
                    },
                },
            ]),
        ).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "response.usage",
                inputTokens: 552,
                cacheReadTokens: 2048,
                toolUsePromptTokens: 33,
                outputTokens: 57,
                reasoningTokens: 40,
            },
            {
                op: "gemini.usage",
                usage: {
                    promptTokensDetails: [
                        { modality: "TEXT", tokenCount: 552 },
                    ],
                    serviceTier: "standard",
                },
            },
        ]);
    });

    test("raiseUsage leaves no residual when the body reports only counts", () => {
        expect(
            raiseUsage([
                {
                    op: "gemini.usage",
                    usage: { promptTokenCount: 10, candidatesTokenCount: 2 },
                },
            ]),
        ).toEqual([{ op: "response.usage", inputTokens: 10, outputTokens: 2 }]);
    });

    test("raiseUsage fails on a cachedContentTokenCount larger than promptTokenCount", () => {
        expect(() =>
            raiseUsage([
                {
                    op: "gemini.usage",
                    usage: {
                        promptTokenCount: 10,
                        cachedContentTokenCount: 11,
                    },
                },
            ]),
        ).toThrow(
            /usageMetadata\.cachedContentTokenCount 11 exceeds the remaining promptTokenCount 10/,
        );
    });
});
