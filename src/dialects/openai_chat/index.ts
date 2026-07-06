import type { Dialect } from "../../core/registry.js";
import { makeTranslator } from "../../core/translator.js";
import { DIALECT } from "./ops.js";
import { legalizations } from "./legalize.js";
import { lowerRequest, lowerResponse, lowerStreamResponse } from "./lower.js";
import { raise } from "./raise.js";
import {
    requestFromWire,
    requestToWire,
    responseFromWire,
    responseToWire,
    streamResponseFromWire,
    streamResponseToWire,
} from "./wire.js";

export const OpenAIChatDialect = {
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
    },
} satisfies Dialect;

export const OpenAIChatTranslator = makeTranslator(OpenAIChatDialect);
export { raiseStages } from "./raise.js";
export {
    lowerRequestStages,
    lowerResponseStages,
    lowerStreamResponseStages,
} from "./lower.js";
export type { OpenAIChatOp, WireMessage, WireToolCall } from "./ops.js";
