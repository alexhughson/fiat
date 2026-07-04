# Change

Provider-local raise/lower hooks were added, Gemini `generationConfig` became `gemini.generation_config`, and Gemini `llm.thinking` now lowers to documented model-specific thinking controls.

# Known decisions

- Raise/lower half APIs stay provider-local:
  - `raiseFromWire(kind, dialectName, wire, { beforeRaise, afterRaise })`
  - `lowerToWire(kind, dialectName, program, { beforeLower, afterLower })`
- `translate*` accepts string dialect names or translator-like `{ name }` objects, but normalizes to names immediately.
- No `afterLegalize` hook exists. `afterLower` runs before built-in legalizations.
- `beforeLower` runs after host/request/response stripping and before dialect lower.
- Gemini native `generationConfig` is represented as `gemini.generation_config`, not `gemini.body_field`.
- Gemini `llm.thinking` defaults:
  - Gemini 3 models: `thinkingConfig.thinkingLevel` for low/medium/high, reject xhigh/max.
  - Gemini 2.5 models: `thinkingConfig.thinkingBudget` low=1024, medium=4096, high=8192, xhigh=16384, max=24576.

# Checks

1. Verify no raise hook can see or depend on the target dialect.
2. Verify lower hooks cannot bypass target legalizations or residual lint.
3. Verify `TranslateOptions.passes` still runs on core IR between raise and lower.
4. Verify translator facade still matches docs and does not require callers to import dialect objects.
5. Verify dialect index registration side effects are intact.
6. Verify `gemini.body_field key:"generationConfig"` no longer appears in tests/e2e/source except maybe compatibility rejection.
7. Verify Gemini `generation_config` merges with `llm.output`, `llm.temperature`, `llm.max_output_tokens`, and thinking without overwrites.
8. Verify the Gemini thinking defaults are not silently swallowing unsupported efforts/models.
9. Verify docs do not claim thinking is unmodeled or generationConfig is a generic param.

# Delegation boundary

Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

# Out of scope

Style-only comments, unrelated cleanup, live API reruns.

# Report format

Verdict / High-priority findings / Medium / Confirmed OK. Use file:line cites and one-line impact.
