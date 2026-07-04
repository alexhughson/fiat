Goal: Replace the global string-keyed dialect registration/lookup workflow with concrete translator objects that hold their codec functions. The public examples and tests should compose `AnthropicTranslator`, `OpenAIChatTranslator`, etc. directly instead of passing string dialect names.

Context:
- The user explicitly rejected "register handlers and look them up by a string name".
- Current structural pattern:
  - each `src/dialects/*/index.ts` imports `registerDialect`, calls `registerDialect({ name: DIALECT, ... })`, then exports `makeTranslator(DIALECT)`.
  - `src/core/pipeline.ts` accepts `from`/`to` strings and calls `getDialect(name)`.
  - `examples/anthropic-openai-proxy.ts` is already refactored to wrapper calls, but the core still has the registration pattern.
- Desired shape:
  - concrete translator instances/classes wrap the actual dialect functions.
  - callers pass wrappers/classes, e.g. `{ from: OpenAIChatTranslator, to: AnthropicTranslator }`, or call `OpenAIChatTranslator.fromBody(...)`.
  - no handler map registration or string lookup on the conversion path.

Constraints:
- Keep the existing dialect contract and pipeline semantics.
- Do not silently drop residuals or weaken lints.
- Dialect namespace strings such as `"openai_chat"` are still valid op namespaces and target labels; do not invent symbol namespaces.
- Keep the change centralized in core translator/pipeline and dialect indexes; avoid touching provider wire modules.
- Do not edit generated trace output.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- Search must show no `registerDialect` / `getDialect` usage in the source conversion path.
- Examples should not pass string dialect names.
- Typecheck passes.
- Focused translator tests pass.
- Full tests pass, or failures are proven pre-existing and unrelated.

Out of scope:
- Do not redesign provider ops, raise/lower stages, legalizations, or the proxy transport.
- Do not touch `../dapat`.

Self-report:
Write `.scratch/agent-notes-expunge-registry-pattern.md` with findings, changed files, commands run, and results.
