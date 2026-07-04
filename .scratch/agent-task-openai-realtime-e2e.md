# task: openai realtime translation hardening and e2e validation

## goal

Add end-to-end validation for the OpenAI Realtime implementation and harden the realtime dialect so:

- normal OpenAI-style requests can translate into realtime event request bodies;
- realtime-shaped responses can translate back into OpenAI Chat/Responses shapes, so a non-realtime backend can power a realtime-equivalent surface;
- realtime-only fields and odd shapes are preserved on home round-trip when possible, and halt cross-provider translation when not explicitly droppable.

## evidence already gathered

- Baseline before edits: `bun test` passes 164 tests; `bun run typecheck` passes.
- Current realtime dialect lives in `src/dialects/openai_realtime/`.
- Current realtime tests live in `test/openai_realtime.test.ts` and `test/openai_realtime_stages.test.ts`.
- Existing e2e pattern is `e2e/gemini/{run.ts,shared.ts,validate.ts,README.md}` with package scripts in `package.json`.
- `src/core/pipeline.ts` already supports strict residual semantics:
  - home dialect residuals serialize back through `toWire`;
  - foreign residuals halt unless `required:false`.
- `src/dialects/openai_responses/*` has the better existing pattern for odd provider fields:
  - canonical fields become core ops;
  - extra tool/output fields become dialect metadata and home-round-trip;
  - cross-provider loss halts unless explicitly droppable.
- Current `openai_realtime` behavior is too narrow:
  - `requestFromWire` rejects `conversation.item.create.event_id` and item metadata;
  - `requestItemFromWire` rejects item `id`, `object`, `status`, and unknown item fields;
  - `toolFromWire` rejects extra function tool fields like `strict`;
  - `raiseMessage` rejects multi-part text messages instead of representing each text part;
  - docs say audio/streaming are out of scope, but current official OpenAI docs expose text/audio/item references, response input, tools, metadata, session/audio config, and `response.done` as the final artifact.
- Official docs facts used:
  - realtime clients send `response.create`; the server ends with `response.done`.
  - `response.done` includes all output items but omits raw audio data.
  - response input can contain arbitrary raw Items and item references.
  - current GA migration docs name `/v1/realtime/calls` for WebRTC setup.

## requested implementation shape

Keep this aligned with existing repo patterns. Prefer small changes in the realtime dialect over a new framework.

### realtime dialect

Update `src/dialects/openai_realtime/*` so home round-trips preserve realtime-only request and response weirdness where possible:

- Preserve `conversation.item.create` event envelope fields such as `event_id` / `previous_item_id`.
- Preserve request item metadata (`id`, `object`, `status`) and unknown item fields when the item is otherwise representable.
- Preserve extra response tool fields, e.g. `strict`, using a realtime-local metadata op similar to `openai_responses.tool_meta`.
- Allow multi-part text messages by raising each supported text part to a separate `llm.text`, then lowering with metadata/template checks so stale metadata cannot silently produce wrong wire.
- Preserve text content part metadata where the core text part is representable; reject unsupported content parts if crossing out of realtime would otherwise lose required data.
- Keep audio/item_reference/raw streaming details as realtime residuals unless there is a clear existing core representation. Do not invent a new universal audio IR.
- Keep `llm.model` request lowering behavior as-is unless you prove `/v1/realtime/calls` request body in this repo should include it. Current event body treats model/session as connection-scoped, and changing that would ripple.

### translation tests

Add tests showing both requested directions:

- OpenAI Chat or OpenAI Responses request -> `openai_realtime` request body with events.
- Realtime `response.done` -> OpenAI Chat or Responses response body.
- Non-realtime backend response -> realtime `response.done`, i.e. `translateResponse(..., { from: "openai_chat" | "openai_responses", to: "openai_realtime" })`.
- Realtime-only odd fields home-round-trip.
- Realtime-only required weirdness halts cross-provider unless a pass marks it droppable.

### e2e validation

Add `e2e/openai_realtime/` matching the gemini shape:

- `run.ts`: live validation runner. It should require `OPENAI_API_KEY`, call current OpenAI realtime calls API, save artifacts, and throw with response text on API failure.
- `validate.ts`: offline validator for saved artifacts.
- `shared.ts`: request builders, artifact writer/reader, response shape validators.
- `README.md`: exact commands, env vars, defaults, and what is proven.
- Add package scripts, probably:
  - `e2e:openai-realtime`
  - `e2e:openai-realtime:validate`

Design runner conservatively:

- Accept `--models=...` and `--out=...`; keep default model list small.
- Save request program, realtime request body/events, raw response body/events, raised response program, and round-trip response body.
- Include at least:
  - text scenario from a normal OpenAI Chat/Responses-shaped request translated into realtime;
  - function tool scenario if the endpoint supports it in a simple request;
  - offline fixture validation for odd fields so CI can prove translator behavior without network.
- If a live endpoint needs multipart/form-data or SDP for `/v1/realtime/calls`, implement that explicitly with `fetch`/`FormData`, not an SDK dependency, unless the existing repo already uses an OpenAI SDK.
- Do not hide unsupported endpoint/mode errors. Throw with status and body.

## constraints

- Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.
- You are not alone in the codebase. Do not revert unrelated changes. Adjust to existing dirty work.
- Keep edits scoped to:
  - `src/dialects/openai_realtime/*`
  - `test/openai_realtime*.test.ts`
  - `test/translate.test.ts`
  - `e2e/openai_realtime/*`
  - `docs/dialects/openai_realtime.md`
  - `package.json`
  - `README.md` only if you add a central scripts mention.
- Do not touch `src/core/*` unless a concrete failing test proves the dialect cannot solve it.
- No new dependencies unless strictly necessary.
- No silent fallbacks. Throw on unsupported loss.
- Comments only for non-obvious invariants.

## verify

Run at least:

- `bun test test/openai_realtime.test.ts test/openai_realtime_stages.test.ts test/translate.test.ts`
- `bun test`
- `bun run typecheck`
- `bun run e2e:openai-realtime:validate` against committed/offline fixtures or a generated offline fixture directory

If live e2e needs network or `OPENAI_API_KEY`, implement it but report whether you ran it.

## out of scope

- New universal audio/image/file core IR.
- WebRTC UI, WebSocket client loop, or media capture.
- OpenAI SDK adoption.
- Rewriting other dialects except adding tests that translate to/from them.
- Broad docs cleanup.

## self-report

Write `.scratch/agent-notes-openai-realtime-e2e.md` with:

- files changed;
- key decisions;
- commands run and results;
- any live e2e commands not run and why.
