// core IR -> lower IR, as pipelines of stages. Requests are purely per-op:
// each core op becomes one input item. Responses need one cross-op stage,
// collectOutputItems, which reunites core text/tool-call ops with the
// output_meta residuals raise left behind. Extend by appending to the stage
// arrays.

import type { Op, OpOf, Program } from "../../core/ops";
import { opData } from "../../core/ops";
import { LintError } from "../../core/pass";
import { stagePipeline, type Stage } from "../../core/rewrite";
import type {
    WireContentPart,
    WireFunctionCall,
    WireOutputItem,
    WireOutputMessage,
} from "./ops";

export const lowerRequestStages: Stage[] = [
    rejectStructuredOutput,
    lowerRequestTexts,
    lowerToolCalls,
    lowerToolResults,
];

export const lowerRequest: Stage = stagePipeline(lowerRequestStages);

export const lowerResponseStages: Stage[] = [
    lowerStopReasons,
    lowerUsageCounts,
    collectOutputItems,
];

export const lowerResponse: Stage = stagePipeline(lowerResponseStages);

export const lowerStreamResponseStages: Stage[] = [
    lowerStopReasons,
    lowerUsageCounts,
];

export const lowerStreamResponse: Stage = stagePipeline(
    lowerStreamResponseStages,
);

export function rejectStructuredOutput(program: Program): Program {
    for (const op of program) {
        if (op.op === "llm.output") {
            throw new LintError(
                "openai_responses structured output is not implemented yet — map llm.output to a response text format residual or remove it",
            );
        }
    }
    return program;
}

export function lowerRequestTexts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.text") return [op];
        const text = op as OpOf<"llm.text">;
        if (text.role === "system") return [op];
        return [
            {
                op: "openai_responses.input",
                item: {
                    type: "message" as const,
                    role: text.role,
                    content: [{ type: "input_text", text: text.content }],
                },
            },
        ];
    });
}

export function lowerToolCalls(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_call") return [op];
        const call = op as OpOf<"llm.tool_call">;
        return [
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call" as const,
                    call_id: call.id,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                },
            },
        ];
    });
}

export function lowerToolResults(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_result") return [op];
        const result = op as OpOf<"llm.tool_result">;
        return [
            {
                op: "openai_responses.input",
                item: {
                    type: "function_call_output" as const,
                    call_id: result.id,
                    output: result.content,
                },
            },
        ];
    });
}

export function lowerStopReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "response.stop"
            ? [
                  {
                      op: "openai_responses.finish_reason",
                      reason: lowerStopReason(
                          (op as OpOf<"response.stop">).reason,
                      ),
                  } as Op,
              ]
            : [op],
    );
}

export function lowerUsageCounts(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "response.usage") return [op];
        const counts = op as OpOf<"response.usage">;
        return [
            {
                op: "openai_responses.usage",
                usage: {
                    ...(counts.inputTokens != null
                        ? { input_tokens: counts.inputTokens }
                        : {}),
                    ...(counts.outputTokens != null
                        ? { output_tokens: counts.outputTokens }
                        : {}),
                },
            },
        ];
    });
}

// Rebuilds the response's output array. output_meta residuals (present when
// the program was raised from a real Responses API response) act as
// templates that consume the pending core ops in order; core ops with no
// meta left over get synthesized items.
export function collectOutputItems(program: Program): Program {
    const out: Program = [];
    const pendingTexts: OpOf<"llm.text">[] = [];
    const pendingToolCalls: OpOf<"llm.tool_call">[] = [];
    const output: WireOutputItem[] = [];

    for (const op of program) {
        switch (op.op) {
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new Error(
                        `openai_responses response lower: unexpected ${text.role} text in a response program`,
                    );
                }
                pendingTexts.push(text);
                break;
            }
            case "llm.tool_call": {
                pendingToolCalls.push(op as OpOf<"llm.tool_call">);
                break;
            }
            case "openai_responses.output_meta": {
                const meta = opData<{ item: Partial<WireOutputItem> }>(op).item;
                output.push(
                    outputFromMeta(meta, pendingTexts, pendingToolCalls),
                );
                pendingTexts.length = 0;
                pendingToolCalls.length = 0;
                break;
            }
            default:
                out.push(op);
        }
    }

    if (pendingTexts.length > 0) {
        output.push({
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
                {
                    type: "output_text",
                    text: pendingTexts.map((text) => text.content).join("\n"),
                    annotations: [],
                    logprobs: [],
                },
            ],
        });
    }
    for (const call of pendingToolCalls) {
        output.push({
            type: "function_call",
            status: "completed",
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
        });
    }
    for (const item of output)
        out.push({ op: "openai_responses.output", item });
    return out;
}

