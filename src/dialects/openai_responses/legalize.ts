import { LintError } from "../../core/lint.js";
import { opData, type Program } from "../../core/ops.js";
import type { Target } from "../../core/rewrite.js";
import type { WireInputItem } from "./ops.js";

export const validateModalities = (
    program: Program,
    target: Target,
): Program => {
    const modalities = openAIResponsesModalities(program);
    if (modalities.size === 0) return program;
    if (!target.model) {
        throw new LintError(
            "openai_responses modality validation requires llm.model",
        );
    }
    for (const modality of modalities) {
        if (!supportsModality(target.model, modality)) {
            throw new LintError(
                `${target.model}: OpenAI Responses does not support ${modality} input`,
            );
        }
    }
    return program;
};

function openAIResponsesModalities(program: Program): Set<string> {
    const modalities = new Set<string>();
    for (const op of program) {
        if (op.op !== "openai_responses.input") continue;
        const item = opData<{ item: WireInputItem }>(op).item;
        if (item.type !== "message" || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (part.type === "input_image") modalities.add("image");
            if (part.type === "input_file") modalities.add("document");
        }
    }
    return modalities;
}

function supportsModality(model: string, modality: string): boolean {
    switch (modality) {
        case "image":
        case "document":
            return /^(?:gpt-5|gpt-4o|gpt-4\.1|o\d)(?:[.-]|$)/.test(model);
        default:
            return false;
    }
}

export const legalizations: ((program: Program, target: Target) => Program)[] =
    [validateModalities];
