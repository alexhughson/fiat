// Executable documentation for shared cross-dialect pipeline semantics.

import { describe, expect, spyOn, test } from "bun:test";
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    type Stage,
} from "../src/index";

function withWarnSpy<T>(
    run: (warn: ReturnType<typeof spyOn<Console, "warn">>) => T,
): T {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
        return run(warn);
    } finally {
        warn.mockRestore();
    }
}

describe("request translation", () => {
    test("core-IR transforms run between raise and lower — e.g. rerouting the model", () => {
        const rerouteToHaiku: Stage = (program) =>
            program.map((op) =>
                op.op === "llm.model"
                    ? { op: "llm.model", model: "claude-haiku-4-5" }
                    : op,
            );

        let core = OpenAIChatTranslator.fromBody({
            model: "gpt-4o",
            max_tokens: 100,
            messages: [{ role: "user", content: "hi" }],
        });
        core = rerouteToHaiku(core);
        const body = AnthropicTranslator.toBody(core) as { model: string };

        expect(body.model).toBe("claude-haiku-4-5");
    });
});

describe("residual semantics", () => {
    const bodyWithResidual = (required: boolean | undefined) => ({
        model: "claude-sonnet-4-6",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
        // openai-only; anthropic has no equivalent
        logit_bias: { "50256": -100 },
        ...(required === undefined ? {} : {}),
    });

    test("an endpoint-only param that nothing consumed warns and drops", () => {
        withWarnSpy((warn) => {
            const body = AnthropicTranslator.toBody(
                OpenAIChatTranslator.fromBody(bodyWithResidual(undefined)),
            ) as Record<string, unknown>;

            expect(body.logit_bias).toBeUndefined();
            expect(body.messages).toEqual([
                { role: "user", content: [{ type: "text", text: "hi" }] },
            ]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining(
                    'ignored foreign op "openai_chat.body_field"',
                ),
            );
        });
    });

    test("residuals returning to their home dialect are consumed losslessly", () => {
        const original = {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            logit_bias: { "50256": -100 },
        };
        const roundTripped = OpenAIChatTranslator.toBody(
            OpenAIChatTranslator.fromBody(original),
        );
        expect(roundTripped).toEqual(original);
    });
});
