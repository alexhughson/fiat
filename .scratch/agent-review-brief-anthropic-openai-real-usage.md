Change:
Library-level support for real Claude Code Anthropic request shapes when targeting OpenAI Chat. The new `src/dialects/openai_chat/legalize.ts` consumes concrete Anthropic request residuals after OpenAI lowering and before foreign residual lint. The proxy example is reduced to model routing plus backend transport normalization.

Files to review:
- `src/dialects/openai_chat/legalize.ts`
- `src/dialects/openai_chat/index.ts`
- `test/translate.test.ts`
- `test/fixtures/claude_code_anthropic.ts`
- `examples/anthropic-openai-proxy.ts`
- `examples/anthropic-openai-proxy-smoke.ts`
- `package.json`
- `.gitignore`

Known decisions:
- Anthropic `cache_control:{type:"ephemeral"}` is treated as a cache/perf hint and stripped only for text/system/tool metadata when targeting OpenAI Chat.
- Anthropic `metadata.user_id` maps to OpenAI Chat `user`; OpenAI rejected `metadata` without `store` in the live smoke.
- Anthropic `stream` maps to OpenAI Chat `stream` at library level. The example then sets backend `stream:false` because it synthesizes Anthropic SSE from a full OpenAI response.
- Anthropic hidden thinking modes `disabled` and `adaptive/display:omitted` are consumed for OpenAI Chat. Summarized/manual/unknown thinking should still fail.
- `context_management` is consumed only for `clear_thinking_20251015` with `keep:"all"`.

Checks:
- Does `legalize.ts` ever silently drop semantic Anthropic data outside the explicitly listed cases?
- Does it emit lower-IR ops that `openai_chat.requestToWire` can serialize after lower has already run?
- Does system message hoisting preserve Anthropic top-level system semantics without reordering user/assistant turns incorrectly?
- Are unsupported cache control, thinking, metadata, context_management, or output_config variants still loud failures?
- Does the proxy still contain body-part compatibility that belongs in the library?
- Is the fixture realistic enough to document the Claude Code request that caused the issue?
- Does mapping `metadata.user_id` to `user` avoid the observed OpenAI 400 while preserving the useful value?
- Are tests proving direct `translateRequest(... from anthropic_messages to openai_chat ...)`, not only proxy behavior?

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
- General streaming response translation design.
- OpenAI Responses dialect.
- Style-only comments and unrelated dirty files.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Include file:line cites and one-line impact for every finding.
