import type { Op, Program } from "./ops";

// raise and lower are pipelines of stages, not monolithic switches. Adding
// support for a new construct means appending a rule or a stage — existing
// functions never grow.

// A stage is any whole-program rewrite. Use a full stage only when the
// rewrite is inherently cross-op (message grouping); everything else should
// be an OpRule.
export type Stage = (program: Program) => Program;

export function stagePipeline(...stages: Stage[]): Stage {
  return (program) => stages.reduce((current, stage) => stage(current), program);
}

// A per-op rewrite: fires on ops whose name equals `match`, replacing the
// op with the returned list (empty = delete, several = expand). Ops no rule
// matches pass through untouched — that passthrough is what keeps residuals
// and foreign-dialect ops flowing to the pipeline's residual lint.
export interface OpRule {
  name: string;
  match: string;
  rewrite: (op: Op) => Op[];
}

export function rewriteOps(rules: OpRule[]): Stage {
  return (program) =>
    program.flatMap((op) => {
      // Linear scan, first match wins. Rule lists are read per call, so a
      // module may append rules after the stage was constructed.
      const rule = rules.find((r) => r.match === op.op);
      return rule ? rule.rewrite(op) : [op];
    });
}
