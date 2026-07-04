Goal:
Implement Anthropic Messages streaming response conversion in the existing dialect pipeline, so concrete Anthropic stream event payloads can raise to core streaming ops and lower from core streaming ops back to Anthropic stream events.

Context:
- Repo root: `/Users/alex/Code/metamodel`.
- Existing Anthropic files:
  - `src/dialects/anthropic_messages/wire.ts`
  - `src/dialects/anthropic_messages/raise.ts`
  - `src/dialects/anthropic_messages/lower.ts`
  - `src/dialects/anthropic_messages/ops.ts`
  - `src/dialects/anthropic_messages/index.ts`
  - tests in `test/anthropic_messages.test.ts` and `test/translate.test.ts`
- Current final response path parses a full message object only. Streaming is currently absent.
- The lead is adding a core stream response translator surface and shared core ops. Your slice should plug into that shape, not invent another public API.
- Expected Anthropic stream examples:
  - `{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }`
  - `{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }`
  - `{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\"" } }`
  - `{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }`
  - `{ type: "message_stop" }`

Constraints:
- Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.
- Do not edit OpenAI or Gemini dialects unless required by a type exported from core.
- No silent fallback. Unsupported Anthropic stream events should throw.
- Partial tool JSON fragments must not be parsed as complete JSON. Preserve them as streaming delta data.
- Keep comments sparse and only explain non-obvious protocol facts.

Verify:
- Anthropic text delta raises and lowers.
- Anthropic tool use start and input JSON delta raise and lower.
- Message stop/usage/stop reason raise and lower.
- Cross-provider translation can convert an Anthropic text delta into the generic stream ops used by other dialects.

Out of scope:
- HTTP/SSE parsing.
- Full response conversion.
- Live network calls.

Self-report:
Write `.scratch/agent-notes-streaming-anthropic.md` with changed files, decisions, commands run, and results.
