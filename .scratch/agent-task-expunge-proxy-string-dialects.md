Goal: Refactor `examples/anthropic-openai-proxy.ts` so request/response conversion uses the public translator wrappers/classes (`AnthropicTranslator`, `OpenAIChatTranslator`) instead of direct string dialect calls like `raiseFromWire("...", "...")` / `lowerToWire("...", "...")`. This matters because examples should document the stable wrapper API, not fragile string-named lookup plumbing.

Context:
- `examples/openai-realtime-chat-server.ts` already shows the desired shape:
  - `OpenAIChatTranslator.fromBody(body)`
  - `OpenAIRealtimeTranslator.toBody(program)`
  - response path mirrors it with `.fromResponse()` / `.toResponse()`
- `examples/anthropic-openai-proxy.ts` currently imports `lowerToWire`, `raiseFromWire`, and calls:
  - `raiseFromWire("request", "anthropic_messages", body)`
  - `lowerToWire("request", "openai_chat", core)`
  - `raiseFromWire("response", "openai_chat", body)`
  - `lowerToWire("response", "anthropic_messages", core)`
- The proxy still needs its existing policy passes and trace output.
- There is a very dirty worktree from prior work. Do not revert or clean unrelated files.

Constraints:
- Replace the string-dialect conversion calls in the proxy with explicit wrapper calls.
- Do not add a new registry, handler map, adapter map, or string-dispatch facade.
- Do not remove the core registry from the library unless you can prove all internal callers/tests can move without broad churn. The user’s complaint is about the example/proxy pattern.
- Keep behavior the same: Anthropic request in, OpenAI chat request out, OpenAI chat response in, Anthropic response out.
- Keep errors loud. No silent fallbacks.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- Typecheck should pass.
- Existing tests should pass or any failure must be clearly pre-existing.
- Add or update a focused test only if it gives concrete documentation that the proxy/wrapper chain works.
- Search should show no direct `raiseFromWire`/`lowerToWire` use in `examples/anthropic-openai-proxy.ts`.

Out of scope:
- Do not redesign the translator API.
- Do not change provider wire semantics.
- Do not edit generated trace output.
- Do not touch `../dapat`.

Self-report:
Write `.scratch/agent-notes-expunge-proxy-string-dialects.md` with changed files, decisions made, commands run, and results.
