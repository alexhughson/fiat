Goal:
Implement Gemini streaming response conversion in the existing dialect pipeline, so concrete Gemini stream response payloads can raise to core streaming ops and lower from core streaming ops back to Gemini stream chunks.

Context:
- Repo root: `/Users/alex/Code/metamodel`.
- Existing Gemini files:
  - `src/dialects/gemini/wire.ts`
  - `src/dialects/gemini/raise.ts`
  - `src/dialects/gemini/lower.ts`
  - `src/dialects/gemini/ops.ts`
  - `src/dialects/gemini/index.ts`
  - tests in `test/gemini.test.ts` and `test/translate.test.ts`
- Current final response path parses `candidates`. Streaming is currently absent.
- Gemini stream chunks look like partial GenerateContent responses, for example:
  - `{ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] }`
  - `{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { x: "1" } } }] }, finishReason: "STOP" }] }`
  - `{ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }`

Constraints:
- Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.
- Do not edit OpenAI or Anthropic dialects unless required by a type exported from core.
- No silent fallback. Unsupported stream candidate shapes should throw consistently with current final response behavior.
- Gemini function call chunks generally carry complete args objects; do not invent partial JSON behavior for Gemini.
- Keep comments sparse and only explain non-obvious protocol facts.

Verify:
- Gemini text stream chunk raises and lowers.
- Gemini functionCall stream chunk raises and lowers.
- Gemini finishReason and usageMetadata raise and lower.
- Cross-provider translation can convert a Gemini text chunk into the generic stream ops used by other dialects.

Out of scope:
- HTTP/SSE parsing.
- Full response conversion.
- Live network calls.

Self-report:
Write `.scratch/agent-notes-streaming-gemini.md` with changed files, decisions, commands run, and results.
