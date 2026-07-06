import { LintError } from "../../core/lint.js";
import { opData, type OpOf, type Program } from "../../core/ops.js";
import type { Target } from "../../core/rewrite.js";
import type { WireMessage } from "./ops.js";

export const omitReasoningEffortWithToolsForGPT55Chat = (
    program: Program,
    target: Target,
): Program => {
    if (target.model !== "gpt-5.5") return program;
    if (!hasFunctionTool(program)) return program;
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

export const legalizations: ((program: Program, target: Target) => Program)[] =
    [
        omitReasoningEffortWithToolsForGPT55Chat,
        useMaxCompletionTokensForReasoningChatModels,
        useDeveloperMessagesForReasoningChatModels,
        validateModalities,
    ];
