// Legalizations: target-scoped passes that run on the lower IR after
// lowering, before toWire. This is where endpoint/model quirks live.

import { opData, type Op, type OpOf, type Program } from "../../core/ops";
import { firstOp } from "../../core/program";
import { LintError, type Pass } from "../../core/pass";
import { asThinkingEffort } from "../../core/wire";
import type { AnthropicEffort } from "./ops";

// The Messages API rejects requests without max_tokens, but most other
// providers treat it as optional — so a program translated from elsewhere
// often arrives without one. Filling in a ceiling conforms the request
// without changing its meaning (it's a cap, not an instruction).
export const DEFAULT_MAX_TOKENS = 4096;

export const defaultMaxTokens: Pass = (program: Program): Program => {
    if (firstOp(program, "llm.max_output_tokens")) return program;
    return [
        ...program,
        { op: "llm.max_output_tokens", value: DEFAULT_MAX_TOKENS },
    ];
};

export const legalizeUnsupportedSamplingParams: Pass = (
    program: Program,
    target,
): Program => {
    if (!rejectsExplicitSampling(target.model)) return program;

    return program.flatMap((op) => {
        if (op.op === "llm.temperature") {
            if (target.strict) {
                throw new LintError(
                    `${target.model}: explicit temperature is rejected by the Anthropic Messages API`,
                );
            }
            return [];
        }
        if (op.op !== "anthropic_messages.sampling") return [op];
        const { key } = opData<{ key: "top_p" | "top_k" }>(op);
        if (key === "top_p" || key === "top_k") {
            if (target.strict) {
                throw new LintError(
                    `${target.model}: explicit ${key} is rejected by the Anthropic Messages API`,
                );
            }
            return [];
        }
        return [op];
    });
};

export const validateOutputConfigEffort: Pass = (
    program: Program,
    target,
): Program => {
    return program.flatMap((op) => {
        if (op.op !== "anthropic_messages.output_config") return [op];
        const config = opData<{ value: unknown }>(op).value;
        if (!isRecord(config)) {
            if (target.strict) {
                throw new LintError(
                    "anthropic_messages output_config legalization requires output_config to be an object",
                );
            }
            return [];
        }
        if (config.effort == null) return [op];
        if (!target.model) {
            if (target.strict) {
                throw new LintError(
                    "anthropic_messages output_config.effort legalization requires llm.model",
                );
            }
            return [op];
        }
        const effort = legalizeEffortForModel(
            target.model,
            config.effort,
            target.strict === true,
        );
        const { effort: _effort, ...rest } = config;
        if (!effort) {
            return Object.keys(rest).length === 0
                ? []
                : [{ ...op, value: rest }];
        }
        return [{ ...op, value: { ...rest, effort } }];
    });
};

export const legalizeThinking: Pass = (
    program: Program,
    target,
): Program => {
    const thinkingOps = program.filter(
        (op) => op.op === "anthropic_messages.thinking",
    );
    if (thinkingOps.length === 0) return program;
    if (thinkingOps.length > 1 && target.strict) {
        throw new LintError(
            "anthropic_messages request: expected at most one thinking op",
        );
    }
    if (!target.model) {
        if (target.strict) {
            throw new LintError(
                "anthropic_messages thinking legalization requires llm.model",
            );
        }
        return program.filter((op) => op.op !== "anthropic_messages.thinking");
    }
    if (hasRawThinkingParam(program)) {
        if (target.strict) {
            throw new LintError(
                "anthropic_messages thinking legalization conflicts with raw thinking_config",
            );
        }
        return program.filter((op) => op.op !== "anthropic_messages.thinking");
    }

    const thinking = opData<{
        adaptiveEffort?: AnthropicEffort;
        manualBudgetTokens?: number;
        display?: "summarized" | "omitted";
    }>(thinkingOps[0]!);
    const replacement = thinkingParamsForModel(
        program,
        target.model,
        thinking,
        target.strict === true,
    );
    const replacesOutputConfig = replacement.some(
        (op) => op.op === "anthropic_messages.output_config",
    );

    return program.flatMap((op) => {
        if (op.op === "anthropic_messages.thinking") {
            return op === thinkingOps[0] ? replacement : [];
        }
        if (
            replacesOutputConfig &&
            op.op === "anthropic_messages.output_config"
        ) {
            return [];
        }
        return [op];
    });
};

function rejectsExplicitSampling(model?: string): boolean {
    return /^claude-(?:fable-5|mythos(?:-5|-preview)?|opus-4-[78]|sonnet-5)(?:-|$)/.test(
        model ?? "",
    );
}

function hasRawThinkingParam(program: Program): boolean {
    return program.some((op) => op.op === "anthropic_messages.thinking_config");
}

