Goal:
Add on-demand Gemini e2e validations that read like executable documentation:
- lower real metamodel programs to Gemini generateContent wire payloads
- call the live Gemini API with the `.env` `GEMINI_API_KEY`
- save readable request/response/core artifacts for several Gemini models
- validate saved response shapes against Gemini example fixtures used by the unit tests
- include a complex mixed core/Gemini-IR request with tools plus a multimodal part
- prove Gemini 2.5 thinking budgets survive the request lowering path

Context:
- Repo root: `/Users/alex/Code/metamodel`.
- Baseline before this task:
  - `bun test` passed 160 tests, including existing live Gemini text and forced tool-call calls.
  - `bunx tsc --noEmit` passed.
- Existing public Gemini surface:
  - `src/dialects/gemini/index.ts` exports `GeminiTranslator`.
  - `src/core/pipeline.ts` runs lower -> legalizations -> residual lint -> toWire.
  - No Gemini legalization pass is registered today. `generationConfig.thinkingConfig` currently survives via required `gemini.body_field` residuals and `mergeBodyRecord` in `src/dialects/gemini/wire.ts`.
  - `src/dialects/gemini/lower.ts` passes existing `gemini.content` ops through and merges adjacent same-role content. That is the current way to include request-side multimodal parts, because core IR has no image/file op.
- Existing Gemini examples:
  - `test/gemini.test.ts` has a request fixture with text/system/tools/tool choice/function responses and a response fixture with `candidates`, `usageMetadata`, and residual response metadata.
  - Extract those examples to a fixture module only if it keeps the e2e validator tied to the actual tests without adding runtime coupling to `bun:test`.
- Official generateContent facts checked:
  - Endpoint is `POST https://generativelanguage.googleapis.com/v1beta/{model=models/*}:generateContent`.
  - Request uses `contents[].parts`, tools/function declarations, tool config, generation config.
  - Response uses `candidates[]`, `usageMetadata`, `modelVersion`, `responseId`.
  - `ThinkingConfig` has `thinkingBudget`; docs say `thinkingLevel` is recommended for Gemini 3+ and errors on earlier models, so use `thinkingBudget` for Gemini 2.5 validation.

Constraints:
- Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.
- Write scope:
  - `e2e/gemini/**`
  - `test/fixtures/**`
  - `test/gemini.test.ts` only for fixture extraction
  - `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `docs/dialects/gemini.md` only for scripts/docs/output ignores
- Do not change production translator behavior unless a live run proves the current path cannot express the requested e2e. If you think production code must change, stop and write the exact failing input and error in `.scratch/agent-notes-3.md`.
- Do not add fallback-heavy code. Missing API key, unavailable requested model, invalid transform, invalid response shape, or failed API call should halt with a specific error.
- Do not print or save the API key.
- Keep generated live outputs under an ignored path such as `e2e/gemini/output/`.
- Keep comments sparse. A comment explaining why request-side image input uses a `gemini.content` residual is useful; comments explaining ordinary loops or JSON writes are not.

Implementation shape:
- Add `bun run e2e:gemini` for the live run.
- Add `bun run e2e:gemini:validate` for offline validation of saved artifacts.
- Default models should include multiple Gemini models and specifically `models/gemini-2.5-flash`; include the current baseline model `models/gemini-3.5-flash`. A third useful default is `models/gemini-2.5-pro`.
- Let `--models=a,b,c` override the model list. This is a CLI input, not an env-var behavior knob.
- The runner should:
  - check `GEMINI_API_KEY`
  - optionally list models and fail if any requested model is unavailable for `generateContent`
  - for each model, run a simple text scenario and save the request body, response body, and raised response program
  - for each model, run a complex scenario with:
    - system text
    - max output tokens
    - tool declaration
    - forced tool choice
    - user text
    - an inline image/file part via `gemini.content`
  - for Gemini 2.5 models, include `generationConfig.thinkingConfig.thinkingBudget` and assert it is present in the lowered request body before the API call
  - validate live responses immediately and write a manifest.
- The validator should read saved artifacts and assert:
  - text responses match the stable shape of the Gemini text response fixture from unit tests
  - complex responses match the stable shape of the Gemini function-call response fixture from unit tests
  - `GeminiTranslator.fromResponse` can raise the response
  - `GeminiTranslator.toResponse` can serialize the raised response back to the same wire shape
  - tool-call responses raise to `llm.tool_call` with the forced tool name
  - usage counts are present when the scenario expects a normal response

Out of scope:
- No streaming e2e.
- No image-generation response handling.
- No general schema-validation dependency.
- No broad refactor of tests/docs.
- No changes to OpenAI or Anthropic behavior.

Verify:
- Run `bunx tsc --noEmit`.
- Run `bun test`.
- Run `bun run e2e:gemini` with the real `.env` key.
- Run `bun run e2e:gemini:validate`.
- If the live e2e fails because a requested model is unavailable or rejects the request, record the exact model, scenario, status, and response body in `.scratch/agent-notes-3.md`; do not hide it behind a skip.

Self-report:
Write `.scratch/agent-notes-3.md` with changed files, decisions made, commands run, results, and any live API failures.
