# Dialect: `openai_responses`

OpenAI Responses (`POST /v1/responses`). Code:
`src/dialects/openai_responses/`.

## Direct mappings

| wire                                        | core                                |
| ------------------------------------------- | ----------------------------------- |
| `model`                                     | `llm.model`                         |
| `instructions`                              | system `llm.text`                   |
| `temperature`                               | `llm.temperature`                   |
| `max_output_tokens`                         | `llm.max_output_tokens`             |
| `reasoning.effort`                          | `llm.thinking`                      |
| text input/output items                     | `llm.text`                          |
| `reasoning` input/output items              | `llm.reasoning`                     |
| `input_image.image_url`                     | `llm.image`                         |
| `input_file.file_url` / `file_data`         | `llm.document` for PDFs             |
| function-call items                         | `llm.tool_call` / `llm.tool_result` |
| function tools                              | `llm.tool`                          |
| minimal web search / code interpreter tools | `llm.server_tool`                   |
| portable tool choice                        | `llm.tool_choice`                   |

Lowering `llm.thinking` also requests `reasoning.encrypted_content`.

## Dialect ops

| op                                   | purpose                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `openai_responses.input`             | one request `input[]` item                                                                                                |
| `openai_responses.output`            | one response `output[]` item                                                                                              |
| `openai_responses.output_meta`       | response item ids/status/content metadata                                                                                 |
| `openai_responses.reasoning_item`    | side op of `llm.reasoning`: id, encrypted_content                                                                         |
| `openai_responses.tool`              | provider-specific hosted tools                                                                                            |
| `openai_responses.tool_meta`         | extra function-tool fields such as `strict`                                                                               |
| `openai_responses.finish_reason`     | response status/incomplete details                                                                                        |
| `openai_responses.usage`             | shared usage plus usage extras                                                                                            |
| `openai_responses.tool_choice`       | provider-specific tool choice                                                                                             |
| `openai_responses.body_field`        | unknown request key or response envelope field                                                                            |
| `openai_responses.stream_event_meta` | the remainder of a stream event after its shared fields raise to core ops; a whole event stays when it only repeats facts |

## Tool rules

- Function-call responses with both `call_id` and item `id` raise as
  `llm.tool_call.id = "call_id|item_id"`.
- Tool results use only `call_id`.
- Forced `{ name }` tool choice is resolved against declared tools during
  lowering.
- Canonical server-tool names are `web_search` and `code_execution`.
- Configured hosted tools, MCP tools, file search, computer use, image
  generation, and provider-specific hosted choices stay residuals.
- Custom grammar tools stay as `openai_responses.tool`; force them with
  `openai_responses.tool_choice`, not portable `llm.tool_choice`:
    ```ts
    {
        type: "custom",
        name: "apply_patch",
        format: { type: "grammar", syntax: "lark", definition },
    }
    ```
- Request `input_image.image_url` and PDF `input_file.file_url`/`file_data`
  parts lower as ordered message content parts.
- File ids are provider-owned and stay as native content-bearing residuals.
- Media model validation is hard failure even in lenient mode. It never drops
  media.

## Response streams

`fromStreamResponse` parses one SSE event; each event type maps to ops. One
wire event can raise several ops:

| wire event                                                                                     | raised ops                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `response.output_text.delta`                                                                   | `openai_responses.stream_event_meta` + `response.text_delta`                                                                                |
| `response.function_call_arguments.delta`                                                       | `openai_responses.stream_event_meta` + `response.tool_call_delta`                                                                           |
| `response.content_part.added` (`output_text`)                                                  | `openai_responses.stream_event_meta` + `response.text_start`                                                                                |
| `response.content_part.done` (`output_text`)                                                   | `openai_responses.stream_event_meta` + `response.block_stop`                                                                                |
| `response.output_text.done`                                                                    | `openai_responses.stream_event_meta` only                                                                                                   |
| `response.function_call_arguments.done`                                                        | `openai_responses.stream_event_meta` only                                                                                                   |
| `response.output_item.added` (`function_call`)                                                 | `openai_responses.stream_event_meta` + `response.tool_call_delta`                                                                           |
| `response.output_item.done` (`function_call`)                                                  | `openai_responses.stream_event_meta` + `response.block_stop`                                                                                |
| `response.output_item.added` / `.done` (any other item type, such as `message` or `reasoning`) | `openai_responses.stream_event_meta` only                                                                                                   |
| `response.created`                                                                             | `openai_responses.stream_event_meta` + `llm.model`                                                                                          |
| `response.in_progress`                                                                         | `openai_responses.stream_event_meta` only                                                                                                   |
| `response.completed` / `.incomplete`                                                           | `openai_responses.stream_event_meta` + `response.stop` + `response.usage` (+ `openai_responses.usage` for extra counts)                     |
| `response.failed`                                                                              | `openai_responses.stream_event_meta` only; plus `response.usage` (+ `openai_responses.usage` for extra counts) when the event carries usage |

`response.content_part.added`:

```json
{
    "type": "response.content_part.added",
    "sequence_number": 3,
    "item_id": "msg_123",
    "output_index": 0,
    "content_index": 0,
    "part": {
        "type": "output_text",
        "text": "",
        "annotations": [],
        "logprobs": []
    }
}
```

raised:

```json
[
    {
        "op": "openai_responses.stream_event_meta",
        "event": {
            "type": "response.content_part.added",
            "sequence_number": 3,
            "item_id": "msg_123",
            "content_index": 0,
            "part": {
                "annotations": [],
                "logprobs": []
            }
        },
        "appliesTo": "response"
    },
    {
        "op": "response.text_start",
        "index": 0
    }
]
```

