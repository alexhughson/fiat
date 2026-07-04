export const DIALECT = "openai_realtime";

export interface WireContentPart {
    type: string;
    text?: string;
    [key: string]: unknown;
}

export interface WireMessageItem {
    type: "message";
    role: "system" | "user" | "assistant";
    content: WireContentPart[];
    id?: string;
    object?: string;
    status?: string;
    [key: string]: unknown;
}

export interface WireFunctionCallItem {
    type: "function_call";
    name: string;
    arguments: string;
    call_id?: string;
    id?: string;
    object?: string;
    status?: string;
    [key: string]: unknown;
}

export interface WireFunctionCallOutputItem {
    type: "function_call_output";
    call_id: string;
    output: string;
    id?: string;
    object?: string;
    status?: string;
    [key: string]: unknown;
}

export type WireConversationItem =
    WireMessageItem | WireFunctionCallItem | WireFunctionCallOutputItem;

export interface WireConversationItemCreateEvent {
    type: "conversation.item.create";
    item: WireConversationItem;
    event_id?: string;
    previous_item_id?: string | null;
    [key: string]: unknown;
}

export interface WireOutputMessage {
    type: "message";
    role: "assistant";
    content: WireContentPart[];
    id?: string;
    object?: string;
    status?: string;
    [key: string]: unknown;
}

export type WireOutputItem = WireOutputMessage | WireFunctionCallItem;

export type OpenAIRealtimeOp =
    | { op: "openai_realtime.item"; event: WireConversationItemCreateEvent }
    | {
          op: "openai_realtime.item_meta";
          event: WireConversationItemCreateEvent;
          appliesTo?: "request" | "response";
          required?: boolean;
      }
    | { op: "openai_realtime.response_input_mode"; required?: boolean }
    | { op: "openai_realtime.output"; item: WireOutputItem }
    | {
          op: "openai_realtime.output_meta";
          item: Partial<WireOutputItem>;
          appliesTo?: "request" | "response";
          required?: boolean;
      }
    | {
          op: "openai_realtime.tool_meta";
          name: string;
          fields: Record<string, unknown>;
          appliesTo?: "request" | "response";
          required?: boolean;
      }
    | {
          op: "openai_realtime.finish_reason";
          reason: "end_turn" | "max_tokens" | "tool_use" | "content_filter";
      }
    | {
          op: "openai_realtime.usage";
          usage: Record<string, unknown>;
          appliesTo?: "request" | "response";
          required?: boolean;
      }
    | {
          op: "openai_realtime.response_param";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
          required?: boolean;
      }
    | {
          op: "openai_realtime.event_param";
          eventType: "response.create" | "response.done";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
          required?: boolean;
      }
    | {
          op: "openai_realtime.body_field";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
          required?: boolean;
      };