function outputFromMeta(
    meta: Partial<WireOutputItem>,
    pendingTexts: OpOf<"llm.text">[],
    pendingToolCalls: OpOf<"llm.tool_call">[],
): WireOutputItem {
    switch (meta.type) {
        case "message":
            if (pendingToolCalls.length > 0) {
                throw new LintError(
                    "openai_responses response lower: message output metadata cannot consume tool calls",
                );
            }
            return messageFromMeta(meta, pendingTexts);
        case "function_call":
            if (pendingTexts.length > 0) {
                throw new LintError(
                    "openai_responses response lower: function_call output metadata cannot consume text",
                );
            }
            const item = functionCallFromMeta(meta, pendingToolCalls);
            if (pendingToolCalls.length > 0) {
                throw new LintError(
                    "openai_responses response lower: more core tool call ops than output metadata",
                );
            }
            return item;
        default:
            throw new LintError(
                `openai_responses response lower: output metadata has unsupported type ${JSON.stringify(meta.type)}`,
            );
    }
}

function messageFromMeta(
    meta: Partial<WireOutputMessage>,
    texts: OpOf<"llm.text">[],
): WireOutputMessage {
    const content = meta.content
        ? contentFromTemplate(meta.content, texts)
        : synthesizedContent(texts);
    return {
        ...meta,
        type: "message",
        role: "assistant",
        status: meta.status ?? "completed",
        content,
    };
}

function contentFromTemplate(
    content: WireContentPart[],
    texts: OpOf<"llm.text">[],
): WireContentPart[] {
    let textIndex = 0;
    const updated = content.map((part) => {
        if (
            (part.type !== "input_text" && part.type !== "output_text") ||
            typeof part.text !== "string"
        ) {
            throw new LintError(
                `openai_responses response lower: unsupported content part type ${JSON.stringify(part.type)}`,
            );
        }
        const text = texts[textIndex];
        if (!text) {
            throw new LintError(
                "openai_responses response lower: fewer core text ops than output content parts",
            );
        }
        textIndex += 1;
        return { ...part, text: text.content };
    });
    if (textIndex !== texts.length) {
        throw new LintError(
            "openai_responses response lower: more core text ops than output content parts",
        );
    }
    return updated;
}

function synthesizedContent(texts: OpOf<"llm.text">[]): WireContentPart[] {
    if (texts.length === 0) return [];
    return [
        {
            type: "output_text",
            text: texts.map((text) => text.content).join("\n"),
            annotations: [],
            logprobs: [],
        },
    ];
}

function functionCallFromMeta(
    meta: Partial<WireFunctionCall>,
    toolCalls: OpOf<"llm.tool_call">[],
): WireFunctionCall {
    const index = meta.call_id
        ? toolCalls.findIndex((call) => call.id === meta.call_id)
        : toolCalls.length === 1
          ? 0
          : -1;
    if (index < 0) {
        throw new LintError(
            `openai_responses response lower: no core tool call for output metadata ${JSON.stringify(meta.call_id)}`,
        );
    }
    const [call] = toolCalls.splice(index, 1);
    if (!call) {
        throw new LintError(
            `openai_responses response lower: no core tool call for output metadata ${JSON.stringify(meta.call_id)}`,
        );
    }
    return {
        ...meta,
        type: "function_call",
        status: meta.status ?? "completed",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
    };
}

function lowerStopReason(
    reason: OpOf<"response.stop">["reason"],
): "end_turn" | "max_tokens" | "tool_use" | "content_filter" {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
            return "end_turn";
        case "max_tokens":
            return "max_tokens";
        case "tool_use":
            return "tool_use";
        case "content_filter":
        case "refusal":
            return "content_filter";
        case "pause_turn":
        case "model_context_window_exceeded":
            throw new LintError(
                `openai_responses stop reason "${reason}" has no finish reason mapping`,
            );
    }
}
