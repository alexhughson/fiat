export const DIALECT = "openai_responses";

export interface WireContentPart {
    type: string;
    text?: string;
    image_url?: string;
    file_id?: string;
    file_data?: string;
    file_url?: string;
    filename?: string;
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

export interface WireReasoningItem {
    type: "reasoning";
    summary: WireContentPart[];
    id?: string;
    encrypted_content?: string | null;
    status?: string;
    [key: string]: unknown;
}

export type WireInputItem =
    | WireInputMessage
    | WireFunctionCall
    | WireFunctionCallOutput
    | WireReasoningItem;
export type WireOutputItem =
    WireOutputMessage | WireFunctionCall | WireReasoningItem;

export type OpenAIResponsesOp =
    | { op: "openai_responses.input"; item: WireInputItem }
    | { op: "openai_responses.output"; item: WireOutputItem }
    | {
          op: "openai_responses.output_meta";
          item: Partial<WireOutputItem>;
          appliesTo?: "request" | "response";
      }
    // Side op of llm.tool_call: `of` names the call id that tool results use;
    // `itemId` names the function_call item inside a Responses body.
    | {
          op: "openai_responses.function_call_item";
          of: string;
          itemId: string;
      }
    // Side op of llm.reasoning: `of` names the reasoning op's id. `fields` is
    // the reasoning item without `type` and without a `summary` that the
    // reasoning op's content already says (id, encrypted_content, status).
    | {
          op: "openai_responses.reasoning_item";
          of: string;
          fields: Record<string, unknown>;
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
    // The fields of the wire usage object that core does not model: the
    // write-by-lifetime breakdown. The token-count parts raise to
    // response.usage.
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
