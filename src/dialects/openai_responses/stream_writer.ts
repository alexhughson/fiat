// A Responses stream names its items: every text delta of one message carries
// the same item_id, and the terminal event holds the whole response,
// including the output items the stream built. streamResponseToWire lowers
// one chunk alone, so it can do neither: it invents a fresh msg_ id per text
// delta event, and a terminal event built from one chunk holds only that
// chunk's fields. One writer lives for one stream and rewrites what the
// per-chunk lowering produced, so the events of one stream agree.

import type { Dialect, StreamWriter } from "../../core/registry.js";
import type { LowerOptions } from "../../core/pipeline.js";
import { lowerStreamResponsesToWire } from "../../core/pipeline.js";
import type { Op, Program } from "../../core/ops.js";
import { opData } from "../../core/ops.js";
import { asNumber, asRecord, asString } from "../../core/wire.js";
import type { WireFunctionCall, WireOutputItem } from "./ops.js";

export function createResponsesStreamWriter(
    dialect: Dialect,
    opts?: LowerOptions,
): StreamWriter {
    return new ResponsesStreamWriter(dialect, opts);
}

const TERMINAL_EVENT_TYPES = new Set([
    "response.completed",
    "response.incomplete",
    "response.failed",
]);

function namesItemId(op: Op): boolean {
    return (
        op.op === "openai_responses.body_field" &&
        opData<{ key: string }>(op).key === "item_id"
    );
}

function namesCallItem(op: Op): boolean {
    return (
        op.op === "openai_responses.body_field" &&
        opData<{ key: string }>(op).key === "item"
    );
}

interface MessageState {
    id: string;
    text: string;
    outputIndex: number;
    closed: boolean;
}

interface CallState {
    item: WireFunctionCall;
    outputIndex: number;
    argumentFragments: string;
}

type CollectedItem =
    | { kind: "message"; message: MessageState }
    | { kind: "call"; call: CallState };

function openMessageStatus(
    status: unknown,
): "in_progress" | "completed" | "incomplete" {
    if (
        status === "in_progress" ||
        status === "completed" ||
        status === "incomplete"
    ) {
        return status;
    }
    throw new Error(
        `openai_responses stream writer: response.status ${JSON.stringify(status)} is not a valid ResponseOutputMessage.status`,
    );
}

class ResponsesStreamWriter implements StreamWriter {
    private readonly items: CollectedItem[] = [];
    private currentMessage: MessageState | undefined;
    private nextOutputIndex = 0;
    private readonly callItems = new Map<string, CallState>();
    // Foreign streams number their own items. Remember both their indexes and
    // the indexes the writer assigns so later argument fragments find the call.
    private readonly callsByIndex = new Map<number, CallState>();
    private readonly pendingCallArguments = new Map<number, string>();

    constructor(
        private readonly dialect: Dialect,
        private readonly opts: LowerOptions | undefined,
    ) {}

    write(program: Program): unknown[] {
        // A chunk raised from openai_responses names its own items; a chunk
        // raised from another provider's stream does not, and the per-chunk
        // lowering invents a fresh item id for every delta event.
        const hasSourceItemId = program.some(namesItemId);
        const hasSourceCallItem = program.some(namesCallItem);
        this.assertCallIds(program);
        const events = lowerStreamResponsesToWire(
            this.dialect,
            program,
            this.opts,
        );
        return events.map((event) =>
            this.applyStreamState(
                asRecord(event, "stream event"),
                hasSourceItemId,
                hasSourceCallItem,
            ),
        );
    }

    private assertCallIds(program: Program): void {
        for (const op of program) {
            if (
                op.op === "response.tool_call_delta" &&
                op.name != null &&
                op.id == null
            ) {
                throw new Error(
                    "openai_responses stream writer: function call is missing call_id (response.tool_call_delta.id)",
                );
            }
        }
    }

    private applyStreamState(
        event: Record<string, unknown>,
        hasSourceItemId: boolean,
        hasSourceCallItem: boolean,
    ): unknown {
        if (event.item != null) this.rememberCallItem(event, hasSourceCallItem);
        switch (event.type) {
            case "response.output_text.delta":
                this.rememberMessage(event, hasSourceItemId);
                break;
            case "response.function_call_arguments.delta":
                this.rememberCallArguments(event, hasSourceItemId);
                break;
            default:
                if (
                    TERMINAL_EVENT_TYPES.has(
                        asString(event.type, "stream event.type"),
                    )
                ) {
                    this.fillTerminalResponse(event);
                }
        }
        return event;
    }

