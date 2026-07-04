# review: openai realtime e2e and dialect hardening

## change

The diff hardens `openai_realtime` and adds e2e validation:

- top-level realtime request `model` maps to/from `llm.model`, allowing OpenAI Chat-shaped requests to lower to realtime request bodies;
- realtime request event/item/content metadata round-trips with `openai_realtime.item_meta`;
- realtime function tool extra fields round-trip with `openai_realtime.tool_meta`;
- response output metadata/templates preserve content metadata and multiple text parts instead of collapsing them;
- realtime-only audio content remains a required realtime residual and halts cross-provider translation;
- new `e2e/openai_realtime` runner, validator, README, and fixtures;
- package scripts for realtime e2e;
- tests in `test/openai_realtime*.test.ts` and `test/translate.test.ts`.

## known decisions

- No new core audio/image IR. Realtime-only data remains dialect residuals.
- Realtime websocket live runner exists, but live execution currently fails in this environment with websocket close `1006 Failed to connect`. Offline fixture validator passes.
- `llm.temperature` still lints for realtime; `llm.model` no longer lints and serializes top-level.
- Streaming deltas remain out of scope; `response.done` is the response artifact.

## checks

1. `openai_realtime.item_meta` is consumed on home lower and does not leak into `requestToWire`.
2. Required realtime residuals still halt when translating to another dialect; nothing newly drops metadata silently.
3. Reapplying request metadata cannot silently pair stale metadata with the wrong number/type/role of core ops.
4. Reapplying response output metadata cannot silently collapse multiple content parts or discard part metadata.
5. `llm.model` top-level lowering does not break existing event-body round trips and does not leak response-only params into requests.
6. Tool metadata reapplication handles metadata before and after `llm.tool`, and missing tools still lint.
7. E2E validator actually recomputes the translated request and response round-trip instead of trusting saved fields.
8. Live websocket runner reports failures loudly and does not synthesize response artifacts on failure.
9. Docs match behavior: audio is residual-only, not cross-provider core support.
10. Scope stayed inside realtime dialect/tests/e2e/docs/package/readme; no core changes introduced for this task.

## delegation boundary

Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

## out of scope

Style-only comments, unrelated dirty-tree changes, new universal media IR, SDK adoption, WebRTC UI/session management.

## report format

Verdict / High-priority findings / Medium / Confirmed OK. Include file:line cites and one-line impact for findings.
