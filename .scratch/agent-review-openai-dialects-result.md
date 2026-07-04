# Agent review: OpenAI dialect changes

Reviewed uncommitted work on branch `codex/provider-dialects-cleanup` (read-only). All `test/openai_responses.test.ts` and `test/openai_chat.test.ts` cases pass (23/23). Relevant `test/translate.test.ts` cases pass (15/15).

## Verdict

**Approve with minor test gaps.** The openai_chat and openai_responses changes implement the stated metadata preservation, stop-reason hardening, and request-serialization behavior. Core IR and pipeline edits are necessary companions, not accidental scope creep. Remaining risk is untested mismatch paths and asymmetric stop-reason test coverage for openai_responses.

## High-priority findings

1. **Check 1 does not hold — core and package surface changes are required.** The feature set depends on edits outside the two dialect directories:
   - `src/core/ops.ts`: new `StopReason` variants (`content_filter`, `refusal`, `pause_turn`, `model_context_window_exceeded`) and `appliesTo` on `DialectOp`.
   - `src/core/pipeline.ts`: `stripHostOps` filters dialect ops whose `appliesTo` disagrees with the target kind (this is how `message_meta`, `output_meta`, and response-tagged params stay out of request bodies).
   - `src/index.ts`: exports `OpenAIResponsesTranslator` (and sibling dialects on the same branch).
   Without these, `content_filter` stop mapping, response-only metadata stripping, and cross-provider `tool_meta` linting cannot work as designed.

2. **No automated test proves the stale-`output_meta` guard (check 2).** `lowerResponse` throws `LintError` when text/tool counts disagree with `output_meta` templates (`fewer/more core text ops`, missing tool call for `call_id`, mixed message/function_call consumption). That logic is present and sound, but nothing asserts those failure modes; a regression could reintroduce silent stale metadata without CI signal.

## Medium-priority findings

1. **Stop-reason throw coverage is asymmetric for openai_responses.** `openai_responses.test.ts` covers `pause_turn` on direct `toResponse`; `openai_chat.test.ts` covers `model_context_window_exceeded`. `lowerStopReason` in `openai_responses/lower.ts` throws for both, but only one is exercised for that dialect.

2. **`translate.test.ts` now bundles unrelated gemini/realtime scenarios** in the same diff hunk as the openai blocker tests. Check 9 still passes (blockers do not import `test/gemini.test.ts` or `test/openai_realtime.test.ts`), but the file mixes concerns and requires those dialects to be registered via `src/index.ts` for the whole suite to run.

3. **Trailing assistant `llm.text` ops without a following `output_meta` are synthesized** in `lowerResponse` with default `annotations: []` / `logprobs: []` (`synthesizedContent`). Normal raise/wire paths always pair output items with `output_meta`, so this only matters for hand-built programs; worth knowing if transforms splice core text without preserving meta ops.

4. **`openai_responses` request envelope param dropping** (`skipRequestParam` + `RESPONSE_ENVELOPE_PARAM_KEYS`) mirrors openai_chat but has no dedicated test analogous to openai_chat’s `legacy response envelope params do not leak into request bodies`.

5. **`openai_chat.message_meta` is always tagged `appliesTo: "response"`** even when raised from a request-body message that happens to carry `refusal`/`annotations`/`audio`. It will not leak into `toBody` (stripped by pipeline), but a request round-trip would drop those fields — likely acceptable since they are response-only on the wire.

## Confirmed OK

| # | Check | Status |
|---|-------|--------|
| 1 | No edits outside `openai_responses/*` and `openai_chat/*` needed | **Not confirmed.** Core `StopReason` / `appliesTo` / `stripHostOps` and `index.ts` export are required (see high-priority #1). `src/core/program.ts` type refactor is incidental, not feature-critical. |
| 2 | `lowerResponse` cannot silently emit stale `output_meta` when core ops mismatch | **Confirmed in code.** `contentFromTemplate` enforces part/text cardinality; `functionCallFromMeta` requires a matching `llm.tool_call`; cross-type consumption throws. Explicit tests missing (see high-priority #2). |
| 3 | Multiple openai_responses message output items round-trip without collapsing | **Confirmed.** `multi-message responses preserve output item status and content metadata` passes; raise emits one `llm.text` + `output_meta` pair per message item; lower consumes each meta with its pending texts. |
| 4 | Annotations/logprobs and item status survive home response round-trip | **Confirmed.** openai_responses multi-message test preserves per-part annotations/logprobs and per-item `status`; openai_chat `response-only assistant metadata round-trips` preserves `refusal`/`annotations`/`audio` via `message_meta`. |
| 5 | `tool_meta` required by default; cross-provider translation halts unless dropped | **Confirmed.** `toolFromWire` emits `tool_meta` without `required: false`; `lintForeignResiduals` throws on foreign required residuals; `translate.test.ts` `openai responses function tool extras halt when translated cross-provider` asserts `LintError` for `strict: true` → openai_chat. Home round-trip test in `openai_responses.test.ts` also passes. |
| 6 | `message_meta` response-only; cannot leak into request bodies via `toBody` | **Confirmed.** Raised with `appliesTo: "response"`; `stripHostOps("request", …)` removes it; `requestToWire` has no `message_meta` arm and would throw if it slipped through. Dedicated test strips meta from `toBody` output. |
| 7 | Legacy droppable `openai_chat.body_field` `id` dropped from requests; `user` kept | **Confirmed.** `skipRequestParam` drops `required: false` keys in `RESPONSE_ENVELOPE_PARAM_KEYS` (includes `id`); `user` is not in that set and serializes. Test `legacy response envelope params do not leak into request bodies` passes. |
| 8 | `pause_turn` / `model_context_window_exceeded` throw in openai_chat and openai_responses targets | **Confirmed in implementation** (`lowerFinishReason` / `lowerStopReason`). **Tests:** openai_chat `model_context_window_exceeded`; openai_responses `pause_turn`; cross-target `pause_turn` → openai_responses in `translate.test.ts`. openai_responses `model_context_window_exceeded` direct test absent (medium #1). |
| 9 | Tests cover blockers without relying on gemini/realtime test files | **Confirmed.** Blockers live in `test/openai_responses.test.ts`, `test/openai_chat.test.ts`, and openai-focused cases in `test/translate.test.ts`. No imports of `test/gemini.test.ts` or `test/openai_realtime.test.ts` for these behaviors. |
