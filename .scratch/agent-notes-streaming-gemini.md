changed files:
- `src/dialects/gemini/wire.ts`
- `src/dialects/gemini/raise.ts`
- `src/dialects/gemini/lower.ts`
- `src/dialects/gemini/index.ts`
- `test/gemini.test.ts`
- `.scratch/agent-notes-streaming-gemini.md`

decisions:
- plugged Gemini into the existing `responseStream` codec shape already present in core and OpenAI Chat.
- Gemini stream text chunks raise to `response.text_delta`.
- Gemini stream functionCall chunks raise to one `response.tool_call_delta` with complete JSON-stringified args; no partial JSON accumulator behavior.
- Gemini stream finish reasons and usage reuse the existing `response.stop` and `response.usage` stages.
- usage-only Gemini stream chunks lower back to `usageMetadata` without synthesizing an empty `candidates` array.
- finishReason and candidate metadata still require candidate content on lowering, matching the current final-response strictness instead of inventing contentless candidate serialization.

commands run:
- `bun test test/gemini.test.ts test/gemini_stages.test.ts test/translate.test.ts`
  - baseline before edits: 67 pass, 0 fail.
  - after edits: 71 pass, 0 fail.
- `bun run typecheck`
  - pass: `bunx tsc --noEmit`.
- `bunx prettier src/dialects/gemini/wire.ts src/dialects/gemini/raise.ts src/dialects/gemini/lower.ts src/dialects/gemini/index.ts test/gemini.test.ts --write`
  - formatted touched files; only `test/gemini.test.ts` changed.
- `bun test`
  - 201 pass, 0 fail.
