import { registerDialect } from "../../core/registry";
import { makeTranslator } from "../../core/translator";
import { DIALECT } from "./ops";
import { lowerRequest, lowerResponse } from "./lower";
import { raise } from "./raise";
import { requestFromWire, requestToWire, responseFromWire, responseToWire } from "./wire";

registerDialect({
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
});

export const OpenAIChatTranslator = makeTranslator(DIALECT);
export type { OpenAIChatOp, WireMessage, WireToolCall } from "./ops";
