import type { Dialect, StreamWriter } from "../../core/registry.js";
import { makeTranslator } from "../../core/translator.js";
import { DIALECT } from "./ops.js";
import { legalizations } from "./legalize.js";
import {
    lowerRequest,
    lowerResponse,
    lowerStreamResponse,
    splitStreamEvents,
} from "./lower.js";
import { raise } from "./raise.js";
import {
    requestFromWire,
    requestToWire,
    responseFromWire,
    responseToWire,
    streamResponseFromWire,
    streamResponseToWire,
} from "./wire.js";
import { createResponsesStreamWriter } from "./stream_writer.js";

export const OpenAIResponsesDialect = {
    name: DIALECT,
    request: {
        fromWire: requestFromWire,
        toWire: requestToWire,
        raise,
        lower: lowerRequest,
        legalizations,
    },
    response: {
        fromWire: responseFromWire,
        toWire: responseToWire,
        raise,
        lower: lowerResponse,
    },
    responseStream: {
        fromWire: streamResponseFromWire,
        toWire: streamResponseToWire,
        raise,
        lower: lowerStreamResponse,
        splitEvents: splitStreamEvents,
        createStreamWriter: (opts): StreamWriter =>
            createResponsesStreamWriter(OpenAIResponsesDialect, opts),
    },
} satisfies Dialect;

export const OpenAIResponsesTranslator = makeTranslator(OpenAIResponsesDialect);
export { raiseStages } from "./raise.js";
export {
    lowerRequestStages,
    lowerResponseStages,
    lowerStreamResponseStages,
} from "./lower.js";
export type {
    OpenAIResponsesOp,
    WireInputItem,
    WireOutputItem,
} from "./ops.js";
