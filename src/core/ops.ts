// The core IR. A program is a flat list of ops. Ops in the `llm`, `meta`, and
// `response` namespaces are the core dialect and are the only ops that
// cross-provider transforms should need to know about. Ops in any other
// namespace belong to a lower (endpoint) dialect and are opaque here — they
// are residuals carried through raising so nothing is silently lost.

export type JsonSchema = Record<string, unknown>;

export type Role = "system" | "user" | "assistant";

// Normalized stop reasons. Dialects map their wire values onto these; a wire
// value with no mapping raises rather than guessing.
export type StopReason =
    | "end_turn"
    | "max_tokens"
    | "tool_use"
    | "stop_sequence"
    | "content_filter"
    | "refusal"
    | "pause_turn"
    | "model_context_window_exceeded";

export type ToolChoice = "auto" | "none" | "required" | { name: string };
export type ServerToolKind = "web_search" | "code_execution";
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CoreOp =
    | { op: "llm.model"; model: string }
    | { op: "llm.temperature"; value: number }
    | { op: "llm.max_output_tokens"; value: number }
    | { op: "request.user"; value: string }
    | { op: "request.stream"; value: boolean }
    | { op: "request.stop_sequences"; value: string[] }
    | { op: "llm.thinking"; effort: ThinkingEffort }
    | { op: "llm.text"; role: Role; content: string }
    | {
          op: "llm.tool";
          name: string;
          description?: string;
          inputSchema: JsonSchema;
      }
    | {
          op: "llm.server_tool";
          name: string;
          kind: ServerToolKind;
      }
    | { op: "llm.tool_choice"; value: ToolChoice }
    // `arguments` is always a parsed object. Providers that put JSON text on
    // the wire (openai) get parsed at raise time and re-stringified at lower
    // time; unparseable argument text is an error, not a passthrough.
    | {
          op: "llm.tool_call";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
      }
    | { op: "llm.tool_result"; id: string; content: string }
    | {
          op: "llm.output";
          format: "json_schema";
          name: string;
          schema: JsonSchema;
      }
    | { op: "meta.trace"; traceId: string }
    // Only the cross-provider counts live here. Provider-specific usage fields
    // (cache hits, reasoning tokens, totals) stay in the op stream as a
    // residual on the source dialect's usage op.
    | { op: "response.usage"; inputTokens?: number; outputTokens?: number }
    | { op: "response.stop"; reason: StopReason }
    | {
          op: "response.text_delta";
          index?: number;
          role?: Role;
          content: string;
      }
    | {
          op: "response.tool_call_delta";
          index?: number;
          id?: string;
          name?: string;
          arguments?: string;
      };

// A lower-dialect op living inside a core program (a residual), or any op in
// a lower-IR program. Foreign residuals are logged and dropped during lowering.
export interface DialectOp {
    op: string;
    appliesTo?: "request" | "response";
    [key: string]: unknown;
}

export type Op = CoreOp | DialectOp;
export type Program = Op[];

// `DialectOp["op"]` is `string`, which keeps every DialectOp in the union
// after a `switch (op.op)` — TypeScript can't narrow it away. A case arm
// that has already matched the op name uses these to assert the shape it
// matched: OpOf for core ops, opData for dialect ops.
export type OpOf<K extends CoreOp["op"]> = Extract<CoreOp, { op: K }>;

export function opData<T>(op: Op): T {
    return op as unknown as T;
}

const CORE_NAMESPACES = new Set(["llm", "meta", "request", "response"]);

export function namespaceOf(op: Op): string {
    const dot = op.op.indexOf(".");
    if (dot <= 0)
        throw new Error(
            `malformed op name "${op.op}" — expected "<namespace>.<name>"`,
        );
    return op.op.slice(0, dot);
}

export function isCoreOp(op: Op): op is CoreOp {
    return CORE_NAMESPACES.has(namespaceOf(op));
}
