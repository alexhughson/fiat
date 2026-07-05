// Lenient mode conforms the request instead of failing it, but that must
// never happen silently — these tests pin the console.warn signal for the
// same drop/clamp cases that throw LintError in strict mode.

import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { AnthropicTranslator, GeminiTranslator } from "../src/index";

describe("lenient mode warns on dropped or clamped meaning", () => {
    let warn: ReturnType<typeof spyOn<Console, "warn">>;

    beforeEach(() => {
        warn = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    test("dropping an unsupported sampling param warns and still drops it", () => {
        const body = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-sonnet-5" },
            { op: "llm.temperature", value: 0.2 },
            { op: "llm.max_output_tokens", value: 1 },
            { op: "llm.text", role: "user", content: "hi" },
        ]);

        expect(body).not.toHaveProperty("temperature");
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("explicit temperature is rejected"),
        );
    });

    test("clamping an unsupported thinking effort warns and still clamps it", () => {
        const body = AnthropicTranslator.toBody([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            { op: "llm.max_output_tokens", value: 2048 },
            {
                op: "anthropic_messages.thinking",
                adaptiveEffort: "xhigh",
                manualBudgetTokens: 1024,
            },
            { op: "llm.text", role: "user", content: "hi" },
        ]);

        expect(body).toMatchObject({ output_config: { effort: "high" } });
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('effort "xhigh" is not supported'),
        );
    });

    test("clamping an unsupported Gemini thinkingLevel warns and still clamps it", () => {
        const body = GeminiTranslator.toBody([
            { op: "llm.model", model: "gemini-3-pro" },
            { op: "llm.thinking", effort: "max" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);

        expect(body).toMatchObject({
            generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
        });
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(
                'thinkingLevel does not support llm.thinking effort "max"',
            ),
        );
    });

    test("strict mode throws instead of warning", () => {
        expect(() =>
            AnthropicTranslator.toBody(
                [
                    { op: "llm.model", model: "claude-sonnet-5" },
                    { op: "llm.temperature", value: 0.2 },
                    { op: "llm.max_output_tokens", value: 1 },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow("explicit temperature is rejected");
        expect(warn).not.toHaveBeenCalled();
    });
});
