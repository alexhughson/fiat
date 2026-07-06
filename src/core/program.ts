import type { CoreOp, Op, OpOf, Program } from "./ops.js";

export function opsOf<K extends CoreOp["op"]>(
    program: Program,
    op: K,
): OpOf<K>[] {
    return program.filter((o): o is OpOf<K> => o.op === op);
}

export function firstOp<K extends CoreOp["op"]>(
    program: Program,
    op: K,
): OpOf<K> | undefined {
    return program.find((o): o is OpOf<K> => o.op === op);
}

// Structural-equality-free append: responses share the core schema, so
// chaining a response onto a request is plain concatenation.
export function append(program: Program, ...ops: Op[]): Program {
    return [...program, ...ops];
}
