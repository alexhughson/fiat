import type { Program } from "./ops";
import type { Target } from "./pass";

// raise and lower are pipelines of stages, not monolithic switches. A stage
// is any Program -> Program function that rewrites the ops it cares about
// and passes everything else through untouched. That passthrough is load-
// bearing: it keeps residuals and foreign-dialect ops flowing to the
// pipeline's residual lint, and it makes a partially raised (or partially
// lowered) program still a valid program. Adding support for a new construct
// means appending a stage — existing stages never grow.
export type Stage = (program: Program, target?: Target) => Program;

// Composes left to right. Reads the array on every call, so a module may
// push more stages after the pipeline was constructed.
export function stagePipeline(stages: Stage[]): Stage {
    return (program, target) =>
        stages.reduce((current, stage) => stage(current, target), program);
}
