// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import { opData, type Op, type Program, type StopReason } from "../../core/ops";
import { LintError } from "../../core/lint";
import { stagePipeline, type Stage } from "../../core/rewrite";
import type {
    WireContentPart,
    WireFunctionCall,
    WireFunctionCallOutput,
    WireInputItem,
    WireOutputItem,
} from "./ops";

export const raiseStages: Stage[] = [
    raiseInputs,
    raiseOutputs,
    raiseFinishReasons,
    raiseUsage,
];

export const raise: Stage = stagePipeline(raiseStages);

export function raiseInputs(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_responses.input"
            ? raiseInput(opData<{ item: WireInputItem }>(op).item)
            : [op],
    );
}

export function raiseOutputs(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_responses.output"
            ? raiseOutput(opData<{ item: WireOutputItem }>(op).item)
            : [op],
    );
}

export function raiseFinishReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "openai_responses.finish_reason"
            ? [
                  {
                      op: "response.stop",
                      reason: raiseFinishReason(
                          opData<{ reason: string }>(op).reason,
                      ),
                  } as Op,
              ]
            : [op],
    );
}

// Maps the cross-provider counts onto response.usage; any vendor-specific
// fields stay behind as a droppable residual.
export function raiseUsage(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "openai_responses.usage") return [op];
        const usageOp = opData<{
            usage: Record<string, unknown>;
            appliesTo?: "request" | "response";
        }>(op);
        const { input_tokens, output_tokens, ...rest } = usageOp.usage;
        const out: Op[] = [
            {
                op: "response.usage",
                ...(input_tokens != null
                    ? { inputTokens: input_tokens as number }
                    : {}),
                ...(output_tokens != null
                    ? { outputTokens: output_tokens as number }
                    : {}),
            },
        ];
        if (Object.keys(rest).length > 0) {
            out.push({
                op: "openai_responses.usage",
                usage: rest,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
            });
        }
        return out;
    });
}

function raiseInput(item: WireInputItem): Op[] {
    switch (item.type) {
        case undefined:
        case "message":
            return raiseMessage(
                item.role === "developer" ? "system" : item.role,
                item.content,
            );
        case "function_call":
            return [raiseFunctionCall(item)];
        case "function_call_output":
            return [raiseFunctionCallOutput(item)];
        default:
            throw new LintError(
                `openai_responses input: unsupported item type ${JSON.stringify((item as { type?: string }).type)}`,
            );
    }
}

function raiseOutput(item: WireOutputItem): Op[] {
    switch (item.type) {
        case "message":
            return [
                ...raiseMessage("assistant", item.content),
                {
                    op: "openai_responses.output_meta",
                    item,
                    appliesTo: "response",
                },
            ];
        case "function_call":
            return [
                raiseFunctionCall(item),
                {
                    op: "openai_responses.output_meta",
                    item,
                    appliesTo: "response",
                },
            ];
        default:
            throw new LintError(
                `openai_responses output: unsupported item type ${JSON.stringify((item as { type?: string }).type)}`,
            );
    }
}

function raiseMessage(
    role: "system" | "user" | "assistant",
    content: string | WireContentPart[],
): Op[] {
    if (typeof content === "string") return [{ op: "llm.text", role, content }];
    return content.map((part) => {
        if (
            (part.type !== "input_text" && part.type !== "output_text") ||
            typeof part.text !== "string"
        ) {
            throw new LintError(
                `openai_responses message: unsupported content part type ${JSON.stringify(part.type)}`,
            );
        }
        return { op: "llm.text", role, content: part.text };
    });
}

function raiseFunctionCall(item: WireFunctionCall): Op {
    const id = item.id ? `${item.call_id}|${item.id}` : item.call_id;
    return {
        op: "llm.tool_call",
        id,
        name: item.name,
        arguments: parseArguments(item.arguments, id),
    };
}

function raiseFunctionCallOutput(item: WireFunctionCallOutput): Op {
    return { op: "llm.tool_result", id: item.call_id, content: item.output };
}

function parseArguments(raw: string, callId: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = raw === "" ? {} : JSON.parse(raw);
    } catch {
        throw new Error(
            `openai_responses function call ${callId}: arguments are not valid JSON: ${raw}`,
        );
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            `openai_responses function call ${callId}: arguments must be a JSON object, got ${raw}`,
        );
    }
    return parsed as Record<string, unknown>;
}

function raiseFinishReason(reason: string): StopReason {
    switch (reason) {
        case "end_turn":
        case "max_tokens":
        case "tool_use":
        case "content_filter":
            return reason;
        default:
            throw new LintError(
                `openai_responses finish reason "${reason}" has no core stop reason mapping`,
            );
    }
}
