export type {
    CoreOp,
    DialectOp,
    AudioSource,
    Base64MediaSource,
    DocumentSource,
    ImageSource,
    JsonSchema,
    Op,
    Program,
    Role,
    ServerToolKind,
    StopReason,
    ThinkingEffort,
    ToolChoice,
    UrlMediaSource,
    VideoSource,
} from "./core/ops.js";
export { isCoreOp, namespaceOf } from "./core/ops.js";
export { append, firstOp, opsOf } from "./core/program.js";
export { LintError } from "./core/lint.js";
export { stagePipeline } from "./core/rewrite.js";
export type { Stage, Target, TargetVariant } from "./core/rewrite.js";
export type { Codec, Dialect, ToWireOptions } from "./core/registry.js";
export {
    dropForeignResiduals,
    lowerStreamResponsesToWire,
} from "./core/pipeline.js";
export type {
    DialectRef,
    Kind,
    LowerOptions,
    RaiseOptions,
} from "./core/pipeline.js";
export { makeTranslator, Translator } from "./core/translator.js";

export { OpenAIChatTranslator } from "./dialects/openai_chat/index.js";
export { AnthropicTranslator } from "./dialects/anthropic_messages/index.js";
export { OpenAIResponsesTranslator } from "./dialects/openai_responses/index.js";
export { OpenAIRealtimeTranslator } from "./dialects/openai_realtime/index.js";
export { GeminiTranslator } from "./dialects/gemini/index.js";

export {
    createAssistantAccumulator,
    inferStopReason,
    stopReasonFromFiat,
} from "./accumulator/index.js";
export type {
    AccumulatorEvent,
    AssistantAccumulator,
    AssistantAccumulatorOptions,
    AssistantContentBlock,
    AssistantMessage,
    AssistantTextBlock,
    AssistantToolCall,
    AssistantUsage,
    NormalizedStopReason,
} from "./accumulator/index.js";
