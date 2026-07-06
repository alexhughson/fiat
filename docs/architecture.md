# Architecture

Fiat has one shared core IR and one lower dialect per provider endpoint.
Every stage reads and writes the same type: `Program`, a flat `Op[]`.

```text
source wire
  -> source fromWire
  -> source raise
  -> core program
  -> caller transforms
  -> target lower
  -> target legalizations
  -> foreign residual cleanup
  -> target toWire
  -> target wire
```

## Programs are mixed

A program may contain core ops and lower dialect ops at the same time:

```ts
[
    { op: "llm.model", model: "gpt-4o" },
    { op: "llm.text", role: "user", content: "hi" },
    { op: "openai_chat.body_field", key: "logit_bias", value: { "1": -100 } },
];
```

Core namespaces:

- `llm.*`
- `request.*`
- `response.*`
- `meta.*`

Provider dialect namespaces:

- `openai_chat.*`
- `openai_responses.*`
- `anthropic_messages.*`
- `gemini.*`
- `openai_realtime.*`

`fromWire` emits core ops directly for one-to-one fields such as `model`,
`temperature`, token caps, ordinary tools, and tool choice. It emits dialect
ops for provider structure or provider-only data.

## Residuals

A residual is a dialect op left in a raised program because core IR has no
portable representation for it.

Rules:

- home target: serialize it back exactly;
- foreign target: warn and drop it before `toWire`;
- wrong direction: strip it when `appliesTo` does not match request/response;
- target-owned unknown op: throw in `toWire`.

Example: OpenAI `logit_bias` raises as `openai_chat.body_field`. It
round-trips back to OpenAI, but is warned and dropped when lowering to
Anthropic.

## Legalizations

Legalizations run after `lower` and `afterLower`, before foreign residual
cleanup and `toWire`.

Use them for endpoint conformance:

- insert Anthropic `max_tokens` when absent;
- remove or reject sampling params for models that do not accept them;
- map portable thinking effort onto a model-specific wire shape.

With `{ strict: true }`, unsupported caller intent should throw instead of
being cleaned up.

## Failure posture

The pipeline should not hide data loss.

- malformed wire input throws;
- unparseable tool-call JSON throws;
- unmapped provider enums throw;
- unrepresentable target-native ops throw;
- foreign residual drops log a warning.