    private rememberMessage(
        event: Record<string, unknown>,
        hasSourceItemId: boolean,
    ): void {
        const sourceId = hasSourceItemId
            ? asString(event.item_id, "stream event.item_id")
            : undefined;
        if (
            this.currentMessage == null ||
            (hasSourceItemId && sourceId !== this.currentMessage.id)
        ) {
            const sourceIndex =
                event.output_index == null
                    ? 0
                    : asNumber(event.output_index, "stream event.output_index");
            const outputIndex = hasSourceItemId
                ? sourceIndex
                : this.nextOutputIndex++;
            this.nextOutputIndex = Math.max(
                this.nextOutputIndex,
                outputIndex + 1,
            );
            this.currentMessage = {
                id:
                    sourceId ??
                    `msg_${crypto.randomUUID().replaceAll("-", "")}`,
                text: "",
                outputIndex,
                closed: false,
            };
            this.items.push({
                kind: "message",
                message: this.currentMessage,
            });
        }
        if (!hasSourceItemId) {
            event.item_id = this.currentMessage.id;
            event.output_index = this.currentMessage.outputIndex;
        }
        this.currentMessage.text += asString(event.delta, "stream event.delta");
    }

    private rememberCallItem(
        event: Record<string, unknown>,
        hasSourceCallItem: boolean,
    ): void {
        let item = asRecord(
            event.item,
            "stream event.item",
        ) as unknown as WireFunctionCall;
        if (item.type !== "function_call") return;
        if (!hasSourceCallItem && item.id != null) {
            // ResponseFunctionToolCall.id is optional, so a foreign call must
            // not keep the id per-chunk lowering generated to fill the field.
            item = { ...item };
            delete item.id;
            event.item = item;
        }
        const sourceIndex =
            event.output_index == null
                ? 0
                : asNumber(event.output_index, "stream event.output_index");
        let call = this.findCall(item);
        if (call) {
            call.item = item;
        } else {
            const outputIndex = hasSourceCallItem
                ? sourceIndex
                : this.nextOutputIndex++;
            this.nextOutputIndex = Math.max(
                this.nextOutputIndex,
                outputIndex + 1,
            );
            call = {
                item,
                outputIndex,
                argumentFragments:
                    this.pendingCallArguments.get(sourceIndex) ?? "",
            };
            this.pendingCallArguments.delete(sourceIndex);
            this.items.push({ kind: "call", call });
            // Text that follows a call belongs to a new output message.
            if (this.currentMessage) this.currentMessage.closed = true;
            this.currentMessage = undefined;
        }
        for (const key of [item.id, item.call_id]) {
            if (typeof key === "string") this.callItems.set(key, call);
        }
        this.callsByIndex.set(sourceIndex, call);
        this.callsByIndex.set(call.outputIndex, call);
        if (!hasSourceCallItem) event.output_index = call.outputIndex;
    }

    private findCall(item: WireFunctionCall): CallState | undefined {
        for (const key of [item.id, item.call_id]) {
            if (typeof key !== "string") continue;
            const call = this.callItems.get(key);
            if (call) return call;
        }
        return undefined;
    }

    private rememberCallArguments(
        event: Record<string, unknown>,
        hasSourceItemId: boolean,
    ): void {
        // A chunk that holds a whole call lowers to one event that carries
        // the item and no delta; the item is the whole call already.
        if (typeof event.delta !== "string") return;
        const index =
            event.output_index == null
                ? 0
                : asNumber(event.output_index, "stream event.output_index");
        const itemId =
            typeof event.item_id === "string" ? event.item_id : undefined;
        const call =
            (itemId ? this.callItems.get(itemId) : undefined) ??
            this.callsByIndex.get(index);
        if (!call) {
            this.pendingCallArguments.set(
                index,
                (this.pendingCallArguments.get(index) ?? "") + event.delta,
            );
            return;
        }
        if (!hasSourceItemId) event.output_index = call.outputIndex;
        call.argumentFragments += event.delta;
    }

    private fillTerminalResponse(event: Record<string, unknown>): void {
        // The per-chunk lowering may have placed a response object that an
        // input op holds into the event; copy it so the collected items
        // never write into that object.
        const response = {
            ...asRecord(event.response ?? {}, "stream event.response"),
        };
        if (response.output != null) return;
        const output = this.collectedOutput(response.status);
        if (output.length === 0) return;
        response.output = output;
        event.response = response;
    }

    private collectedOutput(terminalStatus: unknown): WireOutputItem[] {
        return this.items.flatMap((entry): WireOutputItem[] => {
            if (entry.kind === "call") {
                const { item, argumentFragments } = entry.call;
                return [
                    {
                        ...item,
                        arguments: item.arguments || argumentFragments,
                    },
                ];
            }
            const { id, text, closed } = entry.message;
            if (text === "") return [];
            return [
                {
                    type: "message",
                    id,
                    role: "assistant",
                    status: closed
                        ? "completed"
                        : openMessageStatus(terminalStatus),
                    content: [
                        {
                            type: "output_text",
                            text,
                            annotations: [],
                        },
                    ],
                },
            ];
        });
    }
}
