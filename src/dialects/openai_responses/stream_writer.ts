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

function namesTextItem(op: Op): boolean {
    return (
        op.op === "openai_responses.body_field" &&
        opData<{ key: string }>(op).key === "item_id"
    );
}

class ResponsesStreamWriter implements StreamWriter {
    private messageItemId: string | undefined;
    private messageText = "";
    // Keyed by the id the per-chunk lowering wrote on the item, so an item
    // that appears in more than one event (an output_item.added and its
    // output_item.done) is collected once, with the last shape seen.
    private callItems = new Map<string, WireFunctionCall>();
    private callItemIndex = new Map<string, number>();
    // A stream can send one call's arguments as fragments in delta events
    // that hold no item, so the fragments are joined by output_index.
    private callArguments = new Map<number, string>();

    constructor(
        private readonly dialect: Dialect,
        private readonly opts: LowerOptions | undefined,
    ) {}

    write(program: Program): unknown[] {
        // A chunk raised from an openai_responses event names its own items;
        // a chunk raised from another provider's stream does not, and the
        // per-chunk lowering invents a fresh item id for every delta event.
        const namesItsItems = program.some(namesTextItem);
        const events = lowerStreamResponsesToWire(
            this.dialect,
            program,
            this.opts,
        );
        return events.map((event) =>
            this.applyStreamState(
                asRecord(event, "stream event"),
                namesItsItems,
            ),
        );
    }

    private applyStreamState(
        event: Record<string, unknown>,
        namesItsItems: boolean,
    ): unknown {
        if (event.item != null) this.rememberCallItem(event);
        switch (event.type) {
            case "response.output_text.delta":
                this.rememberMessage(event, namesItsItems);
                break;
            case "response.function_call_arguments.delta":
                this.rememberCallArguments(event);
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
        namesItsItems: boolean,
    ): void {
        if (namesItsItems) {
            this.messageItemId ??= asString(
                event.item_id,
                "stream event.item_id",
            );
        } else {
            this.messageItemId ??= `msg_${crypto.randomUUID().replaceAll("-", "")}`;
            event.item_id = this.messageItemId;
        }
        this.messageText += asString(event.delta, "stream event.delta");
    }

    private rememberCallItem(event: Record<string, unknown>): void {
        const item = asRecord(
            event.item,
            "stream event.item",
        ) as unknown as WireFunctionCall;
        if (item.type !== "function_call") return;
        const key = item.id ?? item.call_id;
        if (typeof key !== "string") return;
        this.callItems.set(key, item);
        this.callItemIndex.set(
            key,
            event.output_index == null
                ? 0
                : asNumber(event.output_index, "stream event.output_index"),
        );
    }

    private rememberCallArguments(event: Record<string, unknown>): void {
        // A chunk that holds a whole call lowers to one event that carries
        // the item and no delta; the item is the whole call already.
        if (typeof event.delta !== "string") return;
        const index =
            event.output_index == null
                ? 0
                : asNumber(event.output_index, "stream event.output_index");
        this.callArguments.set(
            index,
            (this.callArguments.get(index) ?? "") + event.delta,
        );
    }

    private fillTerminalResponse(event: Record<string, unknown>): void {
        const output = this.collectedOutput();
        if (output.length === 0) return;
        // The per-chunk lowering may have placed a response object that an
        // input op holds into the event; copy it so the collected items
        // never write into that object.
        const response = {
            ...asRecord(event.response ?? {}, "stream event.response"),
        };
        response.output ??= output;
        event.response = response;
    }

    private collectedOutput(): WireOutputItem[] {
        const output: WireOutputItem[] = [];
        if (this.messageText !== "" && this.messageItemId != null) {
            output.push({
                type: "message",
                id: this.messageItemId,
                role: "assistant",
                status: "completed",
                content: [
                    {
                        type: "output_text",
                        text: this.messageText,
                        annotations: [],
                        logprobs: [],
                    },
                ],
            });
        }
        for (const [key, item] of this.callItems) {
            const index = this.callItemIndex.get(key);
            const joined =
                index == null ? undefined : this.callArguments.get(index);
            output.push(
                joined == null
                    ? item
                    : { ...item, arguments: item.arguments || joined },
            );
        }
        return output;
    }
}
