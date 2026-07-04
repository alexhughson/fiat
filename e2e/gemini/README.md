# Gemini e2e

These scripts are live validations, not unit tests. They call Gemini
`generateContent`, save the request body, the raw API response body, the
translator response body, the raised core response, and response round-trip,
then validate the saved files against the same Gemini example shapes imported
by `test/dialects/gemini/gemini.test.ts`.

```sh
bun run e2e:gemini
bun run e2e:gemini:validate
```

Defaults:

- `models/gemini-3.5-flash`
- `models/gemini-2.5-flash`
- `models/gemini-2.5-pro`

Override the model list when you need a smaller or different run:

```sh
bun run e2e:gemini -- --models=models/gemini-2.5-flash,models/gemini-3.5-flash
```

Artifacts are written to `e2e/gemini/output/latest/` by default. The
`multimodal-tool` scenario uses a `gemini.content` residual for the inline
image part because core IR does not yet have an image/file op; the validation
proves the request still lowers into the Gemini wire shape and reaches the
live API.

For tool-call responses, each artifact also saves a `chainedRequestBody`: the
original request program, the live Gemini response program, and a synthetic
tool result lowered back to Gemini. When the live response includes
`thoughtSignature` on the `functionCall` part, the validator confirms the
chained request sends that exact signature back in model history.
