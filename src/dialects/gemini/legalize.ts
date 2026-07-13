// Target-scoped Gemini Generate Content checks that depend on model family.

import { LintError, lintOrWarn } from "../../core/lint.js";
import { mediaKindForType } from "../../core/media.js";
import {
    opData,
    type Op,
    type Program,
    type ThinkingEffort,
} from "../../core/ops.js";
import type { Target } from "../../core/rewrite.js";
import type { WireContent } from "./ops.js";

// Consumes the model-free gemini.thinking carrier lowerThinking produces and
// picks the wire shape for the target model: thinkingLevel for Gemini 3,
// thinkingBudget for Gemini 2.5, dropped (with a warning/error) for anything
// else. Runs after lower and after any afterLower hook, same as
// legalizeThinkingLevel, but keeps its own messages distinguishable from that
// legalization's — the two are pinned separately by tests because they react to
// different inputs (an llm.thinking effort here vs. a wire-supplied
// thinkingLevel there) and lenient mode should say which one fired.
export const legalizeGeminiThinking = (
    program: Program,
    target: Target,
): Program => {
    // lowerThinking already dedupes llm.thinking to at most one gemini.thinking
    // op; this just needs to find it.
    const thinkingOp = program.find((op) => op.op === "gemini.thinking");
    if (!thinkingOp) return program;
    const thinking = opData<{ effort: ThinkingEffort }>(thinkingOp);

    const withoutThinking = program.filter((op) => op.op !== "gemini.thinking");

    if (!target.model) {
        lintOrWarn(
            target.strict,
            "gemini thinking legalization: gemini.thinking requires llm.model",
        );
        return withoutThinking;
    }

    const thinkingConfig = thinkingConfigForModel(
        target.model,
        thinking.effort,
        target.strict === true,
    );
    if (!thinkingConfig) return withoutThinking;

    return mergeGenerationConfig(withoutThinking, {
        thinkingConfig,
    });
};

function thinkingConfigForModel(
    model: string,
    effort: string,
    strict: boolean,
): Record<string, unknown> | undefined {
    if (supportsThinkingLevel(model)) {
        const level = thinkingLevelForModel(model, effort);
        if (level) return { thinkingLevel: level };
        lintOrWarn(
            strict,
            `${model}: generationConfig.thinkingConfig.thinkingLevel does not support llm.thinking effort "${effort}", clamped to "HIGH"`,
        );
        return { thinkingLevel: "HIGH" };
    }
    if (supportsThinkingBudget(model)) {
        return { thinkingBudget: thinkingBudgetForLevel(effort) };
    }
    lintOrWarn(
        strict,
        `${model}: llm.thinking is only supported by Gemini 3 thinkingLevel models or Gemini 2.5 thinkingBudget models`,
    );
    return undefined;
}

function thinkingLevelForModel(
    model: string,
    effort: string,
): "LOW" | "MEDIUM" | "HIGH" | undefined {
    switch (normalizedLevel(effort)) {
        case "minimal":
        case "low":
            return "LOW";
        case "medium":
            return supportsFlashThinkingLevel(model) ? "MEDIUM" : "HIGH";
        case "high":
            return "HIGH";
        default:
            return undefined;
    }
}

function supportsThinkingBudget(model: string): boolean {
    return /^(?:models\/)?gemini-2\.5(?:[.-]|$)/.test(model);
}

function mergeGenerationConfig(
    program: Program,
    config: Record<string, unknown>,
): Program {
    const generationConfigIndexes: number[] = [];
    for (let index = 0; index < program.length; index++) {
        if (program[index]!.op === "gemini.generation_config") {
            generationConfigIndexes.push(index);
        }
    }
    if (generationConfigIndexes.length === 0) {
        return [
            ...program,
            { op: "gemini.generation_config", value: config } as Op,
        ];
    }

    for (const index of generationConfigIndexes) {
        const existing = opData<{ value: unknown }>(program[index]!).value;
        if (!isRecord(existing)) {
            throw new LintError(
                "gemini thinking legalization: generationConfig must be an object to merge llm.thinking",
            );
        }
        for (const key of Object.keys(config)) {
            if (key in existing) {
                throw new LintError(
                    `gemini thinking legalization: llm.thinking conflicts with existing generationConfig.${key}`,
                );
            }
        }
    }

    const lastIndex =
        generationConfigIndexes[generationConfigIndexes.length - 1]!;
    return program.map((op, index) =>
        index === lastIndex
            ? {
                  ...op,
                  value: {
                      ...opData<{ value: Record<string, unknown> }>(op).value,
                      ...config,
                  },
              }
            : op,
    );
}

