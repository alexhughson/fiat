import {
    isCoreOp,
    namespaceOf,
    opData,
    type DialectOp,
    type Program,
} from "./ops";
import { firstOp } from "./program";
import { LintError, runPasses, type Pass, type Target } from "./pass";
import type { Codec, Dialect } from "./registry";
import type { Stage } from "./rewrite";

export type Kind = "request" | "response";
export type HookStages = Stage | Stage[];

export interface DialectTranslatorRef {
    dialect: Dialect;
}

export type DialectRef = Dialect | DialectTranslatorRef;

export interface RaiseOptions {
    beforeRaise?: HookStages;
    afterRaise?: HookStages;
}

export interface LowerOptions {
    beforeLower?: HookStages;
    afterLower?: HookStages;
    strict?: boolean;
}

// wire -> core: parse into the source dialect's lower IR, then raise.
// Programs are mixed-dialect: fromWire already emits core ops for fields
// that map 1:1, and raise rewrites the remaining dialect ops it owns,
// leaving endpoint-only constructs behind as residuals.
export function raiseFromWire(
    kind: Kind,
    dialectRef: DialectRef,
    wire: unknown,
    opts: RaiseOptions = {},
): Program {
    const codec = codecFor(kind, dialectRef);
    let program = codec.fromWire(wire);
    program = runHookStages(program, opts.beforeRaise);
    program = codec.raise(program);
    return runHookStages(program, opts.afterRaise);
}

// core -> wire: strip ops that don't address the provider, lower into the
// target dialect, legalize, lint foreign residuals, serialize. toWire is the
// final strictness gate: it throws on any op it has no serialization for.
export function lowerToWire(
    kind: Kind,
    dialectRef: DialectRef,
    program: Program,
    opts: LowerOptions = {},
): unknown {
    const dialect = dialectFor(dialectRef);
    const codec = dialect[kind];
    let low = stripHostOps(kind, program);
    low = runHookStages(low, opts.beforeLower);
    low = codec.lower(low, {
        dialect: dialect.name,
        kind,
        model: firstOp(low, "llm.model")?.model,
        strict: opts.strict,
    });
    low = runHookStages(low, opts.afterLower);
    const target: Target = {
        dialect: dialect.name,
        kind,
        model: firstOp(low, "llm.model")?.model,
        strict: opts.strict,
    };
    low = runPasses(low, codec.legalizations ?? [], target);
    low = lintForeignResiduals(low, dialect.name);
    return codec.toWire(low);
}

export interface TranslateOptions extends RaiseOptions, LowerOptions {
    from: DialectRef;
    to: DialectRef;
    // Transforms/lints run on the core IR, between raise and lower.
    passes?: Pass[];
}

export function translateRequest(
    wire: unknown,
    opts: TranslateOptions,
): unknown {
    return translate("request", wire, opts);
}

export function translateResponse(
    wire: unknown,
    opts: TranslateOptions,
): unknown {
    return translate("response", wire, opts);
}

export function raiseStreamResponseFromWire(
    dialectRef: DialectRef,
    wire: unknown,
    opts: RaiseOptions = {},
): Program {
    const codec = streamCodecFor(dialectRef);
    let program = codec.fromWire(wire);
    program = runHookStages(program, opts.beforeRaise);
    program = codec.raise(program);
    return runHookStages(program, opts.afterRaise);
}

export function lowerStreamResponseToWire(
    dialectRef: DialectRef,
    program: Program,
    opts: LowerOptions = {},
): unknown {
    const { codec, low } = lowerStreamResponseProgram(
        dialectRef,
        program,
        opts,
    );
    return codec.toWire(low);
}

export function lowerStreamResponsesToWire(
    dialectRef: DialectRef,
    program: Program,
    opts: LowerOptions = {},
): unknown[] {
    const { codec, low } = lowerStreamResponseProgram(
        dialectRef,
        program,
        opts,
    );
    if (low.length <= 1) return [codec.toWire(low)];

    try {
        return [codec.toWire(low)];
    } catch (error) {
        const events: unknown[] = [];
        for (const op of low) {
            try {
                events.push(codec.toWire([op]));
            } catch {
                throw error;
            }
        }
        return events;
    }
}

