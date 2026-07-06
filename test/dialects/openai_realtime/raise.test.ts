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

    test("raiseUsage splits cross-provider counts onto response.usage and keeps vendor-specific fields as a residual", () => {
        expect(
            raiseUsage([
                {
                    op: "openai_realtime.usage",
                    usage: {
                        input_tokens: 12,
                        output_tokens: 2,
                        total_tokens: 14,
                    },
                },
                residual,
            ]),
        ).toEqual([
            { op: "response.usage", inputTokens: 12, outputTokens: 2 },
            {
                op: "openai_realtime.usage",
                usage: { total_tokens: 14 },
            },
            residual,
        ]);
    });
});
