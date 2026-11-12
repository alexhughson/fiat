# Dialect: `anthropic_messages`

Anthropic Messages (`POST /v1/messages`). Code:
`src/dialects/anthropic_messages/`.

## Direct mappings

| wire                                         | core                    |
| -------------------------------------------- | ----------------------- |
| `model`                                      | `llm.model`             |
| `temperature`                                | `llm.temperature`       |
| `max_tokens`                                 | `llm.max_output_tokens` |
| `system`                                     | system `llm.text`       |
| ordinary tools                               | `llm.tool`              |
| canonical web search / code execution tools  | `llm.server_tool`       |
| `tool_choice`                                | `llm.tool_choice`       |
| `image` blocks with url/base64 sources       | `llm.image`             |
| PDF `document` blocks with url/base64 source | `llm.document`          |

Anthropic has no system message. System text lowers to the top-level `system`
field.

## Dialect ops

| op                                      | purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `anthropic_messages.message`            | one wire message; raises text, tool use, and tool result blocks |
| `anthropic_messages.content_block`      | provider-only content blocks such as documents or image extras  |
| `anthropic_messages.redacted_thinking`  | side op of `llm.reasoning`: data of a `redacted_thinking` block |
| `anthropic_messages.tool_result_meta`   | Anthropic-only tool-result fields                               |
| `anthropic_messages.tool`               | provider-specific tool config                                   |
| `anthropic_messages.stop_reason`        | maps stop reasons to `response.stop`                            |
| `anthropic_messages.usage`              | shared usage plus cache/detail extras                           |
| `anthropic_messages.metadata`           | top-level metadata; `user_id` maps to `request.user`            |
| `anthropic_messages.sampling`           | `top_p` / `top_k`                                               |
| `anthropic_messages.thinking_config`    | raw `thinking` object                                           |
| `anthropic_messages.output_config`      | raw `output_config` object                                      |
| `anthropic_messages.context_management` | raw `context_management` object                                 |
| `anthropic_messages.body_field`         | unknown top-level field                                         |
| `anthropic_messages.stream_event`       | one wire stream event that no core op names (see below)         |

## Legalizations

- Insert `max_tokens: 4096` when absent.
- Remove unsupported sampling params by default; throw in strict mode.
- Lower `llm.thinking` to the model's supported thinking wire shape.
- Clamp unsupported thinking efforts by default; throw in strict mode.
- Media model validation is hard failure even in lenient mode. It never drops
  media.

## Lints

- Mid-conversation system text throws instead of being hoisted and reordered.
- Unsupported structured output throws instead of being dropped.
- Image blocks lower only for user-role URL/base64 sources. File-backed images
  and blocks with provider-only extras stay as Anthropic content residuals.
- PDF document blocks lower only for user-role URL/base64 sources. Documents
  with citations or other provider-only extras stay as content-bearing
  Anthropic residuals.

## Response streams

`fromStreamResponse` wraps one SSE event as an `anthropic_messages.stream_event`
op; `raiseStreamEvents` maps each event type. One wire event can raise several
ops:

| wire event                               | raised ops                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `message_start`                          | `llm.model` + `response.usage` + a `stream_event` residual for the rest |
| `content_block_start` (text)             | `response.text_start`                                                   |
| `content_block_start` (tool_use)         | `response.tool_call_delta` with `id` and `name`                         |
| `content_block_delta` (text_delta)       | `response.text_delta`                                                   |
| `content_block_delta` (input_json_delta) | `response.tool_call_delta`                                              |
| `content_block_stop`                     | `response.block_stop`                                                   |
| `ping`, `message_stop`                   | `stream_event` residual                                                 |
| `message_delta`                          | `response.stop` + `response.usage`                                      |

`message_start`:

```json
{
    "type": "message_start",
    "message": {
        "id": "msg_01",
        "type": "message",
        "role": "assistant",
        "content": [],
        "model": "claude-opus-5-5",
        "stop_reason": null,
        "stop_sequence": null,
        "usage": {
            "input_tokens": 25,
            "output_tokens": 1
        }
    }
}
```

raised:

```json
[
    {
        "op": "llm.model",
        "model": "claude-opus-5-5"
    },
    {
        "op": "response.usage",
        "inputTokens": 25,
        "outputTokens": 1
    },
    {
        "op": "anthropic_messages.stream_event",
        "appliesTo": "response",
        "event": {
            "type": "message_start",
            "message": {
                "id": "msg_01",
                "type": "message",
                "role": "assistant",
                "content": [],
                "stop_reason": null,
                "stop_sequence": null
            }
        }
    }
]
```

On lowering, `lowerStreamMessageStart` folds the `llm.model` and usage ops
raised from a `message_start` event back into that event's `stream_event`
residual, so each event lowers back to the same wire event, with one loss: a
`message_delta` event loses `stop_sequence: null`, on `main` and here.
Residual events pass through `toStreamResponse` untouched; lowering to another
dialect drops them with a warning. Lowering a whole stream at once moves the
rebuilt `message_delta` event after `message_stop`, also a `main` behavior;
each event lowered on its own keeps its order.

`ping` keeps the connection open and carries no other meaning; only Anthropic
sends it, so it stays an `anthropic_messages.stream_event` op.

`content_block_stop` ends a text block or a tool call block and raises to
`response.block_stop` with the block's index, carrying no text.

`error` is not raised yet and still throws. Reasoning
stream events (`thinking` / `redacted_thinking` block starts, `thinking_delta`,
`signature_delta`) are not raised yet and still throw.

## Out of scope

Provider-neutral provider file handles, audio/video, prompt caching markers,
and citations.
