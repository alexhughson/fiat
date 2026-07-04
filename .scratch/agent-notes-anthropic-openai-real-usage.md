Changed files:
- `src/dialects/anthropic_messages/wire.ts`
- `src/dialects/anthropic_messages/raise.ts`
- `src/dialects/openai_chat/lower.ts`
- `examples/anthropic-openai-proxy.ts`
- `test/fixtures/claude_code_anthropic.ts`
- `test/translate.test.ts`
- `test/anthropic_messages.test.ts`
- `test/anthropic_messages_stages.test.ts`
- `test/openai_chat_stages.test.ts`

Decisions:
- Moved Claude Code Anthropic request compatibility out of the proxy and into dialect-owned library code.
- `anthropic_messages.requestFromWire` now emits top-level `system` before `messages`, even when the JSON object lists messages first. The real Claude Code body lists `messages` first, but Anthropic top-level system is semantically pre-conversation.
- `anthropic_messages.raiseOutputConfig` maps supported `output_config.format:{type:"json_schema",schema}` to core `llm.output` and keeps remaining provider config, such as `effort`, as `anthropic_messages.body_field`.
- `openai_chat.lowerAnthropicRequestResiduals` consumes only exact known Anthropic request residuals:
  - ephemeral `cache_control` on text content/system blocks
  - ephemeral `cache_control` on tool metadata
  - `metadata.user_id` -> OpenAI `user`
  - `thinking:{type:"disabled"}` and `thinking:{type:"adaptive",display:"omitted"}`
  - `context_management:{edits:[{type:"clear_thinking_20251015",keep:"all"}]}`
  - `output_config.effort` -> `reasoning_effort`
  - `output_config.format` -> `llm.output`
  - `stream` -> OpenAI `stream`
  - `stop_sequences` -> OpenAI `stop`
- Unsupported or broader Anthropic shapes still fail with `LintError` or survive as required residuals. No generic drop pass was added.
- The proxy request policy now only reroutes the model. It still forces backend `stream:false` after translation because that example synthesizes Anthropic SSE from a full OpenAI response.

Commands run:
- Baseline real trace translation:
  - `bun -e '... translateRequest(trace.anthropicRequest, { from: "anthropic_messages", to: "openai_chat" }) ...'`
  - Result before changes: failed with `LintError: op "anthropic_messages.content_block" survived lowering to "openai_chat"`.
- Targeted tests:
  - `bun test test/translate.test.ts test/anthropic_messages.test.ts test/anthropic_messages_stages.test.ts test/openai_chat_stages.test.ts`
  - Result: 84 pass, 0 fail.
- Real saved trace translation after changes:
  - `bun -e '... translateRequest(trace.anthropicRequest, { from: "anthropic_messages", to: "openai_chat" }) ...'`
  - Result: passed; output contains system messages first, user message text, `user`, `reasoning_effort:"medium"`, and `stream:true`.
- Full typecheck:
  - `bunx tsc --noEmit`
  - Result: pass.
- Full tests:
  - `bun test`
  - Result: 220 pass, 0 fail.
- Formatting:
  - `bunx prettier --write ...`
  - Result: unchanged.
- Proxy smoke:
  - `bun run example:anthropic-openai-proxy:smoke`
  - Sandbox result: failed with `EPERM` on localhost listen.
  - Escalated rerun was rejected by the escalation reviewer because the Claude Code smoke would send local workspace metadata/git status to OpenAI.

Unresolved:
- Real external proxy smoke was not run after this change because of the exfiltration risk above. The saved real request trace now exercises the same body shape through the library translation path.
