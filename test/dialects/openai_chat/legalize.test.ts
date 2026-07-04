import { describe, expect, test } from "bun:test";
import {
    omitReasoningEffortWithToolsForGPT55Chat,
    useMaxCompletionTokensForReasoningChatModels,
} from "../../../src/dialects/openai_chat/legalize";

describe("openai_chat legalizations", () => {
    test("omitReasoningEffortWithToolsForGPT55Chat removes thinking when gpt-5.5 chat also has tools", () => {
        expect(
            omitReasoningEffortWithToolsForGPT55Chat(
                [
                { op: "llm.model", model: "gpt-5.5" },
                { op: "llm.thinking", effort: "medium" },
                    {
                        op: "llm.tool",
                        name: "lookup",
                        description: "lookup",
                        inputSchema: { type: "object" },
                    },
                ],
                {
                    dialect: "openai_chat",
                    kind: "request",
                    model: "gpt-5.5",
                },
            ),
        ).toEqual([
            { op: "llm.model", model: "gpt-5.5" },
            {
                op: "llm.tool",
                name: "lookup",
                description: "lookup",
                inputSchema: { type: "object" },
            },
        ]);
    });

    test("useMaxCompletionTokensForReasoningChatModels maps max_output_tokens to max_completion_tokens for reasoning models", () => {
        expect(
            useMaxCompletionTokensForReasoningChatModels(
                [
                    { op: "llm.model", model: "gpt-5" },
                    { op: "llm.max_output_tokens", value: 128 },
                ],
                {
                    dialect: "openai_chat",
                    kind: "request",
                    model: "gpt-5",
                },
            ),
        ).toEqual([
            { op: "llm.model", model: "gpt-5" },
            { op: "openai_chat.max_completion_tokens", value: 128 },
        ]);
    });
});
