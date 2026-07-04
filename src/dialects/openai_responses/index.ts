import type { Dialect } from "../../core/registry";
import { makeTranslator } from "../../core/translator";
import { DIALECT } from "./ops";
import { lowerRequest, lowerResponse, lowerStreamResponse } from "./lower";
import { raise } from "./raise";
import {
    requestFromWire,
    requestToWire,
    responseFromWire,
    responseToWire,
    streamResponseFromWire,
    streamResponseToWire,
} from "./wire";

export const OpenAIResponsesDialect = {
    name: DIALECT,
    request: {
        fromWire: requestFromWire,
        toWire: requestToWire,
        raise,
        lower: lowerRequest,
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


export const OpenAIResponsesTranslator = makeTranslator(OpenAIResponsesDialect);
export { raiseStages } from "./raise";
export {
    lowerRequestStages,
    lowerResponseStages,
    lowerStreamResponseStages,
} from "./lower";
export type { OpenAIResponsesOp, WireInputItem, WireOutputItem } from "./ops";
