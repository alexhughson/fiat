Goal:
Move the Claude Code Anthropic request compatibility discovered by the proxy smoke into the library-level Anthropic -> OpenAI Chat translation path. A real Claude Code request with cache_control text blocks, system blocks, metadata, thinking, context_management, output_config, and stream should translate to an OpenAI Chat request through the normal raise/lower/legalize pipeline.

Context:
- The current proxy workaround lives in `examples/anthropic-openai-proxy.ts` inside `requestPasses()`. That code should shrink after this work; library code should handle body-part conversion.
- Saved real Claude Code request traces are under `examples/output/anthropic-openai-proxy-smoke/2026-07-03T21-23-37.065Z/*.json`.
- Relevant source files:
  - `src/dialects/anthropic_messages/wire.ts`
  - `src/dialects/anthropic_messages/raise.ts`
  - `src/dialects/anthropic_messages/ops.ts`
  - `src/dialects/openai_chat/index.ts`
  - `src/dialects/openai_chat/wire.ts`
  - likely add `src/dialects/openai_chat/legalize.ts`
  - tests in `test/translate.test.ts`, `test/anthropic_messages.test.ts`, or a focused new stage test.
- Existing architecture: source dialect raises to core + residuals; target dialect lowers; target legalizations run; `lintForeignResiduals` fails on unconsumed required residuals. Use that mechanism. Do not put cross-provider compatibility in the proxy.

Required behavior:
- `translateRequest(realClaudeCodeBody, { from: "anthropic_messages", to: "openai_chat" })` succeeds for the real request shape.
- `cache_control:{type:"ephemeral"}` on Anthropic text content blocks, system blocks, and tool metadata is explicitly consumed for OpenAI Chat while preserving actual text/tool semantics.
- Anthropic `metadata.user_id` maps to OpenAI Chat `user`; do not map it to OpenAI `metadata`, because live OpenAI rejected that unless `store` is enabled.
- Anthropic `thinking:{type:"disabled"}` and `thinking:{type:"adaptive",display:"omitted"}` are consumed for OpenAI Chat; summarized/manual/unknown thinking still fails.
- Anthropic `context_management` is consumed only for `{ edits: [{ type:"clear_thinking_20251015", keep:"all" }] }`; unknown edits still fail.
- Anthropic `output_config.effort` maps to OpenAI Chat `reasoning_effort`; `output_config.format:{type:"json_schema",schema}` maps to core `llm.output` / OpenAI `response_format`.
- Anthropic `stream` maps to OpenAI Chat `stream` in library translation.
- The example proxy may still force backend `stream:false` after translation because it synthesizes Anthropic SSE from a full OpenAI response. That is transport orchestration; do not leave body-part compatibility there.

Constraints:
- Keep the change small and in dialect ownership boundaries.
- No silent broad drops. Only consume the concrete non-semantic provider hints above. Unknown fields should continue to fail via residual lint or explicit errors.
- Do not add a generic "drop Anthropic params for OpenAI" pass.
- Do not touch unrelated dirty files.
- Comments only where the real-world provider shape is surprising.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- Add/adjust tests that use a real-shaped Claude Code request fixture and show the translated OpenAI Chat body.
- Run targeted tests for Anthropic/OpenAI translation.
- Run the proxy smoke if possible after the main agent updates the proxy to rely on library behavior.

Out of scope:
- Streaming response translation as a general library feature.
- OpenAI Responses dialect support.
- Full Claude Code tool execution. This task only covers request body conversion discovered by the real `claude -p --tools ""` smoke.

Self-report:
Write `.scratch/agent-notes-anthropic-openai-real-usage.md` with changed files, decisions, commands run, and results.
