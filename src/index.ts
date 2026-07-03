// Importing a dialect module registers it; importing this root module
// registers everything built in. Registration is the only side effect.

export type {
  CoreOp,
  DialectOp,
  JsonSchema,
  Op,
  Program,
  Role,
  StopReason,
  ToolChoice,
} from "./core/ops";
export { isCoreOp, namespaceOf } from "./core/ops";
export { append, firstOp, opsOf } from "./core/program";
export { LintError, runPasses } from "./core/pass";
export type { Pass, Target } from "./core/pass";
export { getDialect, registerDialect } from "./core/registry";
export type { Codec, Dialect } from "./core/registry";
export {
  lintForeignResiduals,
  lowerToWire,
  raiseFromWire,
  translateRequest,
  translateResponse,
} from "./core/pipeline";
export type { Kind, TranslateOptions } from "./core/pipeline";
export { makeTranslator } from "./core/translator";
export type { Translator } from "./core/translator";

export { OpenAIChatTranslator } from "./dialects/openai_chat";
export { AnthropicTranslator } from "./dialects/anthropic_messages";
