import type { ThinkingEffort } from "../../core/ops.js";

export const DIALECT = "gemini";

export interface WireFunctionCall {
    name: string;
    args?: Record<string, unknown>;
    id?: string;
}

export interface WireFunctionResponse {
    name: string;
    response?: Record<string, unknown>;
    id?: string;
}

export interface WirePart {
    text?: string;
    functionCall?: WireFunctionCall;
    functionResponse?: WireFunctionResponse;
    [key: string]: unknown;
}

export interface WireContent {
    role?: "user" | "model";
    parts: WirePart[];
}

export interface WireFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export type WireTool = Record<string, unknown>;

export interface GeminiPartMeta {
    kind: "text" | "functionCall" | "functionResponse";
    index?: number;
    id?: string;
    idSource?: "synthesized";
    name?: string;
    meta?: Record<string, unknown>;
    response?: Record<string, unknown>;
}

export type GeminiOp =
    | {
          // Model-free carrier for llm.thinking, produced by lowerThinking.
          // legalize.ts's gemini.thinking legalization must consume this
          // before toWire, which has no serialization for it.
          op: "gemini.thinking";
          effort: ThinkingEffort;
      }
    | {
          op: "gemini.content";
          content: WireContent;
          appliesTo?: "request" | "response";
      }
    | { op: "gemini.finish_reason"; value: string }
    | {
          op: "gemini.usage";
          usage: Record<string, unknown>;
          appliesTo?: "request" | "response";
      }
    | {
          op: "gemini.part_meta";
          part: GeminiPartMeta;
      }
    | {
          op: "gemini.tool";
          tool: WireTool;
          appliesTo?: "request";
      }
    | {
          op: "gemini.candidate_meta";
          candidate: Record<string, unknown>;
          appliesTo?: "response";
      }
    | {
          op: "gemini.generation_config";
          value: Record<string, unknown>;
          appliesTo?: "request";
      }
    | {
          op: "gemini.tool_config";
          value: Record<string, unknown>;
          appliesTo?: "request";
      }
    | {
          op: "gemini.body_field";
          key: string;
          value: unknown;
          appliesTo?: "request" | "response";
      };
