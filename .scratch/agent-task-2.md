Goal:
Add/read-review-oriented e2e validation coverage for the Anthropic features identified in the research: thinking signatures, provider-specific tool request metadata, and server-tool response blocks. The goal is documentation-grade validation artifacts, not broad clever coverage.

Context:
- Main source changes will happen in `src/dialects/anthropic_messages/*` by the lead. Do not edit those source files unless explicitly asked later.
- Existing e2e files are in `e2e/anthropic.ts`, `e2e/common.ts`, and `e2e/validate.ts`.
- Existing unit tests are in `test/anthropic_messages.test.ts`.
- Current behavior from local read:
  - `anthropic_messages.content_block` already preserves `thinking` and `redacted_thinking` response blocks.
  - request `tools` currently round-trips through `llm.tool` and loses provider fields such as `type`, `strict`, `cache_control`, `allowed_callers`, and `eager_input_streaming`.
  - unknown response content blocks currently fail in `raise.ts`; source change will likely make those residuals.
- Official docs facts to reflect in validations:
  - thinking signatures are opaque and must be passed back unchanged on the same model.
  - server tool responses include `server_tool_use` plus tool-specific result blocks, paired by `tool_use_id`.
  - Anthropic tool version strings such as `web_search_20260318` and `code_execution_20260521` carry behavior and must not be normalized away.

Constraints:
- Own only e2e/test validation files unless asked otherwise.
- Do not add abstractions or new test frameworks.
- Keep outputs readable and artifact-oriented.
- No silent skip for shape mismatches. Missing env for live network may skip live calls if existing e2e convention already does; shape validations must still run.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- Add or adjust validation so an Anthropic response containing a `thinking` block with `signature` round-trips exactly through fromResponse/toResponse.
- Add or adjust validation so a request with raw Anthropic server/user-defined tool metadata retains provider fields in the saved request artifacts.
- Add or adjust validation so a response with `server_tool_use` and a matching result block is preserved through response raise/lower/wire.
- Run the narrow relevant commands you can run without network and record results.

Out of scope:
- Do not implement streaming support.
- Do not implement new media core ops.
- Do not edit Gemini/OpenAI dialects unless a test helper genuinely requires a tiny shared change.

Self-report:
Write `.scratch/agent-notes-2.md` with changed files, decisions made, commands run, and results.
