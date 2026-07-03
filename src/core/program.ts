import type { CoreOp, Op, Program } from "./ops";

type OpNamed<K extends CoreOp["op"]> = Extract<CoreOp, { op: K }>;

export function opsOf<K extends CoreOp["op"]>(program: Program, op: K): OpNamed<K>[] {
  return program.filter((o): o is OpNamed<K> => o.op === op);
}

export function firstOp<K extends CoreOp["op"]>(program: Program, op: K): OpNamed<K> | undefined {
  return program.find((o): o is OpNamed<K> => o.op === op);
}

// Structural-equality-free append: responses share the core schema, so
// chaining a response onto a request is plain concatenation.
export function append(program: Program, ...ops: Op[]): Program {
  return [...program, ...ops];
}
