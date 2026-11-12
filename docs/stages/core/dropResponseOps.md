# dropResponseOps

If responses are appended to a prompt, the prompt will contain response specific
ops like `response.stop` and `response.usage`, which are invalid.
`dropResponseOps` is used to remove those ops when compiling a request body.

```ts
function dropResponseOps(program: Program): Program;
```

`Program` is the type `Op[]`, declared in `src/core/ops.ts`.

The prompt is the request program shown below.

`dropResponseOps(program)` is in `src/core/pipeline.ts`. When `lowerToWire`
compiles a request body, it calls `dropResponseOps` after `dropMetaOps`, before
the `beforeLower` hook and before the dialect's lower stages.

## Example

**In**: the whole request program that `dropMetaOps` returns and that
`lowerToWire` passes to `dropResponseOps`. The program comes from a run and
holds, in this order: the ops that `AnthropicTranslator.fromBody` returns for a
request body that a client sends to Anthropic's API, the ops that
`AnthropicTranslator.fromResponse` returns for the response body that
Anthropic's API returns to that client, and one `llm.text` op for the next user
message. Each body is a whole body, and each is a reduced fixture in the shape
of Anthropic's API, not a body recorded from the API.

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
        "op": "response.id",
        "id": "msg_1"
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

**Out**: the whole request program that `dropResponseOps` returns and that
`lowerToWire` passes to the `beforeLower` hook.

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

`dropResponseOps` removed the `response.id` op, the `response.stop` op, the
`response.usage` op, and the two `anthropic_messages.body_field` ops whose
`appliesTo` param is `"response"`, so none of those ops reaches the request
body.

## What the function removes

- Every `response.*` op.
- Every dialect op whose `appliesTo` param is `"response"`.

`dropResponseOps` keeps every other op, in the same order, and does not warn
about the ops that `dropResponseOps` removes. A dialect op without `appliesTo`
is kept, including an op from a dialect other than the target dialect. A later
step, `dropForeignResiduals`, removes an op that belongs to another dialect and
warns. When that op has the param `preservesContent: true`,
`dropForeignResiduals` throws instead. A raise step sets that param on some ops
that hold message content, such as the op that holds an Anthropic image block
which names a file by its id. In both cases the op does not reach the body.
