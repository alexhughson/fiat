# stripHostOps

`stripHostOps(kind, program)` is in `src/core/pipeline.ts`. `lowerToWire` calls
`stripHostOps` first, before the `beforeLower` hook and before the dialect's
lower stages.

## Example

Input program, lowered with kind `"request"`:

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "meta.trace",
        "traceId": "trace-1"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "hi"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.usage",
        "inputTokens": 8,
        "outputTokens": 2
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "thanks"
    }
]
```

Output program:

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "hi"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "thanks"
    }
]
```

`stripHostOps` removed the `meta.trace` op and the `response.usage` op, so
neither op reaches the request body.

## What the function removes

- Every `meta.*` op, for both kinds.
- For kind `"request"`: every `response.*` op.
- For kind `"response"`: every `request.*` op.
- Every dialect op whose `appliesTo` param names the other kind.

`stripHostOps` keeps every other op, in the same order, and does not warn
about the ops that `stripHostOps` removes. A dialect op without `appliesTo` is
kept, including an op from a dialect other than the target dialect.

A stream response is lowered with kind `"response"`.
