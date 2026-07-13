import { LintError, lintOrWarn } from "../../core/lint.js";
import { opData, type OpOf, type Program, type ThinkingEffort } from "../../core/ops.js";
import type { Target } from "../../core/rewrite.js";
import type { WireMessage } from "./ops.js";

const OPENROUTER_PRIORITY_MODEL_PREFIXES = [
    "anthropic/",
    "google/",
    "openai/",
] as const;
const OPENROUTER_OPENAI_REASONING_MODEL_PREFIXES = [
    "openai/gpt-5",
    "openai/o",
    "xai/grok",
] as const;
const OPENROUTER_GEMINI_REASONING_MODEL_PREFIX = "google/gemini-3";

type OpenRouterReasoning = {
    effort: string;
    exclude: true;
};

function isOpenRouterTarget(target: Target): boolean {
    return target.variant === "openrouter";
}

export const omitReasoningEffortWithToolsForGPT55Chat = (
    program: Program,
    target: Target,
): Program => {
    if (target.model !== "gpt-5.5") return program;
    if (!hasFunctionTool(program)) return program;
    return program.filter((op) => op.op !== "llm.thinking");
};

export const dropUnsupportedThinkingEffort = (
    program: Program,
    target: Target,
): Program => {
    if (isOpenRouterTarget(target)) return program;
    const thinking = program.find(
        (op) => op.op === "llm.thinking",
    ) as OpOf<"llm.thinking"> | undefined;
    if (!thinking || thinking.effort !== "off") return program;
    lintOrWarn(
        target.strict,
        `${target.model ?? "openai_chat"}: reasoning_effort does not support llm.thinking effort "off"`,
    );
    return program.filter((op) => op.op !== "llm.thinking");
};

export const useMaxCompletionTokensForReasoningChatModels = (
    program: Program,
    target: Target,
): Program => {
    if (!target.model || !needsMaxCompletionTokens(target.model))
        return program;
    return program.map((op) => {
        if (op.op !== "llm.max_output_tokens") return op;
        return {
            op: "openai_chat.max_completion_tokens",
            value: (op as OpOf<"llm.max_output_tokens">).value,
        };
    });
};

export const useDeveloperMessagesForReasoningChatModels = (
    program: Program,
    target: Target,
): Program => {
    if (!target.model || !needsReasoningChatModel(target.model)) return program;
    return program.map((op) => {
        if (op.op !== "openai_chat.message") return op;
        const message = op.message as WireMessage;
        if (message.role !== "system") return op;
        return { ...op, message: { ...message, role: "developer" } };
    });
};

export const validateModalities = (
    program: Program,
    target: Target,
): Program => {
    const modalities = openAIChatModalities(program);
    if (modalities.size === 0) return program;
    if (!target.model) {
        throw new LintError(
            "openai_chat modality validation requires llm.model",
        );
    }
    for (const modality of modalities) {
        if (!supportsModality(target.model, modality)) {
            throw new LintError(
                `${target.model}: OpenAI Chat Completions does not support ${modality} input`,
            );
        }
    }
    return program;
};

function hasFunctionTool(program: Program): boolean {
    return program.some((op) => op.op === "llm.tool");
}

function needsMaxCompletionTokens(model: string): boolean {
    return needsReasoningChatModel(model);
}

function needsReasoningChatModel(model: string): boolean {
    return (
        model === "gpt-5" ||
        model.startsWith("gpt-5.") ||
        model.startsWith("gpt-5-") ||
        /^o\d(?:[.-]|$)/.test(model)
    );
}

function openAIChatModalities(program: Program): Set<string> {
    const modalities = new Set<string>();
    for (const op of program) {
        if (op.op !== "openai_chat.message") continue;
        const message = opData<{ message: WireMessage }>(op).message;
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type === "image_url") modalities.add("image");
            if (part.type === "input_audio") modalities.add("audio");
            if (part.type === "file") modalities.add("document");
        }
    }
    return modalities;
}

function supportsModality(model: string, modality: string): boolean {
    switch (modality) {
        case "image":
            return supportsOpenAIVision(model);
        case "audio":
            return /(?:^|-)audio(?:-|$)/.test(model);
        case "document":
            return supportsOpenAIVision(model);
        default:
            return false;
    }
}

function supportsOpenAIVision(model: string): boolean {
    return /^(?:gpt-5|gpt-4o|gpt-4\.1|o\d)(?:[.-]|$)/.test(model);
}

function serviceTierSupported(target: Target): boolean {
    return (
        isOpenRouterTarget(target) &&
        target.model != null &&
        isOpenRouterPriorityModel(target.model)
    );
}

