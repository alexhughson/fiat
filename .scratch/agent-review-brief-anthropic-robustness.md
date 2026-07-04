Change:
Anthropic Messages now preserves real API shapes instead of flattening them away:
- `src/dialects/anthropic_messages/ops.ts`
- `src/dialects/anthropic_messages/wire.ts`
- `src/dialects/anthropic_messages/raise.ts`
- `src/dialects/anthropic_messages/lower.ts`
- `src/dialects/anthropic_messages/legalize.ts`
- `test/anthropic_messages.test.ts`
- `test/anthropic_messages_stages.test.ts`
- `test/stages.test.ts`
- `e2e/anthropic/*`
- `package.json`, `.gitignore`

Small cross-file check-alignment changes were made only to keep project verification green:
- `src/dialects/openai_realtime/ops.ts`
- `src/dialects/openai_realtime/lower.ts`
- `test/gemini.test.ts`

Known decisions:
- Provider-specific Anthropic fields must not be silently dropped. If core cannot express a block/tool shape, keep it as an Anthropic residual. Required residuals should halt cross-provider translation unless explicitly marked droppable.
- Plain Anthropic `text`, `tool_use`, and string/text `tool_result` blocks still raise to core ops only when no provider-only fields are present.
- `thinking` / `redacted_thinking` blocks are droppable residuals, but must round-trip exactly when returning to Anthropic. `signature` is opaque.
- Anthropic structured output is now native: `llm.output` lowers to `output_config.format`. Adaptive thinking effort merges into the same `output_config`.
- Live e2e is `bun run e2e:anthropic:live`; offline fixture e2e is `bun run e2e:anthropic`.

Checks:
1. Verify raw Anthropic tools with `type` (`web_search_*`, `code_execution_*`) round-trip exactly and do not get converted into lossy `llm.tool` ops.
2. Verify user-defined tool metadata (`strict`, `cache_control`, `allowed_callers`, `eager_input_streaming`) merges back onto the correct tool and does not duplicate tools.
3. Verify thinking signatures survive `fromResponse` / `toResponse` exactly and are not converted into `llm.text`.
4. Verify unknown/provider-rich content blocks (`server_tool_use`, `web_search_tool_result`, `image`, `document`, cited text, multimodal tool results) preserve order and exact JSON.
5. Verify model-gated legalize behavior: Sonnet 5 uses adaptive; Sonnet 4.5 manual budget; `xhigh` rejected for Sonnet 4.6; explicit sampling rejected on new models.
6. Verify `llm.output` + thinking does not overwrite either `output_config.format` or `output_config.effort`.
7. Verify request/response lower paths do not leak response-only residuals into request bodies or vice versa.
8. Verify no silent fallback was added: unsupported cross-provider residuals should halt unless `required:false`.
9. Verify e2e fixtures are valid Anthropic shapes and the live e2e validates a real saved response.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
- Style-only feedback.
- Broad review of unrelated pre-existing dirty files in docs/core/OpenAI Chat/etc.
- Product objections to supporting native Anthropic structured output; review implementation correctness.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Use file:line cites and one-line impact for each finding.
