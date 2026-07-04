// core IR -> lower IR, as pipelines of stages. Requests are per-op: each
// core op becomes one conversation.item.create event (config ops that have
// no event-wire home are rejected up front). Responses need one cross-op
// stage, collectOutputItems, which reunites core ops with the output_meta
// residuals raise left behind. Extend by appending to the stage arrays.

import { opData, type Op, type OpOf, type Program } from "../../core/ops";
import { LintError } from "../../core/pass";
import { stagePipeline, type Stage } from "../../core/rewrite";
import { lowerStopReason } from "./raise";
import type {
    WireConversationItemCreateEvent,
    WireFunctionCallItem,
    WireOutputItem,
    WireOutputMessage,
} from "./ops";

export const lowerRequestStages: Stage[] = [
    rejectSessionConfig,
    lintMidConversationSystem,
    lowerRequestTexts,
    lowerToolCalls,
    lowerToolResults,
    collectRequestItems,
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

// Sampling remains session/model dependent in Realtime GA. Model is accepted
// here because the calls validation body needs it beside the event batch.
export function rejectSessionConfig(program: Program): Program {
    for (const op of program) {
        if (op.op === "llm.temperature") {
            throw new LintError(
                "openai_realtime event wire does not map llm.temperature; configure sampling on the session if needed",
            );
        }
        if (op.op === "llm.output") {
            throw new LintError(
                "openai_realtime structured output is not implemented for event wire; map llm.output before lowering",
            );
        }
    }
    return program;
}

// System text lowers into the session instructions slot ahead of the
// conversation, so a system op after the conversation has started cannot be
// placed without reordering.
export function lintMidConversationSystem(program: Program): Program {
    let sawConversationItem = false;
    for (const op of program) {
        switch (op.op) {
            case "llm.text":
                if ((op as OpOf<"llm.text">).role === "system") {
                    if (sawConversationItem) {
                        throw new LintError(
                            "openai_realtime cannot lower interleaved system text without reordering conversation events",
                        );
                    }
                } else {
                    sawConversationItem = true;
                }
                break;
            case "llm.tool_call":
            case "llm.tool_result":
            case "openai_realtime.item":
                sawConversationItem = true;
                break;
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
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    item: messageItem(text.role, text.content),
                },
            },
        ];
    });
}

export function lowerToolCalls(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_call") return [op];
        return [
            {
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    item: functionCallItem(op as OpOf<"llm.tool_call">),
                },
            },
        ];
    });
}

export function lowerToolResults(program: Program): Program {
    return program.flatMap((op) => {
        if (op.op !== "llm.tool_result") return [op];
        const result = op as OpOf<"llm.tool_result">;
        if (result.isError) {
            throw new LintError(
                "openai_realtime function_call_output has no error flag; map llm.tool_result.isError before lowering",
            );
        }
        return [
            {
                op: "openai_realtime.item",
                event: {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: result.id,
                        output: result.content,
                    },
                },
            },
        ];
    });
}

export function collectRequestItems(program: Program): Program {
    const out: Program = [];
    const pending: WireConversationItemCreateEvent[] = [];

    const flushPending = () => {
        for (const event of pending) {
            out.push({ op: "openai_realtime.item", event });
        }
        pending.length = 0;
    };

    for (const op of program) {
        switch (op.op) {
            case "openai_realtime.item":
                pending.push(
                    opData<{ event: WireConversationItemCreateEvent }>(op)
                        .event,
                );
                break;
            case "openai_realtime.item_meta":
                out.push({
                    op: "openai_realtime.item",
                    event: requestEventFromTemplate(
                        opData<{ event: WireConversationItemCreateEvent }>(op)
                            .event,
                        pending,
                    ),
                });
                pending.length = 0;
                break;
            default:
                flushPending();
                out.push(op);
        }
    }
    flushPending();
    return out;
}

