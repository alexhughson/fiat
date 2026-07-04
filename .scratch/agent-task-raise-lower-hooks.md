# Goal

Implement provider-local raise/lower intervention hooks and make Gemini `generationConfig` an owned Gemini op instead of a generic `gemini.body_field`.

# Gate

1. Goal: callers can run pure `Program -> Program` transforms before/after a dialect raise or lower edge, without the source dialect knowing the final target dialect.
2. Natural home: `src/core/pipeline.ts` owns `fromWire -> raise` and `lower -> toWire`; `src/core/translator.ts` exposes README-facing dialect methods; `src/dialects/gemini/*` owns Gemini lower IR shape.
3. Current behavior: `raiseFromWire` has no hooks; `lowerToWire` has no hooks except built-in target legalizations after lower; `translate*` only has `passes` between raise and lower; Gemini stores `generationConfig` leftovers in `gemini.body_field`.
4. Existing path to extend: use existing `Stage = Program => Program` from `core/rewrite.ts` for hooks, not new lifecycle middleware.
5. No LLM prompt/config issue.
6. Real data shape: Gemini e2e currently injects `{ op: "gemini.generation_config", value: { thinkingConfig: { thinkingBudget: 0 } } }`; the library should represent that as Gemini lower IR.
7. This belongs in the library because callers currently need orchestration workarounds for lower/legalize quirks.
8. Scope: hooks only around half-pipeline edges; no destination-aware raise context, no post-legalize hook, no speculative plugin system.
9. Consumers: exported `raiseFromWire`, `lowerToWire`, stream variants, `translate*`, dialect translator objects, tests, examples.
10. Structural but tight: changes the public conversion API and one dialect op shape.
11. Risks: hooks could bypass validation if placed after legalize; avoid that. Gemini op migration could break roundtrip if `generationConfig` merge semantics change.
12. No silent fallbacks. Unknown residuals still fail.
13. Proof: unit tests showing hook order and Gemini op roundtrip/default override behavior.
14. Baseline: existing tests cover translation and Gemini roundtrip; changed tests should explain every expectation shift from `gemini.body_field` to `gemini.generation_config`.

# Context

Important files:

- `src/core/pipeline.ts`
  - `raiseFromWire(kind,dialect,wire)` currently does `codec.raise(codec.fromWire(wire))`.
  - `lowerToWire(kind,dialect,program)` currently does `codec.lower(stripHostOps(...))`, built-in legalizations, residual lint, `codec.toWire`.
  - `translate*` uses those halves and `passes` between raise/lower.
- `src/core/translator.ts`
  - `makeTranslator` exposes `fromBody`, `toBody`, etc.
- `src/core/rewrite.ts`
  - `Stage = (program: Program) => Program`, `stagePipeline(stages)`.
- `src/dialects/gemini/ops.ts`
  - currently has `gemini.body_field`; add a first-class `gemini.generation_config` op.
- `src/dialects/gemini/wire.ts`
  - `generationConfigFromWire` maps known fields to core ops and unknown fields to `gemini.body_field key:"generationConfig"`.
  - `requestToWire` merges `llm.temperature`, `llm.max_output_tokens`, and `gemini.body_field`.
- `src/dialects/gemini/legalize.ts`
  - validates `generationConfig.thinkingConfig.thinkingLevel` by looking inside `gemini.body_field`.
- `e2e/gemini/shared.ts`
  - currently injects thinking budget via `gemini.body_field`; this can shift to the new op or, if you add default `llm.thinking` support, use `llm.thinking`.

# Required implementation

1. Add hook option types around half-pipeline edges:
   - Prefer `Stage[]` or `Stage | Stage[]` helpers, using pure `Program -> Program`.
   - `raiseFromWire(..., opts?)` supports `beforeRaise` and `afterRaise`.
   - `lowerToWire(..., opts?)` supports `beforeLower` and `afterLower`.
   - Stream response halves get equivalent support.
   - `translate*` composes these halves; keep existing `passes` as core-after-raise behavior.
   - Do not create destination-aware raise hooks. Anthropic raise must not know it will lower to OpenAI.
2. Update `makeTranslator` methods to accept matching options:
   - `fromBody(body, opts?)`
   - `toBody(program, opts?)`
   - same for response and stream response.
3. Add `gemini.generation_config`:
   - `generationConfigFromWire` should emit `{ op: "gemini.generation_config", value: extras }` for non-core generation config fields.
   - `requestToWire` should merge `gemini.generation_config.value` into body `generationConfig`.
   - `gemini.body_field` should remain for unknown top-level fields, not known `generationConfig`.
   - update legalize to inspect `gemini.generation_config`.
4. Add Gemini lowering/legalization for `llm.thinking` only if you can do it simply and explicitly:
   - Keep model rules narrow and evidence-based: current e2e expects `thinkingBudget: 0` for Gemini 2.5/3.5 Flash.
   - If implemented, lower `llm.thinking` to `gemini.generation_config` before built-in legalizations.
   - Conflict if an existing `gemini.generation_config` already has `thinkingConfig`.
   - Do not invent a broad effort-to-budget matrix without data.
5. Tests:
   - Hook order on `raiseFromWire`: a `beforeRaise` pass can edit source lower IR before source raise consumes it; an `afterRaise` pass sees core IR.
   - Hook order on `lowerToWire`: `beforeLower` can rewrite `llm.thinking`; `afterLower` can rewrite `gemini.generation_config` before legalize.
   - Existing `translateRequest(..., { passes })` still works.
   - Gemini `generationConfig` roundtrip expects `gemini.generation_config`, not `gemini.body_field`.
   - Illegal Gemini `thinkingLevel` still fails because legalize runs after `afterLower`.

# Constraints

Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Do not revert unrelated dirty work. Do not add a full lifecycle converter. Do not add post-legalize hooks. Do not make hooks async.

# Verify

Run focused tests first, then `bun test`. Run `bunx tsc --noEmit` if available without dependency download.

# Out of scope

No live API e2e. No broad docs rewrite unless a tiny README/API snippet is needed. No Anthropic/OpenAI residual architecture refactor.

# Self-report

Write `.scratch/agent-notes-raise-lower-hooks.md` with changed files, decisions, commands run, and results.
