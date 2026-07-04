changed files:
- `src/core/ops.ts`
- `src/core/pipeline.ts`
- `src/core/registry.ts`
- `src/dialects/anthropic_messages/ops.ts`
- `src/dialects/anthropic_messages/wire.ts`
- `src/dialects/anthropic_messages/raise.ts`
- `src/dialects/anthropic_messages/lower.ts`
- `src/dialects/anthropic_messages/index.ts`
- `test/anthropic_messages.test.ts`
- `test/translate.test.ts`
- `.scratch/agent-notes-streaming-anthropic.md`

decisions:
- implemented Anthropic Messages response stream conversion through the existing `responseStream` codec surface.
- made `Dialect.responseStream` optional so dialects without stream support still register; using their stream translator now throws a direct unsupported-dialect error.
- added `index?: number` to `response.text_delta` so Anthropic content block indexes survive raise/lower.
- represented Anthropic `content_block_start` tool-use events as `response.tool_call_delta` with `index`, `id`, and `name`.
- represented Anthropic `input_json_delta.partial_json` as `response.tool_call_delta.arguments` without parsing JSON fragments.
- represented `message_delta` stop reason and usage as `response.stop` and `response.usage`.
- represented `message_stop` as a droppable Anthropic residual because there is no core semantic payload.
- unsupported Anthropic stream events and unsupported delta/block types throw.

commands run:
- `bun test test/anthropic_messages.test.ts test/translate.test.ts`
  - baseline before edits: 45 pass, 0 fail.
- `bun test`
  - baseline before edits: 197 pass, 0 fail.
- `bun run tsc --noEmit`
  - baseline before edits: failed because `Dialect.responseStream` was required but dialect registrations did not provide it.
- `./node_modules/.bin/prettier --write src/core/ops.ts src/core/pipeline.ts src/core/registry.ts src/dialects/anthropic_messages/ops.ts src/dialects/anthropic_messages/wire.ts src/dialects/anthropic_messages/raise.ts src/dialects/anthropic_messages/lower.ts src/dialects/anthropic_messages/index.ts test/anthropic_messages.test.ts test/translate.test.ts`
  - formatted touched files.
- `bun test test/anthropic_messages.test.ts test/translate.test.ts`
  - final: 52 pass, 0 fail.
- `bun run typecheck`
  - final: pass.
- `bun test`
  - final: 208 pass, 0 fail.
