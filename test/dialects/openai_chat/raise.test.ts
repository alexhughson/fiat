import { describe, expect, test } from "bun:test";
import {
    raiseMessages,
    raiseFinishReasons,
    raiseUsage,
} from "../../../src/dialects/openai_chat/raise";

describe("openai_chat raise stages", () => {
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

    test("raiseUsage subtracts the details the body reports inside its totals and keeps the vendor fields as a residual", () => {
        const program = raiseUsage([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.usage",
                usage: {
                    prompt_tokens: 2600,
                    completion_tokens: 97,
                    total_tokens: 2697,
                    prompt_tokens_details: {
                        cached_tokens: 2048,
                        cache_write_tokens: 500,
                        audio_tokens: 7,
                    },
                    completion_tokens_details: {
                        reasoning_tokens: 40,
                        text_tokens: 57,
                        accepted_prediction_tokens: 2,
                    },
                },
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            {
                op: "response.usage",
                inputTokens: 52,
                cacheReadTokens: 2048,
                cacheWriteTokens: 500,
                outputTokens: 57,
                reasoningTokens: 40,
            },
            {
                op: "openai_chat.usage",
                usage: {
                    prompt_tokens_details: { audio_tokens: 7 },
                    completion_tokens_details: {
                        text_tokens: 57,
                        accepted_prediction_tokens: 2,
                    },
                },
            },
        ]);
    });

    test("raiseUsage reads a details object the body omits as no part, and a missing key in a present one as its default 0", () => {
        const noDetails = raiseUsage([
            {
                op: "openai_chat.usage",
                usage: { prompt_tokens: 20, completion_tokens: 9 },
            },
        ]);
        expect(noDetails).toEqual([
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
        ]);

        const defaultZero = raiseUsage([
            {
                op: "openai_chat.usage",
                usage: {
                    prompt_tokens: 20,
                    completion_tokens: 9,
                    prompt_tokens_details: {},
                    completion_tokens_details: {},
                },
            },
        ]);
        expect(defaultZero).toEqual([
            {
                op: "response.usage",
                inputTokens: 20,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 9,
                reasoningTokens: 0,
            },
        ]);
    });

    test("raiseUsage fails on a detail larger than its total", () => {
        expect(() =>
            raiseUsage([
                {
                    op: "openai_chat.usage",
                    usage: {
                        prompt_tokens: 200,
                        prompt_tokens_details: {
                            cached_tokens: 150,
                            cache_write_tokens: 100,
                        },
                    },
                },
            ]),
        ).toThrow(
            /prompt_tokens_details\.cache_write_tokens 100 exceeds the remaining prompt_tokens 50/,
        );
    });
});
