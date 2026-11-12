# stripHostOps

If responses are appended to a prompt, the prompt will contain response
specific ops like `response.stop` and `response.usage`, which are invalid.
`stripHostOps` is used to remove those ops when compiling a request body.

The prompt is the request program shown below.

`stripHostOps(kind, program)` is in `src/core/pipeline.ts`. `lowerToWire` and
`lowerStreamResponseProgram` call `stripHostOps` first, before the
`beforeLower` hook and before the dialect's lower stages.

## Example

`stripHostOps` called with kind `"request"`:

**In**: the whole request program that `lowerToWire` passes to `stripHostOps`. The program comes from a run and holds, in this order: the ops that `AnthropicTranslator.fromBody` returns for a request body, one `meta.trace` op, the ops that `AnthropicTranslator.fromResponse` returns for a response body, and one `llm.text` op for the next user message. Both bodies are reduced fixtures in the shape of Anthropic's API, not bodies recorded from the API.

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "llm.max_output_tokens",
        "value": 100
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "hi"
    },
    {
        "op": "meta.trace",
        "traceId": "trace-1"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "id",
        "value": "msg_1",
        "appliesTo": "response"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "type",
        "value": "message",
        "appliesTo": "response"
    },
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "stop_sequence",
        "value": null,
        "appliesTo": "response"
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

**Out**: the whole request program that `stripHostOps` returns and that `lowerToWire` passes to the `beforeLower` hook.

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "llm.max_output_tokens",
        "value": 100
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
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "thanks"
    }
]
```

`stripHostOps` removed the `meta.trace` op, the `response.stop` op, the `response.usage` op, and the three `anthropic_messages.body_field` ops whose `appliesTo` param is `"response"`, so none of those ops reaches the request body.

## What the function removes

- Every `meta.*` op, for both kinds.
- For kind `"request"`: every `response.*` op.
- For kind `"response"`: every `request.*` op.
- Every dialect op whose `appliesTo` param names the other kind.

`stripHostOps` keeps every other op, in the same order, and does not warn
about the ops that `stripHostOps` removes. A dialect op without `appliesTo` is
kept, including an op from a dialect other than the target dialect. A later step of `lowerToWire`, `dropForeignResiduals`, removes that op from another dialect with a warning, or throws when the op has `preservesContent: true`, so the op does not reach the body.

For a stream response, `lowerStreamResponseProgram` passes kind `"response"` to
`stripHostOps` and kind `"response_stream"` to the dialect's lower stages.
