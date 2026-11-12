# stripHostOps

Without `stripHostOps`, fiat returns no request body for a program that holds
a `meta.trace` op or a `response.usage` op: the lowering throws
`no serialization for op "meta.trace"` or
`no serialization for op "response.usage"`. When a program holds the ops
of an Anthropic response, `stripHostOps` removes the ops for the response's
`id`, `type`, and `stop_sequence` fields; if those ops stayed in the program,
fiat would write the three fields into the Anthropic request body.

`stripHostOps(kind, program)` is in `src/core/pipeline.ts`. `lowerToWire` calls
`stripHostOps` first, before the `beforeLower` hook and before the dialect's
lower stages.

## Example

`stripHostOps` called with kind `"request"`:

**In**

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

**Out**

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
