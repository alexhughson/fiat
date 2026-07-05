import { describe, expect, test } from "bun:test";
import {
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    makeTranslator,
    type Program,
    type Stage,
    type Dialect,
    AnthropicTranslator,
} from "../src/index";

describe("raise/lower hooks", () => {
    test("translator wrappers call the concrete dialect object they wrap", () => {
        const concreteDialect: Dialect = {
            name: "hook_test_dialect",
            request: {
                fromWire: () => [{ op: "llm.model", model: "concrete" }],
                toWire: () => ({ source: "concrete" }),
                raise: (program) => program,
                lower: (program) => program,
            },
            response: {
                fromWire: () => [],
                toWire: () => ({}),
                raise: (program) => program,
                lower: (program) => program,
            },
        };

        expect(makeTranslator(concreteDialect).fromBody({})).toEqual([
            { op: "llm.model", model: "concrete" },
        ]);
    });

    test("translator wrappers compose directly", () => {
        expect(
            AnthropicTranslator.toBody(
                OpenAIChatTranslator.fromBody({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "hi" }],
                }),
            ),
        ).toMatchObject({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hi" }],
                },
            ],
        });
    });

    test("beforeRaise edits source lower IR before the dialect raise consumes it", () => {
        const renameBeforeOpenAIRaise: Stage = (program) =>
            program.map((op) =>
                op.op === "openai_chat.message"
                    ? {
                          ...op,
                          message: { role: "user", content: "changed" },
                      }
                    : op,
            );

        expect(
            OpenAIChatTranslator.fromBody(
                {
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "original" }],
                },
                { beforeRaise: renameBeforeOpenAIRaise },
            ),
        ).toContainEqual({
            op: "llm.text",
            role: "user",
            content: "changed",
        });
    });

    test("afterRaise edits the raised core program", () => {
        const addSystemAfterRaise: Stage = (program) => [
            ...program,
            { op: "llm.text", role: "system", content: "after" },
        ];

        expect(
            OpenAIChatTranslator.fromBody(
                {
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "hi" }],
                },
                { afterRaise: addSystemAfterRaise },
            ),
        ).toContainEqual({
            op: "llm.text",
            role: "system",
            content: "after",
        });
    });

    test("beforeLower edits provider-bound core IR before target lower", () => {
        const lowerThinkingAsLow: Stage = (program) =>
            program.map((op) =>
                op.op === "llm.thinking" ? { ...op, effort: "low" } : op,
            );

        expect(
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model: "models/gemini-3.5-flash" },
                    { op: "llm.thinking", effort: "high" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { beforeLower: lowerThinkingAsLow },
            ),
        ).toMatchObject({
            generationConfig: {
                thinkingConfig: { thinkingLevel: "LOW" },
            },
        });
    });

    test("afterLower edits target lower IR before built-in legalizations", () => {
        // lower() only carries llm.thinking forward as the model-free
        // gemini.thinking op — model conformance (thinkingLevel vs.
        // thinkingBudget, the xhigh/max clamp) is a legalization that runs
        // after afterLower. So overriding the effort here, before that
        // legalization sees it, is how afterLower reaches the final
        // thinkingConfig.
        const capGeminiThinkingLevel: Stage = (program) =>
            program.map((op) =>
                op.op === "gemini.thinking" ? { ...op, effort: "low" } : op,
            );

        expect(
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model: "models/gemini-3.5-flash" },
                    { op: "llm.thinking", effort: "high" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { afterLower: capGeminiThinkingLevel },
            ),
        ).toMatchObject({
            generationConfig: {
                thinkingConfig: { thinkingLevel: "LOW" },
            },
        });
    });

    test("afterLower still runs through built-in legalization", () => {
        const addIllegalThinkingLevel: Stage = (program: Program) => [
            ...program,
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingLevel: "low" } },
            },
        ];

        expect(
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model: "models/gemini-2.5-flash" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { afterLower: addIllegalThinkingLevel },
            ),
        ).toMatchObject({
            generationConfig: {
                thinkingConfig: { thinkingBudget: 1024 },
            },
        });

        expect(() =>
            GeminiTranslator.toBody(
                [
                    { op: "llm.model", model: "models/gemini-2.5-flash" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { afterLower: addIllegalThinkingLevel, strict: true },
            ),
        ).toThrow(LintError);
    });

    test("target native config cannot silently overwrite core config", () => {
        expect(() =>
            GeminiTranslator.toBody([
                { op: "llm.model", model: "models/gemini-2.5-flash" },
                { op: "llm.temperature", value: 0.2 },
                {
                    op: "gemini.generation_config",
                    value: { temperature: 0.9 },
                },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toThrow("duplicate generationConfig.temperature");
    });
});
