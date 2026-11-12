# useRequestedModelWhenNoResponseModel

If a response program is not raised from a provider's response body, for
example a program built from the ops of a request and one assistant text, the
program holds `llm.model` and no `response.model`. A dialect writes the model
of a response body only from `response.model`, and `dropRequestOps` removes
`llm.model`, so without `useRequestedModelWhenNoResponseModel` the response
body names no model.

```ts
function useRequestedModelWhenNoResponseModel(program: Program): Program;
```

`Program` is the type `Op[]`, declared in `src/core/ops.ts`.

`useRequestedModelWhenNoResponseModel(program)` is in `src/core/pipeline.ts`.
When `lowerToWire` compiles a response body, and when
`lowerStreamResponseToWire` or `lowerStreamResponsesToWire` compiles stream
events, it calls `useRequestedModelWhenNoResponseModel` after `dropMetaOps`
and before `dropRequestOps`.

## Example

The run is for the self-answering proxy: a proxy which exposes Anthropic's
Messages API to its client and answers a request itself, without a call to a
provider's API. The self-answering proxy builds the response program from the
`llm.model` op of the request, an id, and one assistant text.

**In**: the whole response program that the self-answering proxy passes to
`AnthropicTranslator.toResponse`, and that `lowerToWire` passes to
`useRequestedModelWhenNoResponseModel`. The program is written by hand.

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "response.id",
        "id": "msg_1"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    }
]
```

**Out**: the whole response program that `lowerToWire` passes to the
`beforeLower` hook. `dropRequestOps` runs between
`useRequestedModelWhenNoResponseModel` and the hook and removes no op from
this program, so the block is also what
`useRequestedModelWhenNoResponseModel` returns.

```json
[
    {
        "op": "response.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "response.id",
        "id": "msg_1"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    }
]
```

**Body**: the whole response body that `AnthropicTranslator.toResponse`
returns for the **In** program, and that the self-answering proxy returns to
its client.

```json
{
    "model": "claude-sonnet-4-5",
    "id": "msg_1",
    "stop_reason": "end_turn",
    "type": "message",
    "role": "assistant",
    "content": [
        {
            "type": "text",
            "text": "hello"
        }
    ]
}
```

`useRequestedModelWhenNoResponseModel` put a `response.model` op in the place
of the `llm.model` op, so the response body names `claude-sonnet-4-5`.

## What the function changes

- When the program holds a `response.model` op,
  `useRequestedModelWhenNoResponseModel` returns the program unchanged, and
  the response body names the model that answered.
- When the program holds no `response.model` op and one or more `llm.model`
  ops, `useRequestedModelWhenNoResponseModel` puts a `response.model` op with
  the same `model` in the place of the last `llm.model` op. The last
  `llm.model` op is the one that lowering to a request body writes.
- When the program holds neither op, `useRequestedModelWhenNoResponseModel`
  returns the program unchanged, and the response body names no model.

`dropRequestOps` runs next. A response body and a stream event have no
field for an op that sets up a request, so `dropRequestOps` removes every
`llm.model` op that is left, every `request.*` op, and the ops
`llm.temperature`, `llm.max_output_tokens`, `llm.thinking`, `llm.tool`,
`llm.server_tool`, `llm.tool_choice`, and `llm.output`.
