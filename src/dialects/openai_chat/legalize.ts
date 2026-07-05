import type { OpOf, Program } from "../../core/ops";
import type { Target } from "../../core/rewrite";
import type { WireMessage } from "./ops";

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

export const legalizations: ((program: Program, target: Target) => Program)[] =
    [
        omitReasoningEffortWithToolsForGPT55Chat,
        useMaxCompletionTokensForReasoningChatModels,
        useDeveloperMessagesForReasoningChatModels,
    ];
