Change:
Add a Gemini-only on-demand e2e harness and fix a live Gemini 2.5 Flash response gap found by the harness.

Known decisions:
- Scope is only Gemini e2e plus the Gemini response `functionCall.id` fix. Ignore the large pre-existing dirty workspace outside the files below unless it directly breaks these changes.
- The live runner writes ignored artifacts under `e2e/gemini/output/latest/`.
- `models/gemini-3.5-flash` and `models/gemini-2.5-flash` get `generationConfig.thinkingConfig.thinkingBudget: 0` because live runs otherwise spent the output cap on thoughts and returned empty content.
- `models/gemini-2.5-pro` remains in the default model list but uses a larger output cap instead of disabling thinking.
- Gemini 2.5 Flash can return `functionCall` without `id`; the dialect now synthesizes a core id (`gemini_call_<part index>`) and records `idSource: "synthesized"` in `gemini.part_meta` so `toResponse(fromResponse(wire))` omits the id again.

Files to review:
- `src/dialects/gemini/ops.ts`
- `src/dialects/gemini/raise.ts`
- `src/dialects/gemini/lower.ts`
- `test/gemini.test.ts`
- `test/fixtures/gemini.ts`
- `e2e/gemini/run.ts`
- `e2e/gemini/shared.ts`
- `e2e/gemini/validate.ts`
- `e2e/gemini/README.md`
- `package.json`
- `tsconfig.json`
- `.gitignore`
- `README.md`
- `docs/dialects/gemini.md`

Checks:
- Does the synthesized-id path preserve exact Gemini response round-trip for missing-id function calls?
- Does the marker get consumed only for response lowering and not leak to request wire?
- Does the e2e runner fail loudly on missing key, model unavailability, malformed request lowering, API error, bad response shape, or response round-trip mismatch?
- Does `multimodal-tool` actually validate a mixed core/Gemini-IR request with inline image and forced tool choice?
- Does the offline validator validate saved artifacts without network access and without trusting stale `checks` arrays?
- Do package scripts point only to `e2e/gemini/run.ts` and `e2e/gemini/validate.ts`?
- Are generated artifacts ignored while source e2e files remain visible to git?
- Are comments/docs concrete and not overclaiming full multimodal core support?

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
Style-only comments, broad refactors, OpenAI/Anthropic behavior, and unrelated pre-existing dirty files.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Use file:line cites and one-line impact.
