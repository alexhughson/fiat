# OpenAI Realtime e2e

These scripts validate the realtime dialect against saved artifacts and, when
`OPENAI_API_KEY` is present, against the live Realtime websocket event path.

```sh
bun run e2e:openai-realtime
bun run e2e:openai-realtime:validate
```

Defaults:

- `gpt-realtime-2`
- `text` and forced `tool` scenarios
- artifacts in `e2e/openai_realtime/output/latest/`
- offline validation fixtures in `e2e/openai_realtime/fixtures/`

Override models or validation directory:

```sh
bun run e2e:openai-realtime -- --models=gpt-realtime-2
bun run e2e:openai-realtime:validate -- --dir=e2e/openai_realtime/output/latest
```

The text scenario starts from an OpenAI Chat-shaped request, translates it to a
Realtime request body, sends its events, saves the final `response.done`, raises
that response to core IR, round-trips it back to Realtime, and translates it to
OpenAI Chat. The tool scenario does the same with a forced function tool call.
