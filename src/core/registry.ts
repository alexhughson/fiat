import type { Program } from "./ops";
import type { Pass } from "./pass";

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
export interface Codec {
  fromWire(wire: unknown): Program;
  toWire(program: Program): unknown;
  raise(program: Program): Program;
  lower(program: Program): Program;
}

export interface Dialect {
  name: string;
  request: Codec;
  response: Codec;
  // Run on the lower IR after `lower`, before `toWire`. This is where
  // endpoint/model quirks live (insert a required default, reject a param a
  // model doesn't support).
  legalizations?: Pass[];
}

const dialects = new Map<string, Dialect>();

export function registerDialect(dialect: Dialect): void {
  if (dialects.has(dialect.name)) {
    throw new Error(`dialect "${dialect.name}" is already registered`);
  }
  dialects.set(dialect.name, dialect);
}

export function getDialect(name: string): Dialect {
  const dialect = dialects.get(name);
  if (!dialect) {
    const known = [...dialects.keys()].join(", ") || "(none)";
    throw new Error(`unknown dialect "${name}" — registered: ${known}. Did you import its module?`);
  }
  return dialect;
}
