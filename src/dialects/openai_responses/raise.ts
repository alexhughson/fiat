// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import {
    opData,
    type Op,
    type Program,
    type StopReason,
} from "../../core/ops.js";
import { LintError } from "../../core/lint.js";
import { documentSourceFromUrl, imageSourceFromUrl } from "../../core/media.js";
import { stagePipeline, type Stage } from "../../core/rewrite.js";
import type {
    WireContentPart,
    WireFunctionCall,
    WireFunctionCallOutput,
    WireInputItem,
    WireOutputItem,
} from "./ops.js";

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
            return (
                raiseMessage(
                    item.role === "developer" ? "system" : item.role,
                    item.content,
                ) ?? [
                    {
                        op: "openai_responses.input",
                        item,
                        preservesContent: true,
                    },
                ]
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
        case "message": {
            const raised = raiseMessage("assistant", item.content);
            if (!raised) {
                throw new LintError(
                    "openai_responses output message: unsupported file-backed content part",
                );
            }
            return [
                ...raised,
                {
                    op: "openai_responses.output_meta",
                    item,
                    appliesTo: "response",
                },
            ];
        }
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
): Op[] | undefined {
    if (typeof content === "string") return [{ op: "llm.text", role, content }];
    const out: Op[] = [];
    for (const part of content) {
        switch (part.type) {
            case "input_text":
            case "output_text":
                if (typeof part.text !== "string") {
                    throw new LintError(
                        `openai_responses ${part.type} part: missing text`,
                    );
                }
                out.push({ op: "llm.text", role, content: part.text });
                break;
            case "input_image":
                if (isFileBackedInputImage(part)) return undefined;
                out.push(raiseImagePart(role, part));
                break;
            case "input_file":
                {
                    const document = raiseFilePart(role, part);
                    if (!document) return undefined;
                    out.push(document);
                    break;
                }
            default:
                throw new LintError(
                    `openai_responses message: unsupported content part type ${JSON.stringify(part.type)}`,
                );
        }
    }
    return out;
}

function isFileBackedInputImage(part: WireContentPart): boolean {
    return typeof part.file_id === "string";
}

function raiseFilePart(
    role: "system" | "user" | "assistant",
    part: WireContentPart,
): Op | undefined {
    if (role !== "user") {
        throw new LintError(
            `openai_responses input_file part: unsupported role ${JSON.stringify(role)}`,
        );
    }
    if (typeof part.file_id === "string") return undefined;
    assertOnlyKeys(
        part,
        ["type", "file_data", "file_url", "filename"],
        "openai_responses input_file part",
    );
    const sourceValue =
        typeof part.file_data === "string"
            ? part.file_data
            : typeof part.file_url === "string"
              ? part.file_url
              : undefined;
    if (!sourceValue) {
        throw new LintError(
            "openai_responses input_file part: expected file_id, file_data, or file_url",
        );
    }
    const source = documentSourceFromUrl(
        sourceValue,
        "openai_responses input_file",
    );
    return {
        op: "llm.document",
        role: "user",
        source:
            source.type === "base64"
                ? { ...source, filename: stringOrUndefined(part.filename) }
                : source,
    };
}

function stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function raiseImagePart(
    role: "system" | "user" | "assistant",
    part: WireContentPart,
): Op {
    if (role !== "user") {
        throw new LintError(
            `openai_responses input_image part: unsupported role ${JSON.stringify(role)}`,
        );
    }
    assertOnlyKeys(
        part,
        ["type", "image_url"],
        "openai_responses input_image part",
    );
    if (typeof part.image_url !== "string") {
        throw new LintError(
            "openai_responses input_image.image_url: expected a string",
        );
    }
    return {
        op: "llm.image",
        role: "user",
        source: imageSourceFromUrl(
            part.image_url,
            "openai_responses input_image.image_url",
        ),
    };
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

function assertOnlyKeys(
    value: Record<string, unknown>,
    keys: string[],
    what: string,
): void {
    const allowed = new Set(keys);
    const extra = Object.keys(value).filter((key) => !allowed.has(key));
    if (extra.length > 0)
        throw new LintError(`${what}: unsupported fields ${extra.join(", ")}`);
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
