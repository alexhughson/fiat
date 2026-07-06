// Lower IR for the OpenAI Chat Completions endpoint (POST /v1/chat/completions).
//
// This dialect only defines ops for wire constructs that the core IR
// reshapes or can't represent. Fields that are a trivially bijective rename
// of a single core op (model, temperature, tools, tool_choice,
// response_format json_schema) never get a dialect op — fromWire/toWire read
// and write the core op directly. Op shapes here are the wire shapes,
// flattened into an op stream; normalization happens in raise/lower.

export const DIALECT = "openai_chat";

export interface WireContentPart {
    type: string;
    text?: string;
    image_url?: {
        url?: string;
        [key: string]: unknown;
    };
    input_audio?: {
        data?: string;
        format?: string;
        [key: string]: unknown;
    };
    file?: {
        filename?: string;
        file_data?: string;
        file_id?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface WireToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

export interface WireMessage {
    role: "system" | "developer" | "user" | "assistant" | "tool";
    content: string | WireContentPart[] | null;
    tool_calls?: WireToolCall[];
    tool_call_id?: string;
    name?: string;
    refusal?: string | null;
    annotations?: unknown[];
    audio?: unknown;
}

export type OpenAIChatMessageMeta = Pick<
    WireMessage,
    "refusal" | "annotations" | "audio"
> & {
    role?: "developer";
    content?: null;
};

export type OpenAIChatOp =
    // A wire message verbatim. Core IR flattens messages (one op per text /
    // tool call / tool result), so the grouping is what this op preserves.
    | { op: "openai_chat.message"; message: WireMessage }
    | {
          op: "openai_chat.message_meta";
          message: OpenAIChatMessageMeta;
          appliesTo?: "request" | "response";
      }
    // Response-only: provider-specific enum strings, mapped to core values in
    // raise (unknown values raise rather than guess).
    | { op: "openai_chat.finish_reason"; value: string }
    // Wire usage verbatim: field names differ from core and OpenAI adds detail
    // fields (cached tokens, reasoning tokens) the core op doesn't model.
    | {
          op: "openai_chat.usage";
          usage: {
              prompt_tokens?: number;
              completion_tokens?: number;
              [key: string]: unknown;
          };
          appliesTo?: "request" | "response";
      }
    | {
          op: "openai_chat.stream_choice_param";
          key: string;
          value: unknown;
          appliesTo?: "response";
      }
    | {
          op: "openai_chat.response_format";
          value: Record<string, unknown>;
      }
    | {
          op: "openai_chat.choice_count";
          value: number;
      }
    | {
          op: "openai_chat.max_completion_tokens";
          value: number;
      }
    // Any body key this dialect has no mapping for. Round-trips through toWire
    // untouched; a foreign target warns and drops it because no other endpoint
    // has a wire slot for it.
    | {
          op: "openai_chat.body_field";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
      };
