import type { Program } from "../core/ops.js";

export type NormalizedStopReason = "stop" | "length" | "tool_use" | "error";

export type AssistantTextBlock = {
    type: "text";
    text: string;
};

export type AssistantToolCall = {
    type: "tool_call";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
};

export type AssistantContentBlock = AssistantTextBlock | AssistantToolCall;

export type AssistantUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
};

export type AssistantMessage = {
    content: AssistantContentBlock[];
    stopReason: NormalizedStopReason;
    usage: AssistantUsage;
    model?: string;
    responseId?: string;
    responseModel?: string;
};

export type AccumulatorEvent =
    | {
          type: "text_start";
          contentIndex: number;
          partial: AssistantMessage;
      }
    | {
          type: "text_delta";
          contentIndex: number;
          delta: string;
          partial: AssistantMessage;
      }
    | {
          type: "text_end";
          contentIndex: number;
          content: string;
          partial: AssistantMessage;
      }
    | {
          type: "toolcall_start";
          contentIndex: number;
          partial: AssistantMessage;
      }
    | {
          type: "toolcall_delta";
          contentIndex: number;
          delta: string;
          partial: AssistantMessage;
      }
    | {
          type: "toolcall_end";
          contentIndex: number;
          toolCall: AssistantToolCall;
          partial: AssistantMessage;
      }
    | {
          type: "done";
          message: AssistantMessage;
          reason: NormalizedStopReason;
      };

export type AssistantAccumulatorOptions = {
    model?: string;
    onEvent?: (event: AccumulatorEvent) => void;
};

export type AssistantAccumulator = {
    push: (program: Program) => void;
    finish: () => AssistantMessage;
    message: AssistantMessage;
};
