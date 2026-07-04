Change:
Adds response-stream conversion to every built-in dialect. Public API now includes `fromStreamResponse`, `toStreamResponse`, and `translateStreamResponse`. Built-ins register `responseStream` codecs. Stream chunks raise to generic `response.text_delta` / `response.tool_call_delta` plus existing `response.stop` / `response.usage`, with provider residuals preserving home round-trip fields.

Known decisions:
- This is payload conversion only. HTTP/SSE/WebSocket transport is out of scope.
- Partial tool-call arguments stay strings in `response.tool_call_delta.arguments`; only final full responses parse tool-call JSON.
- `responseStream` remains optional in the registry type so external dialects do not break at compile time, but `translateStreamResponse` throws if a dialect does not implement it.
- Realtime full `fromResponse` still rejects detail/delta events; stream events go through `fromStreamResponse`.

Checks:
1. every built-in dialect (`openai_chat`, `openai_responses`, `openai_realtime`, `anthropic_messages`, `gemini`) registers a `responseStream` codec.
2. no stream converter silently drops provider fields needed for home round-trip, especially chunk ids/indexes/logprobs, terminal response status, usage, and realtime event metadata.
3. partial JSON fragments are never parsed as JSON.
4. terminal events produce correct generic `response.stop` and `response.usage`, and lower back to the provider shape.
5. foreign residual lint still blocks required provider-only stream data and drops only `required:false` residuals.
6. stream response lowering does not use final-response collection stages that would synthesize complete assistant messages.
7. public exports are complete and names are consistent.
8. tests cover concrete provider chunk payloads, not only core-program synthesis.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
Style-only comments, unrelated dirty worktree files, live transport tests, and changing request streaming behavior.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Use file:line cites and one-line impact.
