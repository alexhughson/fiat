import type { Program } from "./ops";
import { lowerToWire, raiseFromWire } from "./pipeline";

// README-facing convenience surface: one object per dialect with
// fromBody/toBody/fromResponse/toResponse operating between wire payloads
// and core-IR programs. Thin wrapper over the pipeline halves.
export interface Translator {
  fromBody(body: unknown): Program;
  toBody(program: Program): unknown;
  fromResponse(response: unknown): Program;
  toResponse(program: Program): unknown;
}

export function makeTranslator(dialectName: string): Translator {
  return {
    fromBody: (body) => raiseFromWire("request", dialectName, body),
    toBody: (program) => lowerToWire("request", dialectName, program),
    fromResponse: (response) => raiseFromWire("response", dialectName, response),
    toResponse: (program) => lowerToWire("response", dialectName, program),
  };
}
