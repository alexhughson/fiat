import { LintError, lintOrWarn } from "./lint.js";
import { opData, type Op, type OpOf, type Program } from "./ops.js";
import type { Target } from "./rewrite.js";

export type Reasoning = OpOf<"llm.reasoning">;

// Ids are unique within one raise call only, and a program may hold several
// raised bodies, so a side op belongs to the nearest earlier llm.reasoning
// with the id it names in `of`.
export function sideOpsOf(
    program: Program,
    names: string[],
): Map<Reasoning, Op[]> {
    const latestById = new Map<string, Reasoning>();
    const sideOps = new Map<Reasoning, Op[]>();
    for (const op of program) {
        if (op.op === "llm.reasoning") {
            const reasoning = op as Reasoning;
            latestById.set(reasoning.id, reasoning);
            sideOps.set(reasoning, []);
            continue;
        }
        if (!names.includes(op.op)) continue;
        const of = opData<{ of: string }>(op).of;
        const reasoning = latestById.get(of);
        if (!reasoning) {
            throw new LintError(
                `${op.op} names llm.reasoning ${JSON.stringify(of)}, and no earlier llm.reasoning has that id`,
            );
        }
        sideOps.get(reasoning)!.push(op);
    }
    return sideOps;
}

// A signature is valid only for the provider that issued it, so a dialect
// reads the signature only when the op records that dialect as the issuer.
export function signatureFor(
    reasoning: Reasoning,
    dialect: string,
): string | undefined {
    return reasoning.signature?.dialect === dialect
        ? reasoning.signature.value
        : undefined;
}

// Ids restart on every raise call; see sideOpsOf for how a reference resolves.
export function reasoningIds(): () => string {
    let count = 0;
    return () => `reasoning_${++count}`;
}

// For a dialect whose wire has no place for reasoning.
export function dropReasoning(program: Program, target?: Target): Program {
    return program.filter((op) => {
        if (op.op !== "llm.reasoning") return true;
        warnDropped(op as Reasoning, target, "has no field for reasoning");
        return false;
    });
}

export function warnDropped(
    reasoning: Reasoning,
    target: Target | undefined,
    why: string,
): void {
    lintOrWarn(
        target?.strict,
        `dropped llm.reasoning ${JSON.stringify(reasoning.id)}: ${target?.dialect ?? "the target dialect"} ${why}`,
    );
}
