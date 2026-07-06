// Lower IR for the Anthropic Messages endpoint (POST /v1/messages).
//
// Same rule as every dialect: ops exist only for wire constructs the core IR
// reshapes. model, max_tokens, temperature, system (string), tools, and
// tool_choice are trivially bijective renames of core ops, so fromWire/toWire
// handle them directly and they never appear as dialect ops.

export const DIALECT = "anthropic_messages";

export interface WireBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string | WireBlock[];
    is_error?: boolean;
    [key: string]: unknown;
}

export interface WireAnthropicTool {
    name?: string;
    description?: string;
    input_schema?: Record<string, unknown>;
    type?: string;
    [key: string]: unknown;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface WireAnthropicMessage {
    role: "user" | "assistant";
    content: string | WireBlock[];
}

export interface WireAnthropicStreamEvent {
    type: string;
    index?: number;
    content_block?: WireBlock;
    delta?: {
        type?: string;
        text?: string;
        partial_json?: string;
        stop_reason?: string | null;
        [key: string]: unknown;
    };
    usage?: Record<string, unknown>;
    [key: string]: unknown;
}

export type AnthropicMessagesOp =
    // A wire message verbatim: the grouping of content blocks into turns is
    // the structure the core IR flattens away.
    | { op: "anthropic_messages.message"; message: WireAnthropicMessage }
    // Response-only: provider enum, mapped in raise.
    | { op: "anthropic_messages.stop_reason"; value: string }
    | {
          op: "anthropic_messages.content_block";
          block: WireBlock;
          role?: "user" | "assistant";
          appliesTo?: "response";
      }
    | {
          op: "anthropic_messages.system_block";
          block: WireBlock;
      }
    | {
          op: "anthropic_messages.text_meta";
          fields: Record<string, unknown>;
      }
    | {
          op: "anthropic_messages.tool";
          tool: WireAnthropicTool;
      }
    | {
          op: "anthropic_messages.tool_meta";
          name: string;
          fields: Record<string, unknown>;
      }
    | {
          op: "anthropic_messages.tool_result_meta";
          id: string;
          fields?: Record<string, unknown>;
          is_error?: boolean;
      }
    | {
          op: "anthropic_messages.thinking";
          adaptiveEffort?: AnthropicEffort;
          manualBudgetTokens?: number;
          display?: "summarized" | "omitted";
      }
    | {
          op: "anthropic_messages.thinking_config";
          value: Record<string, unknown>;
      }
    | {
          op: "anthropic_messages.output_config";
          value: Record<string, unknown>;
      }
    | {
          op: "anthropic_messages.context_management";
          value: Record<string, unknown>;
      }
    | {
          op: "anthropic_messages.metadata";
          value: Record<string, unknown>;
      }
    | {
          op: "anthropic_messages.sampling";
          key: "top_p" | "top_k";
          value: number;
      }
    // Wire usage verbatim: input_tokens/output_tokens plus cache fields the
    // core op doesn't model.
    | {
          op: "anthropic_messages.usage";
          usage: Record<string, unknown>;
          appliesTo?: "request" | "response";
      }
    | {
          op: "anthropic_messages.stream_event";
          event: WireAnthropicStreamEvent;
          appliesTo?: "response";
      }
    | {
          op: "anthropic_messages.body_field";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
      };
