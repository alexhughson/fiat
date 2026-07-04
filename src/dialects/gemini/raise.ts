// lower IR -> core IR, as a pipeline of stages. Shared between requests and
// responses. Extend by appending a stage to `raiseStages`.

import { opData, type Op, type Program, type StopReason } from "../../core/ops";
import { LintError } from "../../core/pass";
import { stagePipeline, type Stage } from "../../core/rewrite";
import { asNumber, asRecord, asString } from "../../core/wire";
import type { GeminiPartMeta, WireContent, WirePart } from "./ops";

export const raiseStages: Stage[] = [
    raiseContents,
    raiseFinishReasons,
    raiseUsage,
];

export const raise: Stage = stagePipeline(raiseStages);

export const raiseStreamResponseStages: Stage[] = [
    raiseStreamContents,
    raiseFinishReasons,
    raiseUsage,
];

export const raiseStreamResponse: Stage = stagePipeline(
    raiseStreamResponseStages,
);

export function raiseContents(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "gemini.content") return [op];
        const contentOp = opData<{
            content: WireContent;
            appliesTo?: "request" | "response";
        }>(op);
        return raiseContent(contentOp.content, contentOp.appliesTo);
    });
}

export function raiseStreamContents(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "gemini.content") return [op];
        const contentOp = opData<{
            content: WireContent;
            appliesTo?: "request" | "response";
        }>(op);
        return raiseStreamContent(contentOp.content, contentOp.appliesTo);
    });
}

export function raiseFinishReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "gemini.finish_reason"
            ? [
                  {
                      op: "response.stop",
                      reason: raiseFinishReason(
                          opData<{ value: string }>(op).value,
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
        if (op.op !== "gemini.usage") return [op];
        const usageOp = opData<{
            usage: Record<string, unknown>;
            appliesTo?: "request" | "response";
        }>(op);
        const { promptTokenCount, candidatesTokenCount, ...rest } =
            usageOp.usage;
        const out: Op[] = [
            {
                op: "response.usage",
                ...(promptTokenCount != null
                    ? {
                          inputTokens: asNumber(
                              promptTokenCount,
                              "usageMetadata.promptTokenCount",
                          ),
                      }
                    : {}),
                ...(candidatesTokenCount != null
                    ? {
                          outputTokens: asNumber(
                              candidatesTokenCount,
                              "usageMetadata.candidatesTokenCount",
                          ),
                      }
                    : {}),
            },
        ];
        if (Object.keys(rest).length > 0) {
            out.push({
                op: "gemini.usage",
                usage: rest,
                ...(usageOp.appliesTo ? { appliesTo: usageOp.appliesTo } : {}),
                required: false,
            });
        }
        return out;
    });
}

function raiseContent(
    content: WireContent,
    appliesTo?: "request" | "response",
): Op[] {
    const role = content.role;
    if (role == null && appliesTo !== "response") {
        return [{ op: "gemini.content", content }];
    }
    if (role !== "user" && role !== "model") {
        throw new LintError(
            `gemini content: unsupported role ${JSON.stringify(role)}`,
        );
    }

    const coreRole = role === "model" ? "assistant" : "user";
    const out: Op[] = [];
    content.parts.forEach((part, index) => {
        const kind = partKind(part, appliesTo);
        if (!kind) {
            out.push({
                op: "gemini.content",
                content: { role, parts: [part] },
                ...(appliesTo ? { appliesTo } : {}),
            });
            return;
        }
        switch (kind) {
            case "text": {
                out.push({
                    op: "llm.text",
                    role: coreRole,
                    content: asString(part.text, "gemini part.text"),
                });
                pushPartMeta(out, part, { kind, index }, appliesTo);
                break;
            }
            case "functionCall": {
                if (role !== "model")
                    throw new LintError(
                        'gemini functionCall part: expected role "model"',
                    );
                const call = asRecord(part.functionCall, "gemini functionCall");
                assertOnlyKeys(
                    call,
                    ["name", "args", "id"],
                    "gemini functionCall",
                );
                const id =
                    call.id == null
                        ? `gemini_call_${index}`
                        : asString(call.id, "gemini functionCall.id");
                out.push({
                    op: "llm.tool_call",
                    id,
                    name: asString(call.name, "gemini functionCall.name"),
                    arguments:
                        call.args == null
                            ? {}
                            : asRecord(call.args, "gemini functionCall.args"),
                });
                pushPartMeta(
                    out,
                    part,
                    {
                        kind,
                        index,
                        id,
                        ...(call.id == null ? { idSource: "synthesized" } : {}),
                    },
                    appliesTo,
                );
                break;
            }
            case "functionResponse": {
                if (role !== "user")
                    throw new LintError(
                        'gemini functionResponse part: expected role "user"',
                    );
                const response = asRecord(
                    part.functionResponse,
                    "gemini functionResponse",
                );
                assertOnlyKeys(
                    response,
                    ["name", "response", "id"],
                    "gemini functionResponse",
                );
                const id = asString(response.id, "gemini functionResponse.id");
                const name = asString(
                    response.name,
                    "gemini functionResponse.name",
                );
                const responseBody =
                    response.response == null
                        ? undefined
                        : asRecord(
                              response.response,
                              "gemini functionResponse.response",
                          );
                out.push({
                    op: "llm.tool_result",
                    id,
                    content:
                        responseBody == null
                            ? "{}"
                            : JSON.stringify(responseBody),
                });
                pushPartMeta(
                    out,
                    part,
                    {
                        kind,
                        index,
                        id,
                        name,
                        ...(responseBody == null
                            ? {}
                            : { response: responseBody }),
                    },
                    appliesTo,
                );
                break;
            }
        }
    });
    return out;
}

