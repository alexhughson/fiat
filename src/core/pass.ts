import type { Program } from "./ops";

// Where a program is headed. Passes use this to scope themselves — e.g. a
// legalization that only applies to a model family, only to requests, or
// only when lowering to one dialect.
export interface Target {
  dialect: string;
  kind: "request" | "response";
  model?: string;
}

// A pass is a pure Program -> Program function. Two conventions, not two
// types:
//   - transform/legalize: rewrites the program toward something the target
//     accepts (drop an unsupported param, insert a required default).
//   - lint: rewrites nothing; throws LintError when conforming would change
//     the meaning of the request.
export interface Pass {
  name: string;
  appliesTo?: (target: Target) => boolean;
  run: (program: Program, target: Target) => Program;
}

// The meaning of the program can't survive the target. Never caught
// internally — a lint failure halts the translation.
export class LintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LintError";
  }
}

export function runPasses(program: Program, passes: Pass[], target: Target): Program {
  let current = program;
  for (const pass of passes) {
    if (pass.appliesTo && !pass.appliesTo(target)) continue;
    current = pass.run(current, target);
  }
  return current;
}
