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
          required?: boolean;
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
          required?: boolean;
      }
    | {
          op: "openai_chat.stream_choice_param";
          key: string;
          value: unknown;
          appliesTo?: "response";
          required?: boolean;
      }
    | {
          op: "openai_chat.response_format";
          value: Record<string, unknown>;
          required?: boolean;
      }
    | {
          op: "openai_chat.choice_count";
          value: number;
          required?: boolean;
      }
    | {
          op: "openai_chat.max_completion_tokens";
          value: number;
          required?: boolean;
      }
    // Any body key this dialect has no mapping for. Round-trips through toWire
    // untouched; survives raise as a residual (default `required`, so lowering
    // it into another dialect is a lint error unless a transform consumes it
    // or it is marked { required: false }).
    | {
          op: "openai_chat.body_field";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
          required?: boolean;
      };
