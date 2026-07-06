import { describe, expect, test } from "bun:test";
import {
    DEFAULT_MAX_TOKENS,
    defaultMaxTokens,
    legalizeThinking,
    legalizeUnsupportedSamplingParams,
    validateOutputConfigEffort,
} from "../../../src/dialects/anthropic_messages/legalize";

describe("anthropic_messages legalizations", () => {
    test("defaultMaxTokens inserts Anthropic's required max_tokens cap when absent", () => {
        expect(
            defaultMaxTokens(
                [{ op: "llm.model", model: "claude-sonnet-4-5" }],
                {
                    dialect: "anthropic_messages",
                    kind: "request",
                    model: "claude-sonnet-4-5",
                },
            ),
        ).toEqual([
            { op: "llm.model", model: "claude-sonnet-4-5" },
            { op: "llm.max_output_tokens", value: DEFAULT_MAX_TOKENS },
        ]);
    });

    test("legalizeUnsupportedSamplingParams drops sampling params rejected by newer Anthropic model families", () => {
        expect(
            legalizeUnsupportedSamplingParams(
                [
                    { op: "llm.model", model: "claude-sonnet-5" },
                    { op: "llm.temperature", value: 0.2 },
                    {
                        op: "anthropic_messages.sampling",
                        key: "top_p",
                        value: 0.9,
                    },
                ],
                {
                    dialect: "anthropic_messages",
                    kind: "request",
                    model: "claude-sonnet-5",
                },
            ),
        ).toEqual([{ op: "llm.model", model: "claude-sonnet-5" }]);
    });

    test("legalizeThinking converts adaptive effort into the model-specific Anthropic thinking config", () => {
        expect(
            legalizeThinking(
                [
                    { op: "llm.model", model: "claude-sonnet-5" },
                    { op: "llm.max_output_tokens", value: 2000 },
                    {
                        op: "anthropic_messages.thinking",
                        adaptiveEffort: "xhigh",
                        display: "omitted",
                    },
                ],
                {
                    dialect: "anthropic_messages",
                    kind: "request",
                    model: "claude-sonnet-5",
                },
            ),
        ).toEqual([
            { op: "llm.model", model: "claude-sonnet-5" },
            { op: "llm.max_output_tokens", value: 2000 },
            {
                op: "anthropic_messages.thinking_config",
                value: { type: "adaptive", display: "omitted" },
            },
            {
                op: "anthropic_messages.output_config",
                value: { effort: "xhigh" },
            },
        ]);
    });

    test("validateOutputConfigEffort clamps unsupported effort values for the target model", () => {
        expect(
            validateOutputConfigEffort(
                [
                    { op: "llm.model", model: "claude-sonnet-4-6" },
                    {
                        op: "anthropic_messages.output_config",
                        value: { effort: "xhigh", other: true },
                    },
                ],
                {
                    dialect: "anthropic_messages",
                    kind: "request",
                    model: "claude-sonnet-4-6",
                },
            ),
        ).toEqual([
            { op: "llm.model", model: "claude-sonnet-4-6" },
            {
                op: "anthropic_messages.output_config",
                value: { other: true, effort: "high" },
            },
        ]);
    });
});
