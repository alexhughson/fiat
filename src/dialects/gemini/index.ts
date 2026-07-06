import type { Dialect } from "../../core/registry.js";
import { makeTranslator } from "../../core/translator.js";
import { DIALECT } from "./ops.js";
import { legalizations } from "./legalize.js";
import { lowerRequest, lowerResponse, lowerStreamResponse } from "./lower.js";
import { raise, raiseStreamResponse } from "./raise.js";
import {
    requestFromWire,
    requestToWire,
    responseFromWire,
    responseToWire,
    streamResponseFromWire,
    streamResponseToWire,
} from "./wire.js";

export const GeminiDialect = {
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
        raise: raiseStreamResponse,
        lower: lowerStreamResponse,
    },
} satisfies Dialect;

export const GeminiTranslator = makeTranslator(GeminiDialect);
export { raiseStages, raiseStreamResponseStages } from "./raise.js";
export {
    lowerRequestStages,
    lowerResponseStages,
    lowerStreamResponseStages,
} from "./lower.js";
export type {
    GeminiOp,
    WireContent,
    WireFunctionCall,
    WireFunctionDeclaration,
    WireFunctionResponse,
    WirePart,
    WireTool,
} from "./ops.js";