export function lowerStopReasons(program: Program): Program {
    return program.flatMap((op) =>
        op.op === "response.stop"
            ? [
                  {
                      op: "openai_realtime.finish_reason",
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
                op: "openai_realtime.usage",
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

// Rebuilds the response.done output array. A message-type output_meta acts
// as an item boundary: it closes over the assistant text accumulated since
// the previous boundary, so a response raised from two message items lowers
// back to two items with their own ids — not one merged item. Trailing text
// with no meta (a program that never came from this wire) gets a
// synthesized item. Tool calls become function_call items, matched to their
// meta by call_id.
export function collectOutputItems(program: Program): Program {
    const out: Program = [];
    const texts: string[] = [];
    const toolCalls: OpOf<"llm.tool_call">[] = [];
    const output: WireOutputItem[] = [];

    const closeMessage = (meta: Partial<WireOutputMessage>) => {
        if (toolCalls.length > 0) {
            throw new LintError(
                "openai_realtime response lower: message output metadata cannot consume earlier tool calls",
            );
        }
        output.push({
            ...meta,
            type: "message",
            role: "assistant",
            status: meta.status ?? "completed",
            content: outputContentFromTemplate(meta, texts),
        });
        texts.length = 0;
    };

    for (const op of program) {
        switch (op.op) {
            case "llm.text": {
                const text = op as OpOf<"llm.text">;
                if (text.role !== "assistant") {
                    throw new Error(
                        `openai_realtime response lower: unexpected ${text.role} text in a response program`,
                    );
                }
                texts.push(text.content);
                break;
            }
            case "llm.tool_call":
                toolCalls.push(op as OpOf<"llm.tool_call">);
                break;
            case "llm.tool_result":
                throw new LintError(
                    "openai_realtime response.done cannot contain client function_call_output items",
                );
            case "openai_realtime.output_meta": {
                const meta = opData<{ item: Partial<WireOutputItem> }>(op).item;
                if (meta.type === "message") {
                    closeMessage(meta);
                    break;
                }
                if (meta.type === "function_call") {
                    if (texts.length > 0) {
                        throw new LintError(
                            "openai_realtime response lower: function_call output metadata cannot consume text",
                        );
                    }
                    output.push(functionCallFromMeta(meta, toolCalls));
                    break;
                }
                throw new LintError(
                    `openai_realtime response lower: output metadata has unsupported type ${JSON.stringify(meta.type)}`,
                );
            }
            default:
                out.push(op);
        }
    }
    if (texts.length > 0) closeMessage({});

    for (const call of toolCalls) {
        output.push({
            type: "function_call",
            status: "completed",
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
        });
    }
    for (const item of output) out.push({ op: "openai_realtime.output", item });
    return out;
}

function functionCallFromMeta(
    meta: Partial<WireFunctionCallItem>,
    toolCalls: OpOf<"llm.tool_call">[],
): WireFunctionCallItem {
    const index = meta.call_id
        ? toolCalls.findIndex((call) => call.id === meta.call_id)
        : toolCalls.length === 1
          ? 0
          : -1;
    if (index < 0) {
        throw new LintError(
            `openai_realtime response lower: no core tool call for output metadata ${JSON.stringify(meta.call_id)}`,
        );
    }
    const [call] = toolCalls.splice(index, 1);
    if (!call) {
        throw new LintError(
            `openai_realtime response lower: no core tool call for output metadata ${JSON.stringify(meta.call_id)}`,
        );
    }
    return {
        type: "function_call",
        status: "completed",
        ...meta,
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
    };
}

function requestEventFromTemplate(
    template: WireConversationItemCreateEvent,
    pending: WireConversationItemCreateEvent[],
): WireConversationItemCreateEvent {
    switch (template.item.type) {
        case "message":
            return {
                ...template,
                item: {
                    ...template.item,
                    content: requestContentFromTemplate(template, pending),
                },
            };
        case "function_call": {
            const call = onlyPendingItem(template, pending, "function_call");
            return {
                ...template,
                item: {
                    ...template.item,
                    call_id: call.call_id,
                    name: call.name,
                    arguments: call.arguments,
                },
            };
        }
        case "function_call_output": {
            const result = onlyPendingItem(
                template,
                pending,
                "function_call_output",
            );
            return {
                ...template,
                item: {
                    ...template.item,
                    call_id: result.call_id,
                    output: result.output,
                },
            };
        }
        default:
            throw new LintError(
                `openai_realtime request lower: item metadata has unsupported type ${JSON.stringify((template.item as { type?: string }).type)}`,
            );
    }
}

function requestContentFromTemplate(
    template: WireConversationItemCreateEvent,
    pending: WireConversationItemCreateEvent[],
) {
    const texts = pending.flatMap((event) => {
        if (event.item.type !== "message") {
            throw new LintError(
                "openai_realtime request lower: message item metadata cannot consume tool items",
            );
        }
        if (event.item.role !== template.item.role) {
            throw new LintError(
                "openai_realtime request lower: message item metadata role does not match core text",
            );
        }
        return event.item.content.map((part) => {
            if (typeof part.text !== "string") {
                throw new LintError(
                    `openai_realtime request lower: pending text part has no text`,
                );
            }
            return part.text;
        });
    });
    let index = 0;
    const templateItem = template.item as WireOutputMessage;
    const content = templateItem.content.map((part) => {
        if (
            (part.type !== "input_text" && part.type !== "output_text") ||
            typeof part.text !== "string"
        ) {
            return part;
        }
        const text = texts[index];
        if (text == null) {
            throw new LintError(
                "openai_realtime request lower: fewer core text ops than item metadata content parts",
            );
        }
        index += 1;
        return { ...part, text };
    });
    if (index !== texts.length) {
        throw new LintError(
            "openai_realtime request lower: more core text ops than item metadata content parts",
        );
    }
    return content;
}

function onlyPendingItem<
    T extends WireConversationItemCreateEvent["item"]["type"],
>(
    template: WireConversationItemCreateEvent,
    pending: WireConversationItemCreateEvent[],
    type: T,
): Extract<WireConversationItemCreateEvent["item"], { type: T }> {
    if (pending.length !== 1 || pending[0]?.item.type !== type) {
        throw new LintError(
            `openai_realtime request lower: ${type} metadata cannot consume ${pending.length} pending item(s)`,
        );
    }
    if (pending[0].item.type !== template.item.type) {
        throw new LintError(
            "openai_realtime request lower: item metadata type does not match core item",
        );
    }
    return pending[0].item as Extract<
        WireConversationItemCreateEvent["item"],
        { type: T }
    >;
}

function outputContentFromTemplate(
    meta: Partial<WireOutputMessage>,
    texts: string[],
) {
    if (!meta.content) {
        return [{ type: "output_text", text: texts.join("\n") }];
    }
    let index = 0;
    const content = meta.content.map((part) => {
        if (
            (part.type !== "input_text" && part.type !== "output_text") ||
            typeof part.text !== "string"
        ) {
            return part;
        }
        const text = texts[index];
        if (text == null) {
            throw new LintError(
                "openai_realtime response lower: fewer core text ops than output metadata content parts",
            );
        }
        index += 1;
        return { ...part, text };
    });
    if (index !== texts.length) {
        throw new LintError(
            "openai_realtime response lower: more core text ops than output metadata content parts",
        );
    }
    return content;
}

function messageItem(role: "user" | "assistant", text: string) {
    return {
        type: "message" as const,
        role,
        content: [
            { type: role === "assistant" ? "output_text" : "input_text", text },
        ],
    };
}

function functionCallItem(op: OpOf<"llm.tool_call">) {
    return {
        type: "function_call" as const,
        call_id: op.id,
        name: op.name,
        arguments: JSON.stringify(op.arguments),
    };
}
