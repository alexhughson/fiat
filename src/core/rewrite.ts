import type { Program } from "./ops";

// Where a program is headed. Target-scoped stages use this to pick model
// behavior and whether to clean up or lint unsupported controls.
export interface Target {
    dialect: string;
    kind: "request" | "response" | "response_stream";
    model?: string;
    strict?: boolean;
}

// raise and lower are pipelines of stages, not monolithic switches. A stage
// is any Program -> Program function that rewrites the ops it cares about
// and passes everything else through untouched. That passthrough is load-
// bearing: it keeps residuals and foreign-dialect ops flowing to the
// pipeline's residual lint, and it makes a partially raised (or partially
// lowered) program still a valid program. Adding support for a new construct
// means appending a stage — existing stages never grow.
export type Stage = (program: Program, target?: Target) => Program;

// Composes left to right. Snapshots the array at construction time, so
// mutating the source array afterward has no effect on this pipeline.
export function stagePipeline(stages: Stage[]): Stage {
    const snapshot = [...stages];
    return (program, target) =>
        snapshot.reduce((current, stage) => stage(current, target), program);
}
