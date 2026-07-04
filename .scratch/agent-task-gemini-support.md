# agent task: gemini feature support pass

Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

You are not alone in the codebase. The worktree is dirty with user and other-agent changes. Do not revert unrelated edits. Adjust to existing files.

Goal: make the Gemini dialect handle real generateContent features that are provider-native and model-dependent, especially thinking signatures in request history.

Evidence from official docs:
- generateContent thought signatures are metadata on parts, including `functionCall` parts.
- Gemini 3 function-calling requires returning the first functionCall thought signature in the current turn; missing it produces 400.
- thinking controls differ by model: Gemini 3/3.5 uses levels; 2.5 Flash/Pro/Flash-Lite support thinking budgets/levels differently. Existing e2e already uses `generationConfig.thinkingConfig` pass-through.

Write scope:
- `src/dialects/gemini/ops.ts`
- `src/dialects/gemini/raise.ts`
- `src/dialects/gemini/lower.ts`
- `src/dialects/gemini/wire.ts`
- `test/gemini.test.ts`
- `test/gemini_stages.test.ts`
- `e2e/gemini/*`
- docs under `docs/dialects/` if needed

Required implementation:
1. Preserve `thoughtSignature` and other Gemini part extras on request history.
   - Current response `gemini.part_meta` is `appliesTo: "response"`, so it is stripped before a response program can be reused as request history.
   - Fix the request-lowering path so a program like:
     user request + Gemini response with functionCall/thoughtSignature + tool_result
     serializes the model functionCall part with the original `thoughtSignature`.
   - Also allow request bodies that already contain model parts with `thoughtSignature` to round-trip instead of throwing "unsupported request-only fields".
   - Do not silently drop metadata. If it cannot be reapplied, fail loudly.

2. Pass through Gemini-native request tools that are not function declarations.
   - Current `toolFromWire` rejects `{ codeExecution: {} }`, `{ googleSearch: {} }`, URL context, etc.
   - Add a Gemini residual op for raw tool objects, and make `requestToWire` emit them alongside core `llm.tool` function declarations.
   - Do not reinterpret built-in tools as core tools.

3. Preserve request-side multimodal/file parts.
   - Current request `inlineData` / `inline_data` / `fileData` parts are not core ops.
   - `fromBody(...).toBody(...)` should round-trip a mixed user content containing text and image/file parts in order.
   - Keep core text where possible; use `gemini.content` residuals for unsupported native parts.

4. Add Gemini structured output lowering if the existing core `llm.output` has a direct Gemini generateContent mapping.
   - Expected wire mapping: `generationConfig.responseMimeType = "application/json"` and `generationConfig.responseSchema = schema`.
   - If there is a conflict with existing `generationConfig.responseMimeType` or `responseSchema`, throw.

5. Update e2e documentation/validation.
   - Add a visible scenario or validator for thinking-signature chaining. It can be a deterministic serializer validation if live signature availability is flaky, but the output must read like documentation and save traceable artifacts.
   - Keep live e2e model validation on demand. Do not make it part of unit tests.

Tests to add/update:
- Unit test: response functionCall with `thoughtSignature` appended to next request lowers with the signature intact.
- Unit test: request body with model functionCall `thoughtSignature` round-trips.
- Unit test: built-in tool object round-trips.
- Unit test: mixed text + inlineData/fileData request content round-trips in original order.
- Unit test: `llm.output` lowers to Gemini structured output config and conflicts fail loudly.
- Stage tests for any new stage.

Finish with:
- List changed files.
- List commands run and results.
- Note any unresolved risk, especially metadata index brittleness.
