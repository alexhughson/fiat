Change: Adds on-demand e2e validation scripts and artifacts for Anthropic and Gemini, plus Anthropic thinking legalization and thinking-response residual preservation.

Files to review:
- `package.json`
- `e2e/common.ts`
- `e2e/anthropic.ts`
- `e2e/gemini.ts`
- `e2e/validate.ts`
- `e2e/artifacts/*.json` at a sampling level only
- `src/dialects/anthropic_messages/ops.ts`
- `src/dialects/anthropic_messages/legalize.ts`
- `src/dialects/anthropic_messages/raise.ts`
- `src/dialects/anthropic_messages/wire.ts`
- `test/anthropic_messages.test.ts`

Known decisions:
- E2e scripts are not `bun test`; they are run on demand through `bun run e2e`.
- Anthropic model matrix uses `claude-sonnet-5`, `claude-sonnet-4-6`, and `claude-sonnet-4-5-20250929`.
- The new Anthropic high-level op is target-specific: `anthropic_messages.thinking`. It legalizes to adaptive `thinking` + `output_config.effort` for Sonnet 5/4.6 and manual `budget_tokens` for Sonnet 4.5.
- Thinking response blocks are preserved as droppable Anthropic response residuals and round-trip before collected text.
- Multimodal is still unsupported. E2e validates that image input rejects loudly.
- Gemini complex tool-history requests are saved for multiple models; live Gemini uses a simpler text request because real Gemini rejects synthetic prior function-call history without thought signatures.
- Worktree was already very dirty. Do not review unrelated files outside the list above.

Checks:
- Does `anthropic_messages.thinking` legalize before `requestToWire` and never survive to serialization?
- Does the Sonnet model detection choose adaptive/manual formats correctly for the three e2e models?
- Are raw `thinking` / `output_config` conflicts handled loudly?
- Do thinking response residuals round-trip without silently dropping text, usage, stop reason, or response params?
- Could the residual content block preservation reorder any realistic Anthropic response in a misleading way?
- Do e2e validators actually assert the same structural fields as the example tests: envelope, assistant content, stop reason, usage, raised core, round-trip?
- Do live scripts avoid leaking API keys in URLs or thrown errors?
- Are generated artifacts readable and named by provider/model/stage?
- Are there any swallowed errors or silent skips beyond explicit missing-key skips?

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
- Style-only comments.
- Unrelated existing dirty files.
- Adding multimodal support.
- Replacing the current core IR with a provider-neutral thinking model.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Use file:line cites and one-line impact.