export const legalizeThinkingLevel = (
    program: Program,
    target: Target,
): Program => {
    if (!programHasThinkingLevel(program)) return program;
    if (!target.model) {
        lintOrWarn(
            target.strict,
            "gemini thinkingLevel legalization requires llm.model",
        );
        return program;
    }
    if (supportsThinkingLevel(target.model)) {
        return program.map((op) =>
            op.op === "gemini.generation_config"
                ? legalizeGemini3ThinkingLevel(
                      op,
                      target.model!,
                      target.strict === true,
                  )
                : op,
        );
    }
    lintOrWarn(
        target.strict,
        `${target.model}: generationConfig.thinkingConfig.thinkingLevel is only supported by Gemini 3 or later generateContent models`,
    );
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

function supportsFlashThinkingLevel(model: string): boolean {
    return /^(?:models\/)?gemini-3(?:\.\d+)?-flash(?:[.-]|$)/.test(model);
}

function legalizeGemini3ThinkingLevel(
    op: Program[number],
    model: string,
    strict: boolean,
) {
    const config = opData<{ value: Record<string, unknown> }>(op).value;
    if (!isRecord(config)) return op;
    const thinkingConfig = config.thinkingConfig;
    if (!isRecord(thinkingConfig)) return op;
    const level = normalizedLevel(thinkingConfig.thinkingLevel);
    const supported = thinkingLevelForModel(model, level ?? "");
    if (supported) {
        return {
            ...op,
            value: {
                ...config,
                thinkingConfig: {
                    ...thinkingConfig,
                    thinkingLevel: supported,
                },
            },
        };
    }
    if (!needsHighClamp(level)) return op;
    lintOrWarn(
        strict,
        `gemini: generationConfig.thinkingConfig.thinkingLevel does not support effort "${level}", clamped to "high"`,
    );
    return {
        ...op,
        value: {
            ...config,
            thinkingConfig: { ...thinkingConfig, thinkingLevel: "HIGH" },
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
        case "minimal":
            return 512;
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

// Shared by both thinkingLevel legalizations: thinkingLevel has no wire
// representation above "high", so any effort/level past it clamps down
// rather than being sent as-is.
function needsHighClamp(level: string | undefined): boolean {
    return level === "xhigh" || level === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const validateModalities = (
    program: Program,
    target: Target,
): Program => {
    const modalities = geminiModalities(program);
    if (modalities.size === 0) return program;
    if (!target.model) {
        throw new LintError("gemini modality validation requires llm.model");
    }
    if (!/^(?:models\/)?gemini(?:[.-]|$)/.test(target.model)) {
        throw new LintError(
            `${target.model}: Gemini GenerateContent does not support multimodal input`,
        );
    }
    return program;
};

function geminiModalities(program: Program): Set<string> {
    const modalities = new Set<string>();
    for (const op of program) {
        if (op.op === "llm.audio") modalities.add("audio");
        if (op.op === "llm.document") modalities.add("document");
        if (op.op === "llm.video") modalities.add("video");
        if (op.op !== "gemini.content") continue;
        const content = opData<{ content: WireContent }>(op).content;
        for (const part of content.parts) {
            const inlineData = part.inline_data;
            if (!isRecord(inlineData)) continue;
            const mediaType = inlineData.mime_type;
            if (typeof mediaType !== "string") continue;
            const kind = mediaKindForType(mediaType);
            if (kind) modalities.add(kind);
        }
    }
    return modalities;
}

export const validateServiceTier = (
    program: Program,
    target: Target,
): Program => {
    if (!program.some((op) => op.op === "llm.service_tier")) return program;
    const model = target.model ?? "unknown model";
    throw new LintError(`${model}: Gemini cannot express llm.service_tier.`);
};

export const legalizations: ((program: Program, target: Target) => Program)[] =
    [
        legalizeGeminiThinking,
        legalizeThinkingLevel,
        validateModalities,
        validateServiceTier,
    ];
