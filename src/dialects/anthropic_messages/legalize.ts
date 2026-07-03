// Legalizations: target-scoped passes that run on the lower IR after
// lowering, before toWire. This is where endpoint/model quirks live.

import type { Program } from "../../core/ops";
import { firstOp } from "../../core/program";
import type { Pass } from "../../core/pass";

// The Messages API rejects requests without max_tokens, but most other
// providers treat it as optional — so a program translated from elsewhere
// often arrives without one. Filling in a ceiling conforms the request
// without changing its meaning (it's a cap, not an instruction).
export const DEFAULT_MAX_TOKENS = 4096;

export const defaultMaxTokens: Pass = {
  name: "anthropic_messages.default-max-tokens",
  appliesTo: (target) => target.kind === "request",
  run(program: Program): Program {
    if (firstOp(program, "llm.max_output_tokens")) return program;
    return [...program, { op: "llm.max_output_tokens", value: DEFAULT_MAX_TOKENS }];
  },
};

export const legalizations: Pass[] = [defaultMaxTokens];
