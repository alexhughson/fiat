import type { Program } from "./ops";

// Where a program is headed. Request legalizations use this to pick the
// target model behavior and whether to clean up or lint unsupported controls.
export interface Target {
    dialect: string;
    kind: "request" | "response" | "response_stream";
    model?: string;
    strict?: boolean;
}

// A pass is a pure Program -> Program function. Two conventions, not two types:
//   - transform/legalize: rewrites the program toward something the target
//     accepts (drop an unsupported param, insert a required default).
//   - lint: rewrites nothing; throws LintError when conforming would change
//     the meaning of the request.
export type Pass = (program: Program, target: Target) => Program;

// The meaning of the program can't survive the target. Never caught
// internally — a lint failure halts the translation.
export class LintError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LintError";
    }
}

export function runPasses(
    program: Program,
    passes: Pass[],
    target: Target,
): Program {
    let current = program;
    for (const pass of passes) {
        current = pass(current, target);
    }
    return current;
}
