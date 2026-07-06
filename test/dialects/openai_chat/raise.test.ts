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

    test("raiseUsage splits cross-provider counts onto response.usage and keeps the rest as a droppable residual", () => {
        const program = raiseUsage([
            { op: "llm.model", model: "m" },
            {
                op: "openai_chat.usage",
                usage: {
                    prompt_tokens: 20,
                    completion_tokens: 9,
                    total_tokens: 29,
                },
            },
        ]);

        expect(program).toEqual([
            { op: "llm.model", model: "m" },
            { op: "response.usage", inputTokens: 20, outputTokens: 9 },
            {
                op: "openai_chat.usage",
                usage: { total_tokens: 29 },
            },
        ]);
    });
});
