import type { StopReason } from "../core/ops.js";
import type { NormalizedStopReason } from "./types.js";

export function stopReasonFromFiat(reason: StopReason): NormalizedStopReason {
    switch (reason) {
        case "end_turn":
        case "stop_sequence":
            return "stop";
        case "max_tokens":
            return "length";
        case "tool_use":
            return "tool_use";
        case "content_filter":
        case "refusal":
        case "model_context_window_exceeded":
        case "pause_turn":
            return "error";
        default: {
            const _exhaustive: never = reason;
            throw new Error(`Unsupported fiat stop reason: ${_exhaustive}`);
        }
    }
}

export function inferStopReason(
    reason: NormalizedStopReason,
    content: { type: string }[],
): NormalizedStopReason {
    if (
        reason === "stop" &&
        content.some((block) => block.type === "tool_call")
    ) {
        return "tool_use";
    }
    return reason;
}
