import type { OpOf, Program } from "../../core/ops";
import type { Pass } from "../../core/pass";

export const omitReasoningEffortWithToolsForGPT55Chat: Pass = (
    program: Program,
    target,
): Program => {
    if (target.model !== "gpt-5.5") return program;
    if (!hasFunctionTool(program)) return program;
    return program.filter((op) => op.op !== "llm.thinking");
};

export const useMaxCompletionTokensForReasoningChatModels: Pass = (
    program: Program,
    target,
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

function hasFunctionTool(program: Program): boolean {
    return program.some((op) => op.op === "llm.tool");
}

function needsMaxCompletionTokens(model: string): boolean {
    return (
        model === "gpt-5" ||
        model.startsWith("gpt-5.") ||
        model.startsWith("gpt-5-") ||
        /^o\d(?:[.-]|$)/.test(model)
    );
}

export const legalizations: Pass[] = [
    omitReasoningEffortWithToolsForGPT55Chat,
    useMaxCompletionTokensForReasoningChatModels,
];
