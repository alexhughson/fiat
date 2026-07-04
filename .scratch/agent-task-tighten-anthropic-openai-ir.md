Goal:
Tighten the Anthropic -> OpenAI Chat real-usage support so shared request concepts are carried by core IR, not by `openai_chat` lowering Anthropic residuals. The current behavior works but violates the library principle: if it must cross backends, it belongs in core IR.

Context:
- Current source-specific workaround lives in `src/dialects/openai_chat/lower.ts` as `lowerAnthropicRequestResiduals`, registered first in `lowerRequestStages`.
- Real Claude Code fixture is `test/fixtures/claude_code_anthropic.ts`.
- Direct documentation test is in `test/translate.test.ts`: "a real-shaped Claude Code Anthropic request lowers to OpenAI Chat through the library".
- Current `CoreOp` is in `src/core/ops.ts`; core namespaces are in `CORE_NAMESPACES`.
- Anthropic request raise is in `src/dialects/anthropic_messages/raise.ts`; request wire parsing/serialization is in `src/dialects/anthropic_messages/wire.ts`.
- OpenAI Chat wire parsing/serialization is in `src/dialects/openai_chat/wire.ts`.

Required design:
- Add core IR ops for shared request concepts:
  - request user attribution: suggested `request.user { value: string }`.
  - request streaming intent: suggested `request.stream { value: boolean }`.
  - general thinking/reasoning effort: suggested `llm.thinking { effort: "low" | "medium" | "high" | "xhigh" | "max" }`.
- Anthropic `output_config.effort` should raise to general thinking effort.
- Anthropic `thinking:{type:"adaptive",display:"omitted"}` should be preserved for Anthropic, but generally map through the effort op when paired with `output_config.effort`.
- Anthropic `thinking:{type:"disabled"}` is non-semantic for cross-provider translation and can remain an Anthropic residual marked droppable; it must still round-trip to Anthropic.
- Anthropic `metadata.user_id` should raise to `request.user`; unsupported metadata fields should remain required residuals and fail cross-provider.
- Anthropic `stream` should raise to `request.stream`.
- Anthropic `output_config.format` should keep raising to `llm.output`.
- OpenAI Chat should serialize `request.user`, `request.stream`, and `llm.thinking` to `user`, `stream`, and `reasoning_effort`. It should parse those fields back to core.
- Anthropic should serialize `request.stream` back to `stream`.
- Anthropic should serialize `llm.thinking` to adaptive thinking + `output_config.effort` when targeting Anthropic. Preserve raw Anthropic thinking residuals when present for home round-trip and avoid conflicts.
- Remove or shrink `lowerAnthropicRequestResiduals`. OpenAI Chat lower should not translate Anthropic `metadata`, `thinking`, `output_config`, or `stream` residuals directly. At most, keep explicit non-semantic cleanup for cache-control text/system/tool metadata if needed, but prefer raising semantic text to core earlier.
- `cache_control:{type:"ephemeral"}` is provider cache metadata, not core. Do not turn it into OpenAI params. Semantic text must still become `llm.text`; cache metadata may be preserved for Anthropic or explicitly droppable cross-provider.
- `context_management.clear_thinking_20251015 keep:all` is Anthropic state housekeeping. It may remain a droppable Anthropic residual for cross-provider translation. Unknown edits must remain required and fail.

Constraints:
- Keep the change minimal and inside ownership boundaries.
- No broad "drop Anthropic params" fallback.
- Unknown or semantically meaningful provider-only fields must still fail cross-provider.
- Do not touch unrelated dirty files except if an existing stale test expectation blocks full project verification.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- Unit/stage tests show the real Claude Code request translates via core ops, not OpenAI lowering Anthropic residuals.
- Unsupported thinking display summarized and unsupported context_management still fail.
- Malformed/unsupported effort still fails.
- Anthropic home round-trip for adaptive thinking and/or disabled thinking remains sane.
- Run targeted tests and typecheck; main agent will run full suite and live proxy smoke.

Out of scope:
- General streaming response redesign.
- Manual Anthropic budget thinking as portable core; keep it Anthropic-specific.
- New provider docs or broad refactors.

Self-report:
Write `.scratch/agent-notes-tighten-anthropic-openai-ir.md` with files changed, decisions, commands run, and results.
