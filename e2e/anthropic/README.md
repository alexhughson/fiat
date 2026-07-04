# Anthropic e2e fixtures

These fixtures are offline validation artifacts for Anthropic Messages wire
shapes that are easy to lose when they pass through core IR:

- `thinking-signature-response` checks that a `thinking` block and its opaque
  `signature` pass through `fromResponse` and `toResponse` unchanged.
- `provider-tool-metadata-request` checks that server tool version strings
  such as `web_search_20260318` and `code_execution_20260521`, plus custom
  tool metadata such as `strict`, `cache_control`, `allowed_callers`, and
  `eager_input_streaming`, survive request round-trip.
- `server-tool-response` checks that `server_tool_use` and the matching
  `web_search_tool_result` stay paired by `tool_use_id`.

Run the offline validator:

```sh
bun e2e/anthropic/validate.ts
```

The validator exits nonzero on any missing field, unsupported block, or
round-trip mismatch. It does not call the Anthropic API.

Run the live thinking-signature validator:

```sh
bun e2e/anthropic/run.ts
```

The live run requires `ANTHROPIC_API_KEY`, calls the Messages API, saves the
response under `e2e/anthropic/output`, and validates that the real `thinking`
block signature survives `fromResponse` / `toResponse` unchanged.
