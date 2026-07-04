import type { Program } from "./ops";
import {
    type LowerOptions,
    lowerStreamResponseToWire,
    lowerStreamResponsesToWire,
    lowerToWire,
    type RaiseOptions,
    raiseFromWire,
    raiseStreamResponseFromWire,
} from "./pipeline";
import type { Dialect } from "./registry";

export class Translator {
    readonly name: string;

    constructor(readonly dialect: Dialect) {
        this.name = dialect.name;
    }

    fromBody(body: unknown, opts?: RaiseOptions): Program {
        return raiseFromWire("request", this.dialect, body, opts);
    }

    toBody(program: Program, opts?: LowerOptions): unknown {
        return lowerToWire("request", this.dialect, program, opts);
    }

    fromResponse(response: unknown, opts?: RaiseOptions): Program {
        return raiseFromWire("response", this.dialect, response, opts);
    }

    toResponse(program: Program, opts?: LowerOptions): unknown {
        return lowerToWire("response", this.dialect, program, opts);
    }

    fromStreamResponse(response: unknown, opts?: RaiseOptions): Program {
        return raiseStreamResponseFromWire(this.dialect, response, opts);
    }

    toStreamResponse(program: Program, opts?: LowerOptions): unknown {
        return lowerStreamResponseToWire(this.dialect, program, opts);
    }

    toStreamResponses(program: Program, opts?: LowerOptions): unknown[] {
        return lowerStreamResponsesToWire(this.dialect, program, opts);
    }
}

export function makeTranslator(dialect: Dialect): Translator {
    return new Translator(dialect);
}