export const validateServiceTier = (
    program: Program,
    target: Target,
): Program => {
    if (!program.some((op) => op.op === "llm.service_tier")) return program;
    if (!target.model) {
        throw new LintError(
            "openai_chat service_tier validation requires llm.model",
        );
    }
    if (serviceTierSupported(target)) return program;
    lintOrWarn(
        target.strict,
        isOpenRouterTarget(target)
            ? `Priority service tier is only supported for OpenRouter ${OPENROUTER_PRIORITY_MODEL_PREFIXES.join(", ")} model IDs. ${target.model} cannot express service_tier.`
            : `${target.model}: OpenAI Chat Completions cannot express llm.service_tier.`,
    );
    return program.filter((op) => op.op !== "llm.service_tier");
};

export const openRouterRequestOptions = (
    program: Program,
    target: Target,
): Program => {
    if (!isOpenRouterTarget(target) || !target.model) return program;

    let result = program;

    const serviceTierIndex = result.findIndex(
        (op) => op.op === "llm.service_tier",
    );
    if (serviceTierIndex >= 0) {
        const serviceTier = (
            result[serviceTierIndex] as OpOf<"llm.service_tier">
        ).value;
        result = [
            ...result.slice(0, serviceTierIndex),
            {
                op: "openai_chat.body_field",
                key: "service_tier",
                value: serviceTier,
            },
            ...result.slice(serviceTierIndex + 1),
        ];
    }

    const reasoning = openRouterReasoningForModel(target.model, result);
    if (reasoning === undefined) return result;

    const withoutThinking = result.filter((op) => op.op !== "llm.thinking");
    const withoutReasoningField = withoutThinking.filter(
        (op) =>
            !(
                op.op === "openai_chat.body_field" &&
                opData<{ key: string }>(op).key === "reasoning"
            ),
    );
    return [
        ...withoutReasoningField,
        {
            op: "openai_chat.body_field",
            key: "reasoning",
            value: reasoning,
        },
    ];
};

function isOpenRouterPriorityModel(model: string): boolean {
    return OPENROUTER_PRIORITY_MODEL_PREFIXES.some((prefix) =>
        model.startsWith(prefix),
    );
}

function isOpenRouterGeminiReasoningModel(model: string): boolean {
    return model
        .toLowerCase()
        .startsWith(OPENROUTER_GEMINI_REASONING_MODEL_PREFIX);
}

function isOpenRouterOpenAiReasoningModel(model: string): boolean {
    const modelId = model.toLowerCase();
    return OPENROUTER_OPENAI_REASONING_MODEL_PREFIXES.some((prefix) =>
        modelId.startsWith(prefix),
    );
}

function openRouterReasoningForModel(
    model: string,
    program: Program,
): OpenRouterReasoning | undefined {
    const thinking = program.find(
        (op) => op.op === "llm.thinking",
    ) as OpOf<"llm.thinking"> | undefined;
    if (!thinking) return undefined;

    if (isOpenRouterGeminiReasoningModel(model)) {
        return {
            effort:
                thinking.effort === "off"
                    ? "minimal"
                    : openRouterReasoningEffort(thinking.effort, model),
            exclude: true,
        };
    }

    if (!isOpenRouterOpenAiReasoningModel(model)) return undefined;

    return {
        effort:
            thinking.effort === "off"
                ? "none"
                : openRouterReasoningEffort(thinking.effort, model),
        exclude: true,
    };
}

function openRouterReasoningEffort(
    effort: ThinkingEffort,
    model: string,
): string {
    if (effort === "off") {
        throw new LintError(
            `OpenRouter model ${model}: llm.thinking effort "off" is handled before openRouterReasoningEffort`,
        );
    }
    if (effort === "minimal" && isOpenRouterOpenAiReasoningModel(model)) {
        throw new LintError(
            `OpenRouter model ${model} cannot use llm.thinking effort "minimal".`,
        );
    }
    if (effort === "max") {
        throw new LintError(
            `OpenRouter model ${model} cannot use llm.thinking effort "max".`,
        );
    }
    return effort;
}

export const legalizations: ((program: Program, target: Target) => Program)[] =
    [
        omitReasoningEffortWithToolsForGPT55Chat,
        dropUnsupportedThinkingEffort,
        validateServiceTier,
        openRouterRequestOptions,
        useMaxCompletionTokensForReasoningChatModels,
        useDeveloperMessagesForReasoningChatModels,
        validateModalities,
    ];
