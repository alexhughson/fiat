files changed:
- `src/core/ops.ts`
- `src/core/wire.ts`
- `src/core/pipeline.ts`
- `src/index.ts`
- `src/dialects/anthropic_messages/raise.ts`
- `src/dialects/anthropic_messages/lower.ts`
- `src/dialects/anthropic_messages/wire.ts`
- `src/dialects/anthropic_messages/legalize.ts`
- `src/dialects/openai_chat/lower.ts`
- `src/dialects/openai_chat/wire.ts`
- `test/anthropic_messages.test.ts`
- `test/openai_chat.test.ts`
- `test/translate.test.ts`

decisions:
- moved shared request concepts into core IR:
  - `request.user`
  - `request.stream`
  - `request.stop_sequences`
  - `llm.thinking`
- kept Anthropic `cache_control:{type:"ephemeral"}` as provider cache metadata. OpenAI lower only consumes that explicit non-semantic cache hint so text/tool semantics can continue lowering.
- kept supported Anthropic `context_management.clear_thinking_20251015 keep:all` as a droppable Anthropic residual. unknown context edits remain required residuals and fail cross-provider.
- Anthropic `thinking:{type:"adaptive",display:"omitted"}` remains preserved for Anthropic home round-trip. portable effort travels as `llm.thinking` from `output_config.effort`.
- Anthropic `thinking:{type:"disabled"}` remains a droppable raw residual and still round-trips home.
- OpenAI Chat no longer translates Anthropic request params. it serializes core `request.*` and `llm.thinking` only.
- added strict parser helpers for booleans, string arrays, and thinking effort so malformed wire bodies halt at raise/lower time.
- `max` remains valid core thinking effort but OpenAI Chat rejects it at serialization because it cannot honestly send it as `reasoning_effort`.
- `request.*` ops are stripped when lowering responses so appended request metadata cannot leak into response wire bodies.

commands run:
- `bun test test/translate.test.ts test/anthropic_messages.test.ts test/openai_chat.test.ts test/openai_chat_stages.test.ts`
  - first run: 1 failure from expected Anthropic message canonicalization (`content:"hi"` lowers back as a text block array)
  - fixed the test to compare canonical Anthropic wire
- `bun test test/translate.test.ts test/anthropic_messages.test.ts test/openai_chat.test.ts test/openai_chat_stages.test.ts`
  - pass: 90 tests
- `bunx tsc --noEmit`
  - pass
- `bun test`
  - pass: 240 tests, 0 fail

notes:
- no subagents were managed in this run, per task instruction.
- live tests ran as part of `bun test` in this worktree and passed.
