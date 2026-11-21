import { describe, expect, test } from "bun:test";
import type { Op } from "../../../src/core/ops";
import {
    raiseFinishReasons,
    raiseItems,
    raiseOutputs,
    raiseUsage,
} from "../../../src/dialects/openai_realtime/raise";

const residual: Op = { op: "openai_realtime.body_field", key: "x", value: 1 };

describe("openai_realtime raise stages", () => {
    test("raiseItems unwraps a conversation.item.create message into llm.text", () => {
        expect(
            raiseItems([
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
            ]),
        ).toEqual([{ op: "llm.text", role: "user", content: "hi" }, residual]);
    });

    test("raiseOutputs turns a response output item into llm.text plus output_meta carrying its id", () => {
        expect(
            raiseOutputs([
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
            ]),
        ).toEqual([
            { op: "llm.text", role: "assistant", content: "pong" },
            {
                op: "openai_realtime.output_meta",
                item: { type: "message", id: "item_1", status: "completed" },
                appliesTo: "response",
            },
            residual,
        ]);
    });

    test("raiseFinishReasons maps the wire finish reason onto response.stop", () => {
        expect(
            raiseFinishReasons([
                { op: "openai_realtime.finish_reason", reason: "tool_use" },
                residual,
            ]),
        ).toEqual([{ op: "response.stop", reason: "tool_use" }, residual]);
    });

    test("raiseUsage subtracts the cached detail from input_tokens and keeps the modality fields as a residual", () => {
        expect(
            raiseUsage([
                {
                    op: "openai_realtime.usage",
                    usage: {
                        input_tokens: 132,
                        input_token_details: {
                            cached_tokens: 64,
                            text_tokens: 60,
                            cached_tokens_details: { text_tokens: 64 },
                        },
                        output_tokens: 121,
                        output_token_details: { text_tokens: 121 },
                        total_tokens: 253,
                    },
                },
                residual,
            ]),
        ).toEqual([
            {
                op: "response.usage",
                inputTokens: 68,
                cacheReadTokens: 64,
                outputTokens: 121,
            },
            {
                op: "openai_realtime.usage",
                usage: {
                    input_token_details: {
                        text_tokens: 60,
                        cached_tokens_details: { text_tokens: 64 },
                    },
                    output_token_details: { text_tokens: 121 },
                },
            },
            residual,
        ]);
    });

    test("raiseUsage fails on a cached_tokens count larger than input_tokens", () => {
        expect(() =>
            raiseUsage([
                {
                    op: "openai_realtime.usage",
                    usage: {
                        input_tokens: 10,
                        input_token_details: { cached_tokens: 11 },
                    },
                },
            ]),
        ).toThrow(
            /input_token_details\.cached_tokens 11 exceeds the remaining input_tokens 10/,
        );
    });

    test("raiseUsage reads a details object without a cached_tokens key as no count, not as zero", () => {
        expect(
            raiseUsage([
                {
                    op: "openai_realtime.usage",
                    usage: {
                        input_tokens: 12,
                        input_token_details: { text_tokens: 12 },
                        output_tokens: 2,
                    },
                },
            ]),
        ).toEqual([
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            {
                op: "openai_realtime.usage",
                usage: { input_token_details: { text_tokens: 12 } },
            },
        ]);
    });
});