function thinkingParamsForModel(
    program: Program,
    model: string,
    thinking: {
        adaptiveEffort?: AnthropicEffort;
        manualBudgetTokens?: number;
        display?: "summarized" | "omitted";
    },
    strict: boolean,
): Op[] {
    if (usesAdaptiveThinking(model)) {
        const effort = legalizeEffortForModel(
            model,
            thinking.adaptiveEffort,
            strict,
        );
        return [
            {
                op: "anthropic_messages.thinking_config",
                value: {
                    type: "adaptive",
                    ...(thinking.display ? { display: thinking.display } : {}),
                },
            },
            ...(effort ? outputConfigWithEffort(program, effort, strict) : []),
        ];
    }

    const budget =
        thinking.manualBudgetTokens ??
        thinkingBudgetForEffort(thinking.adaptiveEffort ?? "medium");
    if (!isPositiveInteger(budget)) {
        if (!strict) return [];
        throw new LintError(
            `${model}: manual thinking requires a positive manualBudgetTokens value`,
        );
    }
    const maxTokens = firstOp(program, "llm.max_output_tokens") as
        OpOf<"llm.max_output_tokens"> | undefined;
    const legalBudget =
        maxTokens && budget >= maxTokens.value ? maxTokens.value - 1 : budget;
    if (!isPositiveInteger(legalBudget)) {
        if (!strict) return [];
        throw new LintError(
            `${model}: manual thinking budget_tokens must be less than max_tokens`,
        );
    }
    if (strict && maxTokens && budget >= maxTokens.value) {
        throw new LintError(
            `${model}: manual thinking budget_tokens must be less than max_tokens`,
        );
    }
    return [
        {
            op: "anthropic_messages.thinking_config",
            value: {
                type: "enabled",
                budget_tokens: legalBudget,
                ...(thinking.display ? { display: thinking.display } : {}),
            },
        },
    ];
}

function usesAdaptiveThinking(model: string): boolean {
    return /^claude-(?:sonnet-5|sonnet-4-6|opus-4-[678]|fable-5|mythos(?:-5|-preview)?)(?:-|$)/.test(
        model,
    );
}

function legalizeEffortForModel(
    model: string,
    effort: unknown,
    strict: boolean,
): AnthropicEffort | undefined {
    if (effort == null) return undefined;
    let parsed: AnthropicEffort;
    try {
        parsed = asThinkingEffort(
            effort,
            "output_config.effort",
        ) as AnthropicEffort;
    } catch (error) {
        if (strict) throw error;
        return undefined;
    }
    if (!supportsEffort(model)) {
        if (strict) {
            throw new LintError(
                `${model}: output_config.effort is not supported by the Anthropic Messages API`,
            );
        }
        return undefined;
    }
    if (parsed === "max") {
        if (strict) {
            throw new LintError(
                `${model}: output_config.effort "max" is not supported by the Anthropic Messages API`,
            );
        }
        return supportsXHighEffort(model) ? "xhigh" : "high";
    }
    if (parsed === "xhigh" && !supportsXHighEffort(model)) {
        if (strict) {
            throw new LintError(
                `${model}: output_config.effort "xhigh" is not supported by the Anthropic Messages API`,
            );
        }
        return "high";
    }
    return parsed;
}

function supportsEffort(model: string): boolean {
    return /^claude-(?:fable-5|mythos(?:-5|-preview)?|opus-4-[5678]|sonnet-5|sonnet-4-6)(?:-|$)/.test(
        model,
    );
}

function supportsXHighEffort(model: string): boolean {
    return /^claude-(?:fable-5|mythos-5|opus-4-[78]|sonnet-5)(?:-|$)/.test(
        model,
    );
}

function outputConfigWithEffort(
    program: Program,
    effort: AnthropicEffort,
    strict: boolean,
): Op[] {
    const existing = program.find(
        (op) => op.op === "anthropic_messages.output_config",
    );
    if (!existing) {
        return [
            {
                op: "anthropic_messages.output_config",
                value: { effort },
            },
        ];
    }

    const value = opData<{ value: unknown }>(existing).value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        if (!strict) {
            return [
                {
                    op: "anthropic_messages.output_config",
                    value: { effort },
                },
            ];
        }
        throw new LintError(
            "anthropic_messages thinking legalization requires output_config to be an object",
        );
    }
    const config = value as Record<string, unknown>;
    if ("effort" in config && config.effort !== effort) {
        if (!strict) {
            return [
                {
                    op: "anthropic_messages.output_config",
                    value: { ...config, effort },
                },
            ];
        }
        throw new LintError(
            "anthropic_messages thinking legalization conflicts with existing output_config.effort",
        );
    }

    return [
        {
            op: "anthropic_messages.output_config",
            value: { ...config, effort },
        },
    ];
}

function thinkingBudgetForEffort(effort: AnthropicEffort): number {
    switch (effort) {
        case "low":
            return 1024;
        case "medium":
            return 4096;
        case "high":
            return 8192;
        case "xhigh":
            return 16384;
        case "max":
            return 24576;
    }
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const legalizations: Pass[] = [
    defaultMaxTokens,
    legalizeUnsupportedSamplingParams,
    legalizeThinking,
    validateOutputConfigEffort,
];
