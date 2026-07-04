# expunge registry pattern

## changed files

- `src/core/translator.ts`
- `src/core/pipeline.ts`
- `src/core/registry.ts`
- `src/dialects/*/index.ts`
- `examples/anthropic-openai-proxy.ts`
- `e2e/openai_realtime/shared.ts`
- `test/translate.test.ts`
- `test/live.test.ts`
- `test/gemini.test.ts`
- `test/openai_realtime.test.ts`
- `test/streaming.test.ts`
- `README.md`
- `docs/dialects.md`
- `docs/adding-features.md`

## decisions

- Removed global dialect registration and lookup. `registry.ts` now only owns the `Dialect` and `Codec` contracts.
- Made `Translator` a class that wraps a concrete `Dialect` object and calls the real codec functions through `raiseFromWire` / `lowerToWire`.
- Changed `translateRequest`, `translateResponse`, and `translateStreamResponse` to accept dialect or translator objects, not string names.
- Kept dialect namespace strings for op names and `Target.dialect`; those are data labels used by passes and residual linting.
- Updated the Anthropic proxy, e2e helpers, tests, README, and dialect docs to compose translator wrappers directly.

## commands run

- `rg -n "registerDialect|getDialect|from: \"|to: \"|makeTranslator\\(DIALECT\\)|makeTranslator\\(\"|typeof dialect === \"string\"|dialectName =" src test e2e examples README.md docs --glob '!examples/output/**'`
- `bunx tsc --noEmit`
- `bun test test/translate.test.ts test/openai_chat.test.ts test/anthropic_messages.test.ts examples/anthropic-openai-proxy-smoke.ts`
- `bun test`
- `bun run example:anthropic-openai-proxy:smoke`

## results

- No source/docs examples use `registerDialect`, `getDialect`, or string `from`/`to` conversion options outside generated output.
- `bunx tsc --noEmit` passed.
- Focused translator/proxy tests passed: `83 pass, 0 fail`.
- Full suite passed, including live provider tests: `261 pass, 0 fail`.
- Proxy smoke passed through the wrapper-based example backed by `gpt-5.5`: raw response text `proxy-ok`, Claude Code exit `0`.