function raiseStreamContent(
    content: WireContent,
    appliesTo?: "request" | "response",
): Op[] {
    const role = content.role;
    if (role !== "model") {
        throw new LintError(
            `gemini stream content: expected role "model", got ${JSON.stringify(role)}`,
        );
    }

    const out: Op[] = [];
    content.parts.forEach((part, index) => {
        const kind = partKind(part, appliesTo);
        switch (kind) {
            case "text":
                out.push({
                    op: "response.text_delta",
                    role: "assistant",
                    content: asString(part.text, "gemini part.text"),
                });
                pushPartMeta(out, part, { kind, index }, appliesTo);
                break;
            case "functionCall": {
                const call = asRecord(part.functionCall, "gemini functionCall");
                assertOnlyKeys(
                    call,
                    ["name", "args", "id"],
                    "gemini functionCall",
                );
                out.push({
                    op: "response.tool_call_delta",
                    index,
                    ...(call.id == null
                        ? {}
                        : { id: asString(call.id, "gemini functionCall.id") }),
                    name: asString(call.name, "gemini functionCall.name"),
                    arguments: JSON.stringify(
                        call.args == null
                            ? {}
                            : asRecord(call.args, "gemini functionCall.args"),
                    ),
                });
                pushPartMeta(
                    out,
                    part,
                    {
                        kind,
                        index,
                        ...(call.id == null
                            ? {}
                            : {
                                  id: asString(
                                      call.id,
                                      "gemini functionCall.id",
                                  ),
                              }),
                    },
                    appliesTo,
                );
                break;
            }
            case "functionResponse":
                throw new LintError(
                    "gemini stream functionResponse part has no response stream mapping",
                );
            case undefined:
                throw new LintError(
                    "gemini stream response part: unsupported native part without a core mapping",
                );
        }
    });
    return out;
}

function partKind(
    part: WirePart,
    appliesTo?: "request" | "response",
): GeminiPartMeta["kind"] | undefined {
    const kinds = ["text", "functionCall", "functionResponse"].filter(
        (key) => part[key] != null,
    );
    if (kinds.length === 0) {
        if (appliesTo === "response") {
            throw new LintError(
                "gemini response part: unsupported native part without a core mapping",
            );
        }
        return undefined;
    }
    if (kinds.length !== 1) {
        throw new LintError(
            `gemini part: expected exactly one known part field, got ${JSON.stringify(kinds)}`,
        );
    }
    return kinds[0] as GeminiPartMeta["kind"];
}

function pushPartMeta(
    out: Op[],
    part: WirePart,
    base: GeminiPartMeta,
    appliesTo?: "request" | "response",
): void {
    const meta = partExtras(part);
    if (
        Object.keys(meta).length > 0 ||
        base.kind === "functionResponse" ||
        base.idSource === "synthesized"
    ) {
        out.push({
            op: "gemini.part_meta",
            part: {
                ...base,
                ...(Object.keys(meta).length > 0 ? { meta } : {}),
            },
            required: false,
        });
    }
}

function partExtras(part: WirePart): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(part)) {
        if (
            key !== "text" &&
            key !== "functionCall" &&
            key !== "functionResponse"
        )
            extras[key] = value;
    }
    return extras;
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

const FINISH_REASON_TO_STOP: Record<string, StopReason> = {
    STOP: "end_turn",
    MAX_TOKENS: "max_tokens",
    SAFETY: "content_filter",
};

export function raiseFinishReason(value: string): StopReason {
    const reason = FINISH_REASON_TO_STOP[value];
    if (!reason)
        throw new LintError(
            `gemini finishReason "${value}" has no core stop reason mapping`,
        );
    return reason;
}

export function lowerFinishReason(reason: StopReason): string {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
            return "STOP";
        case "max_tokens":
            return "MAX_TOKENS";
        case "content_filter":
        case "refusal":
            return "SAFETY";
        case "tool_use":
            throw new LintError(
                "gemini response.stop tool_use has no finishReason mapping",
            );
        case "pause_turn":
        case "model_context_window_exceeded":
            throw new LintError(
                `gemini response.stop ${reason} has no finishReason mapping`,
            );
    }
}
