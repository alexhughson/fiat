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

export interface WireAnthropicMessage {
  role: "user" | "assistant";
  content: string | WireBlock[];
}

export type AnthropicMessagesOp =
  // A wire message verbatim: the grouping of content blocks into turns is
  // the structure the core IR flattens away.
  | { op: "anthropic_messages.message"; message: WireAnthropicMessage }
  // Response-only: provider enum, mapped in raise.
  | { op: "anthropic_messages.stop_reason"; value: string }
  // Wire usage verbatim (input_tokens/output_tokens plus cache fields the
  // core op doesn't model — those survive raise as a { required: false }
  // residual on this op).
  | { op: "anthropic_messages.usage"; usage: Record<string, unknown> }
  // Unmapped body keys; residual semantics identical to openai_chat.param.
  | { op: "anthropic_messages.param"; key: string; value: unknown; required?: boolean };
