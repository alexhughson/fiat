# Higher and Lower Dialects

The higher dialect is core IR: `llm.*`, `request.*`, `response.*`, and
`meta.*`. Application transforms should usually run here.

Lower dialects are provider endpoint IRs: `openai_chat.*`,
`openai_responses.*`, `anthropic_messages.*`, `gemini.*`, and
`openai_realtime.*`. They preserve provider wire structure and provider-only
data.

## Worked example

OpenAI Chat request:

```ts
{
    model: "gpt-4o",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    logit_bias: { "1": -100 },
}
```

After OpenAI `fromWire`:

```ts
[
    { op: "llm.model", model: "gpt-4o" },
    { op: "llm.max_output_tokens", value: 100 },
    { op: "openai_chat.message", message: { role: "user", content: "hi" } },
    { op: "openai_chat.body_field", key: "logit_bias", value: { "1": -100 } },
];
```

After OpenAI `raise`:

```ts
[
    { op: "llm.model", model: "gpt-4o" },
    { op: "llm.max_output_tokens", value: 100 },
    { op: "llm.text", role: "user", content: "hi" },
    { op: "openai_chat.body_field", key: "logit_bias", value: { "1": -100 } },
];
```

A router can now change the model without touching provider wire shape:

```ts
program.map((op) =>
    op.op === "llm.model"
        ? { op: "llm.model", model: "claude-sonnet-4-6" }
        : op,
);
```

Anthropic `lower` rewrites the core text into an Anthropic message. The OpenAI
residual remains foreign:

```ts
[
    { op: "llm.model", model: "claude-sonnet-4-6" },
    { op: "llm.max_output_tokens", value: 100 },
    {
        op: "anthropic_messages.message",
        message: {
            role: "user",
            content: [{ type: "text", text: "hi" }],
        },
    },
    { op: "openai_chat.body_field", key: "logit_bias", value: { "1": -100 } },
];
```

Foreign residual cleanup logs and drops `openai_chat.body_field`. Anthropic
`toWire` writes:

```ts
{
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
}
```

## Layer rule

Put shared concepts in core IR. Put endpoint-only structure or metadata in a
lower dialect op. If unsupported provider data reaches a foreign target, it
should warn/drop as a residual or throw as target-native invalid state.
