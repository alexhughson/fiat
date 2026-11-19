import {
    isCoreOp,
    namespaceOf,
    opData,
    type DialectOp,
    type Program,
} from "./ops.js";
import { LintError } from "./lint.js";
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

// core -> wire: drop meta.* ops, drop response ops from a request or request
// ops from a response, lower into the target dialect, legalize, drop foreign
// residuals, serialize. toWire is the final strictness gate: it throws on any
// target op it has no serialization for.
export function lowerToWire(
    kind: Kind,
    dialectRef: DialectRef,
    program: Program,
    opts: LowerOptions = {},
): unknown {
    const dialect = dialectFor(dialectRef);
    const codec = dialect[kind];
    let low = dropMetaOps(program);
    low = kind === "request" ? dropResponseOps(low) : dropRequestOps(low);
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
    if (codec.eventPerOp && low.length > 0) {
        return low.map((op) => codec.toWire([op]));
    }
    const events = codec.splitEvents ? codec.splitEvents(low) : [low];
    return events.map((event) => codec.toWire(event));
}

function lowerStreamResponseProgram(
    dialectRef: DialectRef,
    program: Program,
    opts: LowerOptions,
): { codec: Codec; low: Program } {
    const dialect = dialectFor(dialectRef);
    const codec = streamCodecFor(dialect);
    let low = dropMetaOps(program);
    low = dropRequestOps(low);
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

// meta.* ops such as meta.trace hold host correlation data, which is not part
// of any request or response body: toWire in every dialect throws on a meta.*
// op.
function dropMetaOps(program: Program): Program {
    return program.filter((op) => namespaceOf(op) !== "meta");
}

// If responses are appended to a prompt, the prompt will contain response
// specific ops like response.stop and response.usage, which are invalid in a
// request body.
function dropResponseOps(program: Program): Program {
    return program.filter((op) => {
        if (namespaceOf(op) === "response") return false;
        return isCoreOp(op) || opData<DialectOp>(op).appliesTo !== "response";
    });
}

// request.* ops such as request.stream are invalid in a response body and in a
// stream event.
function dropRequestOps(program: Program): Program {
    return program.filter((op) => {
        if (namespaceOf(op) === "request") return false;
        return isCoreOp(op) || opData<DialectOp>(op).appliesTo !== "request";
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
        const dialectOp = opData<DialectOp>(op);
        if (dialectOp.preservesContent === true) {
            throw new LintError(
                `cannot drop content-bearing foreign op "${op.op}" while lowering to "${dialectName}"`,
            );
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
