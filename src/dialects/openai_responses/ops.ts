export const DIALECT = "openai_responses";

export interface WireContentPart {
    type: string;
    text?: string;
    [key: string]: unknown;
}

export interface WireInputMessage {
    type?: "message";
    role: "system" | "developer" | "user" | "assistant";
    content: string | WireContentPart[];
}

export interface WireFunctionCall {
    type: "function_call";
    call_id: string;
    name: string;
    arguments: string;
    id?: string;
    status?: string;
    [key: string]: unknown;
}

export interface WireFunctionCallOutput {
    type: "function_call_output";
    call_id: string;
    output: string;
    id?: string;
    status?: string;
}

export type WireTool = Record<string, unknown>;

export interface WireOutputMessage {
    type: "message";
    role: "assistant";
    status?: string;
    content: WireContentPart[];
    id?: string;
    [key: string]: unknown;
}

export type WireInputItem =
    WireInputMessage | WireFunctionCall | WireFunctionCallOutput;
export type WireOutputItem = WireOutputMessage | WireFunctionCall;

export type OpenAIResponsesOp =
    | { op: "openai_responses.input"; item: WireInputItem }
    | { op: "openai_responses.output"; item: WireOutputItem }
    | {
          op: "openai_responses.output_meta";
          item: Partial<WireOutputItem>;
          appliesTo?: "request" | "response";
      }
    | {
          op: "openai_responses.tool_meta";
          name: string;
          fields: Record<string, unknown>;
          appliesTo?: "request" | "response";
      }
    | {
          op: "openai_responses.tool";
          tool: WireTool;
          appliesTo?: "request";
      }
    | {
          op: "openai_responses.finish_reason";
          reason: "end_turn" | "max_tokens" | "tool_use" | "content_filter";
      }
    | {
          op: "openai_responses.usage";
          usage: Record<string, unknown>;
          appliesTo?: "request" | "response";
      }
    | {
          op: "openai_responses.tool_choice";
          value: unknown;
          appliesTo?: "request";
      }
    | {
          op: "openai_responses.body_field";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
      };
