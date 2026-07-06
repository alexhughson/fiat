# Lower Dialect Ops

Lower dialect ops are provider-endpoint ops inside the shared `Program` stream.
They use namespaces such as `openai_chat.*`, `anthropic_messages.*`, and
`gemini.*`.

Core ops use `llm.*`, `request.*`, `response.*`, and `meta.*`.

## When they are used

| case                  | example                            |
| --------------------- | ---------------------------------- |
| wire grouping         | `openai_chat.message`              |
| provider enum         | `openai_chat.finish_reason`        |
| provider metadata     | `openai_chat.message_meta`         |
| provider config       | `anthropic_messages.output_config` |
| unknown top-level key | `<dialect>.body_field`             |

Direct field renames stay core. Examples: `model`, token caps, temperature,
ordinary function tools, and portable tool choice.

## Residuals

A residual is a lower dialect op that survives `raise` because core IR cannot
represent it.

```ts
[
    { op: "llm.model", model: "gpt-4o" },
    { op: "llm.text", role: "user", content: "hi" },
    { op: "openai_chat.body_field", key: "logit_bias", value: { "1": -100 } },
];
```

Rules:

- lowering back to `openai_chat` serializes `logit_bias` again;
- lowering to another dialect warns and drops it;
- response-only residuals carry `appliesTo: "response"` and are stripped from
  request lowering;
- target-owned unknown ops still throw in `toWire`.

## Lowering example

Core assistant output:

```ts
[
    { op: "llm.text", role: "assistant", content: "checking" },
    {
        op: "llm.tool_call",
        id: "call_1",
        name: "list_invoices",
        arguments: { customer_id: "c_9" },
    },
];
```

OpenAI Chat lowering first creates two message ops, then folds the tool-call
message into the preceding assistant message:

```ts
[
    {
        op: "openai_chat.message",
        message: {
            role: "assistant",
            content: "checking",
            tool_calls: [
                {
                    id: "call_1",
                    type: "function",
                    function: {
                        name: "list_invoices",
                        arguments: '{"customer_id":"c_9"}',
                    },
                },
            ],
        },
    },
];
```

`toWire` then writes that op as the Chat `messages[]` entry.

## Code map

- `src/core/ops.ts`: `CoreOp`, `DialectOp`, `Program`
- `src/core/pipeline.ts`: raise/lower composition and residual cleanup
- `src/dialects/*/ops.ts`: dialect op types
- `src/dialects/*/raise.ts`: dialect ops -> core ops
- `src/dialects/*/lower.ts`: core ops -> dialect ops
- `src/dialects/*/wire.ts`: provider wire parsing/serialization
