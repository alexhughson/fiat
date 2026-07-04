# expunge proxy string dialects

## changed files

- `examples/anthropic-openai-proxy.ts`
- `.scratch/agent-notes-expunge-proxy-string-dialects.md`

## decisions

- Replaced direct `raiseFromWire` / `lowerToWire` calls in the proxy example with the public translator wrappers:
  - `AnthropicTranslator.fromBody(body)`
  - `OpenAIChatTranslator.toBody(program)`
  - `OpenAIChatTranslator.fromResponse(body)`
  - `AnthropicTranslator.toResponse(program)`
- Kept the existing proxy policy passes and trace step names unchanged.
- Left the core registry and root exports alone. They are still used by the library API and tests; the brief only required removing the fragile string-dialect pattern from this example.
- Did not add another registry, handler map, adapter map, or string-dispatch facade.

## commands run

- `sed -n '1,240p' .scratch/agent-task-expunge-proxy-string-dialects.md`
- `sed -n '1,260p' examples/anthropic-openai-proxy.ts`
- `sed -n '1,220p' examples/openai-realtime-chat-server.ts`
- `rg "class .*Translator|fromBody|toBody|fromResponse|toResponse|raiseFromWire|lowerToWire" src examples test README.md`
- `sed -n '1,220p' src/core/translator.ts`
- `sed -n '1,220p' src/index.ts`
- `git status --short`
- `rg "raiseFromWire|lowerToWire" examples/anthropic-openai-proxy.ts`
- `bunx tsc --noEmit`
- `bun test`
- `bun test test/translate.test.ts test/openai_chat.test.ts test/anthropic_messages.test.ts`
- `git diff -- examples/anthropic-openai-proxy.ts .scratch/agent-notes-expunge-proxy-string-dialects.md`
- `rg "raiseFromWire|lowerToWire|getDialect|registerDialect|translateRequest|translateResponse|translateStreamResponse" examples README.md docs -g '!examples/output/**'`
- `git status --short examples .scratch/agent-notes-expunge-proxy-string-dialects.md`

## results

- Implementation is complete.
- `rg "raiseFromWire|lowerToWire" examples/anthropic-openai-proxy.ts` returned no matches.
- `bunx tsc --noEmit` passed.
- Targeted translator/proxy-relevant tests passed: `83 pass, 0 fail`.
- Full `bun test` did not pass: `241 pass, 7 fail`.
  - The failures are in Gemini tests/live paths and assert the current `gemini.generation_config` behavior against older `gemini.body_field` expectations.
  - No failure points at `examples/anthropic-openai-proxy.ts`, Anthropic translation, OpenAI Chat translation, or the Anthropic-to-OpenAI proxy conversion tests.
- The examples scan found no string-dialect pipeline calls in examples outside generated output. README/docs still mention `translateRequest`, `registerDialect`, and pipeline internals where they document the library API/extension mechanism.
- `examples/` and this note are untracked in the current dirty worktree, so `git diff` does not show file content for them.
