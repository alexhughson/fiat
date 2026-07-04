Goal: Add an on-demand e2e validation section for provider translation, with readable saved artifacts, without converting it into normal test files.

Context:
- Repo root: `/Users/alex/Code/metamodel`.
- Existing live tests are in `test/live.test.ts`; they prove API smoke paths but do not save trace artifacts and are part of `bun test`.
- Public API is exported from `src/index.ts`.
- Anthropic request lowering path:
  - `src/dialects/anthropic_messages/lower.ts`
  - `src/dialects/anthropic_messages/legalize.ts`
  - `src/dialects/anthropic_messages/wire.ts`
- Gemini request lowering path:
  - `src/dialects/gemini/lower.ts`
  - `src/dialects/gemini/wire.ts`
- Existing example payload shapes live in:
  - `test/anthropic_messages.test.ts`
  - `test/gemini.test.ts`
- Important fact: current docs say multimodal/images and thinking are out of scope (`README.md`, `docs/dialects/anthropic_messages.md`, `docs/dialects/gemini.md`). Do not pretend those translate through core unless the code already supports them.
- The worktree is already dirty. Do not revert unrelated changes.

Requested implementation:
- Create a new `e2e/` section, not `test/`.
- Add one or more Bun scripts that:
  1. Build anthropic request bodies from core IR for several models, including Sonnet variants if configured, and save request bodies plus live responses under an artifact directory.
  2. Validate saved anthropic responses have the same structural shape as the example response payloads in `test/anthropic_messages.test.ts`: message envelope, assistant content blocks, stop reason, usage token counts, and raise/toResponse round-trip where supported.
  3. Build a complex core IR request with system text, user text, assistant tool call, tool result, tools, forced/auto tool choice, and provider-specific Gemini thinkingConfig residual; lower it to multiple Gemini model bodies and save the bodies. If `GEMINI_API_KEY` is present, call live Gemini for at least one configured model and save/validate the response shape. If no key, print a clear skip.
  4. Include a clear e2e check for unsupported multimodal input. It should prove the current behavior loudly rejects or preserves unsupported provider-specific fields rather than dropping them silently. Do not add image support.
  5. Save artifacts as pretty JSON with filenames that identify provider, model, and request/response/core stages.
- Add package scripts, e.g. `e2e:anthropic`, `e2e:gemini`, `e2e`, and `e2e:validate` if useful.
- Keep code readable as executable documentation. Avoid clever abstractions. One obvious path.

Constraints:
- Use `.env` keys via Bun environment loading. Do not print secrets.
- No swallowed errors. If a live API call fails, throw with status and body.
- No broad changes to core translators unless absolutely necessary. If you find a required legalize change, note it in `.scratch/agent-notes-1.md` instead of editing core; the lead will decide.
- Do not use network package installs.
- Use only files under `e2e/`, `package.json`, and `.scratch/agent-notes-1.md` unless you can justify otherwise in notes.
- Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- `bun test`
- `bunx tsc --noEmit`
- `bun run e2e:validate` or equivalent non-live shape validation
- If keys are available, run the live e2e scripts and save artifacts.

Out of scope:
- Do not add streaming support.
- Do not add image/multimodal support.
- Do not add a generic e2e framework.
- Do not change unrelated docs.

Self-report:
- Write `.scratch/agent-notes-1.md` with changed files, decisions made, commands run, results, and any core/legalize gaps you found.
