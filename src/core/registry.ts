import type { Program } from "./ops.js";
import type { Target } from "./rewrite.js";

// One direction of a dialect (requests or responses). The four functions are
// the four edges of the MLIR-style pipeline:
//
//   wire --fromWire--> lower IR --raise--> core IR
//   core IR --lower--> lower IR --toWire--> wire
//
// Programs are mixed-dialect. fromWire emits core ops directly for wire
// fields that are a trivially bijective rename of one core op, and dialect
// ops for anything the core IR reshapes or can't represent. raise rewrites
// the dialect ops it owns into core ops, leaving endpoint-only constructs
// behind as residuals; lower is the inverse. Both pass through ops they
// don't own. toWire is strict: it throws on any op it can't serialize.
export interface ToWireOptions {
    omitModel?: boolean;
}

export interface Codec {
    fromWire(wire: unknown): Program;
    toWire(program: Program, opts?: ToWireOptions): unknown;
    raise(program: Program): Program;
    lower(program: Program, target?: Target): Program;
    // Run on this direction's lower IR after `lower`, before `toWire`. This is
    // where endpoint/model quirks live for that direction.
    legalizations?: ((program: Program, target: Target) => Program)[];
    // Set on a stream codec whose toWire serializes exactly one event op per
    // wire event (it throws on a multi-op program). Callers emitting several
    // ops per turn must call toWire once per op instead of once for the batch.
    eventPerOp?: boolean;
}

export interface Dialect {
    name: string;
    request: Codec;
    response: Codec;
    responseStream?: Codec;
}