`output_index` is the core op's `index`. `part.type` repeats what
`response.text_start` already says and the part's `text` arrives as
`response.text_delta` ops, so the meta op holds neither. The fields only
OpenAI has (`item_id`, `content_index`, `sequence_number`, and the `part`
keys `annotations` and `logprobs`) stay together in one
`openai_responses.stream_event_meta` op, and lowering folds the two ops back
into the same wire event. `response.content_part.done` raises the same way,
to `response.block_stop`; its meta op keeps the part's `text`, because stream
lowering holds no state, so without the text in the meta op the done event
would return from a round trip without its text. `part.type` repeats the core
op, so lowering writes the type back in both events. A part other than
`output_text`, such as a refusal, still throws, until a refusal has a core
op.

The delta events raise the same way: `response.output_text.delta` becomes one
`stream_event_meta` op (holding `item_id`, `content_index`, `sequence_number`,
and `logprobs`) plus a `response.text_delta` op whose `index` is the event's
`output_index`, and `response.function_call_arguments.delta` becomes one
`stream_event_meta` op plus a `response.tool_call_delta` op. The event's
`type` repeats what the core op already says, so it does not raise.

`response.created` states the model, which raises to `llm.model` after the
event's meta op. The envelope fields OpenAI always sends with the same value
on a created response (`status: "in_progress"`, an empty `output` list, a
null `usage`, `error`, and `incomplete_details`, and the `object` type
string) are constants: the raiser drops each only when it holds exactly the
expected value, and lowering writes the dropped values back, so a field
OpenAI ever sends with another value stays in the meta op and is not lost.
The fields only openai_responses has in a stream — the response `id` (until
its core op's row merges), `created_at`, and the request settings the
envelope echoes (`temperature`, `instructions`, `tools`, and the rest) —
stay in the meta op. The complete-response path raises and lowers the same
request echoes as `openai_responses.body_field` ops; the stream path keeps
them inside the event's meta op instead.

```json
{
    "type": "response.created",
    "sequence_number": 2,
    "response": {
        "id": "resp_123",
        "object": "response",
        "created_at": 1700000000,
        "status": "in_progress",
        "model": "gpt-4o",
        "output": [],
        "error": null,
        "incomplete_details": null,
        "usage": null,
        "temperature": 1,
        "metadata": {}
    }
}
```

raised:

```json
[
    {
        "op": "openai_responses.stream_event_meta",
        "event": {
            "type": "response.created",
            "sequence_number": 2,
            "response": {
                "id": "resp_123",
                "created_at": 1700000000,
                "temperature": 1,
                "metadata": {}
            }
        },
        "appliesTo": "response"
    },
    {
        "op": "llm.model",
        "model": "gpt-4o"
    }
]
```

`response.in_progress` and `response.output_text.done` only repeat facts
that earlier events stated, so each stays whole in one meta op.
`response.output_item.done` of a `function_call` item repeats the call id,
name, and full arguments that the added and delta events already stated, so
the whole event stays in the meta op beside the `response.block_stop` that
ends the block; a transform that edits the `response.tool_call_delta` ops
does not change that copy. `response.output_item.added` of a
`function_call` item states the call id and name once, so they raise into
the `response.tool_call_delta` op and the meta op's item keeps the rest.
An output item of any other type — a `message`, a `reasoning` item, or a
future type — has no core op yet, so the whole event stays in the meta op
and round-trips.

The terminal events close the stream: a `completed` or `incomplete` event
raises its finish reason to `openai_responses.finish_reason` (which becomes
`response.stop` in the raised program) and its usage object to
`openai_responses.usage` (which becomes `response.usage` plus an
`openai_responses.usage` residual for the fields only openai_responses
counts). A `failed` event has no finish reason its status maps to, so it
raises no stop op; its usage raises when the event carries one. Everything
else — the response's `status`, `output` list, `error`, and
`incomplete_details` — stays whole in the event's one meta op, and lowering
folds the ops back into the same wire event.

The `error` stream event still throws; a core error op does not exist yet.

Stream lowering accepts `llm.model`: the model raises from
`response.created` and from another dialect's first event, and lowering
writes it back into the response envelope. The envelope ops (model, usage,
finish reason) pick the event type together after the whole program is
scanned: a finish reason closes the response (`end_turn` and `tool_use` to
`response.completed`, `max_tokens` and `content_filter` to
`response.incomplete`), and a model without one opens it
(`response.created`), because the anthropic `message_start` and a bare
openai_chat chunk carry no finish reason. Usage without a model or a
finish reason keeps the `response.completed` event. A program that lowers
to no event — the anthropic `message_stop`, which raises only to a foreign
op — makes singular `toStreamResponse` throw, and `toStreamResponses`
returns no event for it. The model reaches the envelope only when the
program holds no text or tool delta: a delta makes lowering return the
delta event first, and a model or usage count beside it is dropped, so an
openai_chat or gemini chunk that carries content writes no
`response.created`. Lowered one event at a time with `toStreamResponse`,
a raised anthropic text stream yields `response.created`,
`response.content_part.added`, the text deltas,
`response.content_part.done`, `response.completed`, and the `message_stop`
throws.

## Out of scope

Structured output lowering, a core op for an output item of a non-function
type starting or ending in a stream (a `message` or `reasoning` item stays
whole in the meta op), audio/video input, image `detail` metadata, and
provider-neutral representations for MCP, file search, computer use,
provider file ids, or image generation.
