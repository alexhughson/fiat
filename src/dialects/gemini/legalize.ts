// Target-scoped Gemini Generate Content checks that depend on model family.

import { opData, type Program } from "../../core/ops";
import { LintError, type Pass } from "../../core/pass";

export const legalizeThinkingLevel: Pass = (
    program: Program,
    target,
): Program => {
    if (!programHasThinkingLevel(program)) return program;
    if (!target.model) {
        if (target.strict) {
            throw new LintError(
                "gemini thinkingLevel legalization requires llm.model",
            );
        }
        return program;
    }
    if (supportsThinkingLevel(target.model)) {
        return program.map((op) =>
            op.op === "gemini.generation_config"
                ? legalizeGemini3ThinkingLevel(op, target.strict === true)
                : op,
        );
    }
    if (target.strict) {
        throw new LintError(
            `${target.model}: generationConfig.thinkingConfig.thinkingLevel is only supported by Gemini 3 or later generateContent models`,
        );
    }
    return program.map((op) =>
        op.op === "gemini.generation_config" ? thinkingLevelToBudget(op) : op,
    );
};

function programHasThinkingLevel(program: Program): boolean {
    return program.some((op) => {
        if (op.op !== "gemini.generation_config") return false;
        const config = opData<{ value: Record<string, unknown> }>(op).value;
        if (!isRecord(config)) return false;
        const thinkingConfig = config.thinkingConfig;
        return isRecord(thinkingConfig) && thinkingConfig.thinkingLevel != null;
    });
}

function supportsThinkingLevel(model: string): boolean {
    return /^(?:models\/)?gemini-3(?:[.-]|$)/.test(model);
}

function legalizeGemini3ThinkingLevel(op: Program[number], strict: boolean) {
    const config = opData<{ value: Record<string, unknown> }>(op).value;
    if (!isRecord(config)) return op;
    const thinkingConfig = config.thinkingConfig;
    if (!isRecord(thinkingConfig)) return op;
    const level = normalizedLevel(thinkingConfig.thinkingLevel);
    if (level !== "xhigh" && level !== "max") return op;
    if (strict) {
        throw new LintError(
            `gemini: generationConfig.thinkingConfig.thinkingLevel does not support effort "${level}"`,
        );
    }
    return {
        ...op,
        value: {
            ...config,
            thinkingConfig: { ...thinkingConfig, thinkingLevel: "high" },
        },
    };
}

function thinkingLevelToBudget(op: Program[number]) {
    const config = opData<{ value: Record<string, unknown> }>(op).value;
    if (!isRecord(config)) return op;
    const thinkingConfig = config.thinkingConfig;
    if (!isRecord(thinkingConfig)) return op;
    const { thinkingLevel: _thinkingLevel, ...restThinking } = thinkingConfig;
    const budget = thinkingBudgetForLevel(thinkingConfig.thinkingLevel);
    return {
        ...op,
        value: {
            ...config,
            thinkingConfig: {
                ...restThinking,
                ...(budget == null ? {} : { thinkingBudget: budget }),
            },
        },
    };
}

function thinkingBudgetForLevel(level: unknown): number | undefined {
    switch (normalizedLevel(level)) {
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
        default:
            return undefined;
    }
}

function normalizedLevel(level: unknown): string | undefined {
    return typeof level === "string" ? level.toLowerCase() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const legalizations: Pass[] = [legalizeThinkingLevel];
