import {
    isCoreOp,
    namespaceOf,
    opData,
    type DialectOp,
    type Program,
} from "./ops.js";
import { firstOp } from "./program.js";
import type { Codec, Dialect } from "./registry.js";
import type { Stage, Target } from "./rewrite.js";

export type Kind = "request" | "response";

export interface DialectTranslatorRef {
    dialect: Dialect;
}

export type DialectRef = Dialect | DialectTranslatorRef;

export interface RaiseOptions {
    beforeRaise?: Stage;
    afterRaise?: Stage;
}

export interface LowerOptions {
    beforeLower?: Stage;
    afterLower?: Stage;
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
// target dialect, legalize, drop foreign residuals, serialize. toWire is the
// final strictness gate: it throws on any target op it has no serialization for.
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
    for (const legalize of codec.legalizations ?? []) {
        low = legalize(low, target);
    }
    low = dropForeignResiduals(low, dialect.name);
    return codec.toWire(low);
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
    if (program.length > 0 && low.length === 0) return [];
    // An empty program still goes through toWire so the codec's own
    // strictness applies (anthropic throws) instead of yielding [] silently.
    return codec.eventPerOp && low.length > 0
        ? low.map((op) => codec.toWire([op]))
        : [codec.toWire(low)];
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
    for (const legalize of codec.legalizations ?? []) {
        low = legalize(low, target);
    }
    low = dropForeignResiduals(low, dialect.name);
    return { codec, low };
}

function runHookStages(program: Program, stage: Stage | undefined): Program {
    return stage ? stage(program) : program;
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

// Foreign dialect ops are transcript remnants for endpoints that know how to
// use them. When lowering to another endpoint, they are intentionally ignored
// with a warning; target-owned invalid state still reaches toWire and fails.
export function dropForeignResiduals(
    program: Program,
    dialectName: string,
): Program {
    const kept: Program = [];
    for (const op of program) {
        if (isCoreOp(op) || namespaceOf(op) === dialectName) {
            kept.push(op);
            continue;
        }
        console.warn(
            `metamodel: ignored foreign op "${op.op}" while lowering to "${dialectName}"`,
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
