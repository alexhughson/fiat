# stripHostOps

If responses are appended to a prompt, the prompt will contain response
specific ops like `response.stop` and `response.usage`, which are invalid.
`stripHostOps` is used to remove those ops when compiling a request body.

`stripHostOps(kind, program)` is in `src/core/pipeline.ts`. `lowerToWire` and
`lowerStreamResponseProgram` call `stripHostOps` first, before the
`beforeLower` hook and before the dialect's lower stages.

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

For a stream response, `lowerStreamResponseProgram` passes kind `"response"` to
`stripHostOps` and kind `"response_stream"` to the dialect's lower stages.
