import type { Dialect } from "../../core/registry";
import { makeTranslator } from "../../core/translator";
import { lowerRequest, lowerResponse, lowerStreamResponse } from "./lower";
import { DIALECT } from "./ops";
import { raise } from "./raise";
import {
    requestFromWire,
    requestToWire,
    responseFromWire,
    responseToWire,
    streamResponseFromWire,
    streamResponseToWire,
} from "./wire";

export const OpenAIRealtimeDialect = {
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


export const OpenAIRealtimeTranslator = makeTranslator(OpenAIRealtimeDialect);
export { raiseStages } from "./raise";
export {
    lowerRequestStages,
    lowerResponseStages,
    lowerStreamResponseStages,
} from "./lower";
export type {
    OpenAIRealtimeOp,
    WireContentPart,
    WireConversationItem,
    WireConversationItemCreateEvent,
    WireFunctionCallItem,
    WireFunctionCallOutputItem,
    WireMessageItem,
    WireOutputItem,
    WireOutputMessage,
} from "./ops";
