import { describe, expect, test } from "bun:test";
import { legalizeThinkingLevel } from "../../../src/dialects/gemini/legalize";

describe("gemini legalizations", () => {
    test("legalizeThinkingLevel converts thinkingLevel to thinkingBudget for Gemini models that use budgets", () => {
        expect(
            legalizeThinkingLevel(
                [
                    { op: "llm.model", model: "models/gemini-2.5-flash" },
                    {
                        op: "gemini.generation_config",
                        value: { thinkingConfig: { thinkingLevel: "high" } },
                    },
                ],
                {
                    dialect: "gemini",
                    kind: "request",
                    model: "models/gemini-2.5-flash",
                },
            ),
        ).toEqual([
            { op: "llm.model", model: "models/gemini-2.5-flash" },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingBudget: 8192 } },
            },
        ]);
    });
});