function lowerStreamResponseProgram(
    dialectRef: DialectRef,
    program: Program,
    opts: LowerOptions,
): { codec: Codec; low: Program } {
    const dialect = dialectFor(dialectRef);
    const codec = streamCodecFor(dialect);
    let low = stripHostOps("response", program);
    low = runHookStages(low, opts.beforeLower);
    low = codec.lower(low, {
        dialect: dialect.name,
        kind: "response_stream",
        model: firstOp(low, "llm.model")?.model,
        strict: opts.strict,
    });
    low = runHookStages(low, opts.afterLower);
    const target: Target = {
        dialect: dialect.name,
        kind: "response_stream",
        model: firstOp(low, "llm.model")?.model,
        strict: opts.strict,
    };
    low = runPasses(low, codec.legalizations ?? [], target);
    low = lintForeignResiduals(low, dialect.name);
    return { codec, low };
}

export function translateStreamResponse(
    wire: unknown,
    opts: TranslateOptions,
): unknown {
    const targetDialect = dialectFor(opts.to);
    let core = raiseStreamResponseFromWire(opts.from, wire, opts);
    const target: Target = {
        dialect: targetDialect.name,
        kind: "response_stream",
        model: firstOp(core, "llm.model")?.model,
        strict: opts.strict,
    };
    core = runPasses(core, opts.passes ?? [], target);
    return lowerStreamResponseToWire(targetDialect, core, opts);
}

function translate(kind: Kind, wire: unknown, opts: TranslateOptions): unknown {
    const targetDialect = dialectFor(opts.to);
    let core = raiseFromWire(kind, opts.from, wire, opts);
    const target: Target = {
        dialect: targetDialect.name,
        kind,
        model: firstOp(core, "llm.model")?.model,
        strict: opts.strict,
    };
    core = runPasses(core, opts.passes ?? [], target);
    return lowerToWire(kind, targetDialect, core, opts);
}

function runHookStages(
    program: Program,
    stages: HookStages | undefined,
): Program {
    if (!stages) return program;
    const list = Array.isArray(stages) ? stages : [stages];
    return list.reduce((current, stage) => stage(current), program);
}

// meta.* ops address the host (tracing, routing), never the provider. In a
// request, response.* ops are the artifact of appending a response program
// onto a request for chaining — usage/stop reasons don't get re-sent.
function stripHostOps(kind: Kind, program: Program): Program {
    return program.filter((op) => {
        const ns = namespaceOf(op);
        if (ns === "meta") return false;
        if (kind === "request" && ns === "response") return false;
        if (kind !== "request" && ns === "request") return false;
        if (!isCoreOp(op)) {
            const dialectOp = opData<DialectOp>(op);
            if (dialectOp.appliesTo && dialectOp.appliesTo !== kind)
                return false;
        }
        return true;
    });
}

// After lowering, every op must be either a core op the target's toWire
// serializes, or an op in the target's own namespace. A foreign dialect op
// marked { required: false } is dropped; any other means information would
// be silently lost, so we halt.
export function lintForeignResiduals(
    program: Program,
    dialectName: string,
): Program {
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

function codecFor(kind: Kind, dialectRef: DialectRef): Codec {
    return dialectFor(dialectRef)[kind];
}

function streamCodecFor(dialectRef: DialectRef): Codec {
    const dialect = dialectFor(dialectRef);
    const codec = dialect.responseStream;
    if (!codec) {
        throw new Error(
            `dialect "${dialect.name}" does not implement response stream conversion`,
        );
    }
    return codec;
}

function dialectFor(dialectRef: DialectRef): Dialect {
    if ("request" in dialectRef && "response" in dialectRef) return dialectRef;
    return dialectRef.dialect;
}
