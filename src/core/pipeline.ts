import { isCoreOp, namespaceOf, type Program } from "./ops";
import { firstOp } from "./program";
import { LintError, runPasses, type Pass, type Target } from "./pass";
import { getDialect, type Codec } from "./registry";

export type Kind = "request" | "response";

// wire -> core: parse into the source dialect's lower IR, then raise.
// Programs are mixed-dialect: fromWire already emits core ops for fields
// that map 1:1, and raise rewrites the remaining dialect ops it owns,
// leaving endpoint-only constructs behind as residuals.
export function raiseFromWire(kind: Kind, dialectName: string, wire: unknown): Program {
  const codec = codecFor(kind, dialectName);
  return codec.raise(codec.fromWire(wire));
}

// core -> wire: strip ops that don't address the provider, lower into the
// target dialect, legalize, lint foreign residuals, serialize. toWire is the
// final strictness gate: it throws on any op it has no serialization for.
export function lowerToWire(kind: Kind, dialectName: string, program: Program): unknown {
  const dialect = getDialect(dialectName);
  const codec = dialect[kind];
  const target: Target = { dialect: dialectName, kind, model: firstOp(program, "llm.model")?.model };

  let low = codec.lower(stripHostOps(kind, program));
  low = runPasses(low, dialect.legalizations ?? [], target);
  low = lintForeignResiduals(low, dialectName);
  return codec.toWire(low);
}

export interface TranslateOptions {
  from: string;
  to: string;
  // Transforms/lints run on the core IR, between raise and lower.
  passes?: Pass[];
}

export function translateRequest(wire: unknown, opts: TranslateOptions): unknown {
  return translate("request", wire, opts);
}

export function translateResponse(wire: unknown, opts: TranslateOptions): unknown {
  return translate("response", wire, opts);
}

function translate(kind: Kind, wire: unknown, opts: TranslateOptions): unknown {
  let core = raiseFromWire(kind, opts.from, wire);
  const target: Target = { dialect: opts.to, kind, model: firstOp(core, "llm.model")?.model };
  core = runPasses(core, opts.passes ?? [], target);
  return lowerToWire(kind, opts.to, core);
}

// meta.* ops address the host (tracing, routing), never the provider. In a
// request, response.* ops are the artifact of appending a response program
// onto a request for chaining — usage/stop reasons don't get re-sent.
function stripHostOps(kind: Kind, program: Program): Program {
  return program.filter((op) => {
    const ns = namespaceOf(op);
    if (ns === "meta") return false;
    if (kind === "request" && ns === "response") return false;
    return true;
  });
}

// After lowering, every op must be either a core op the target's toWire
// serializes, or an op in the target's own namespace. A foreign dialect op
// marked { required: false } is dropped; any other means information would
// be silently lost, so we halt.
export function lintForeignResiduals(program: Program, dialectName: string): Program {
  const kept: Program = [];
  for (const op of program) {
    if (isCoreOp(op) || namespaceOf(op) === dialectName) {
      kept.push(op);
      continue;
    }
    if (op.required === false) continue;
    throw new LintError(
      `op "${op.op}" survived lowering to "${dialectName}" — no transform consumed it. ` +
        `Mark it { required: false } to allow dropping it, or register a pass that maps it.`,
    );
  }
  return kept;
}

function codecFor(kind: Kind, dialectName: string): Codec {
  return getDialect(dialectName)[kind];
}
