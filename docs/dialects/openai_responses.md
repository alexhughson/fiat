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

| op                                   | purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `openai_responses.input`             | one request `input[]` item                                  |
| `openai_responses.output`            | one response `output[]` item                                |
| `openai_responses.output_meta`       | response item ids/status/content metadata                   |
| `openai_responses.reasoning_item`    | side op of `llm.reasoning`: id, encrypted_content           |
| `openai_responses.tool`              | provider-specific hosted tools                              |
| `openai_responses.tool_meta`         | extra function-tool fields such as `strict`                 |
| `openai_responses.finish_reason`     | response status/incomplete details                          |
| `openai_responses.usage`             | shared usage plus usage extras                              |
| `openai_responses.tool_choice`       | provider-specific tool choice                               |
| `openai_responses.body_field`        | unknown request key or response envelope field              |
| `openai_responses.stream_event_meta` | fields of a content-part stream event that no core op holds |

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

| wire event                                         | raised ops                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `response.output_text.delta`                       | `openai_responses.stream_event_meta` + `response.text_delta`                              |
| `response.function_call_arguments.delta`           | `openai_responses.stream_event_meta` + `response.tool_call_delta`                         |
| `response.content_part.added` (`output_text`)      | `openai_responses.stream_event_meta` + `response.text_start`                              |
| `response.content_part.done` (`output_text`)       | `openai_responses.stream_event_meta` + `response.block_stop`                              |
| `response.output_text.done`                        | `openai_responses.stream_event_meta` only                                                 |
| `response.function_call_arguments.done`            | `openai_responses.stream_event_meta` only                                                 |
| `response.output_item.added` (`function_call`)     | `openai_responses.stream_event_meta` + `response.tool_call_delta`                         |
| `response.output_item.done` (`function_call`)      | `openai_responses.stream_event_meta` + `response.tool_call_delta` + `response.block_stop` |
| `response.output_item.added` / `.done` (`message`) | `openai_responses.stream_event_meta` only                                                 |
| `response.created`                                 | `llm.model` + `openai_responses.stream_event_meta`                                        |
| `response.in_progress`                             | `openai_responses.stream_event_meta` only                                                 |
| `response.completed` / `.incomplete` / `.failed`   | one `body_field` op per event field, plus usage                                           |

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

`response.created` states the model, which raises to `llm.model`; the rest of
the envelope (id, status, request echoes, and the `output` list, which
repeats the items the item events already carried) stays in the meta op.

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
        "output": []
    }
}
```

raised:

```json
[
    {
        "op": "llm.model",
        "model": "gpt-4o"
    },
    {
        "op": "openai_responses.stream_event_meta",
        "event": {
            "type": "response.created",
            "sequence_number": 2,
            "response": {
                "id": "resp_123",
                "object": "response",
                "created_at": 1700000000,
                "status": "in_progress",
                "output": []
            }
        },
        "appliesTo": "response"
    }
]
```

`response.in_progress` and `response.output_text.done` only repeat facts
that earlier events stated, so each stays whole in one meta op.
`response.output_item.done` of a `function_call` item ends the tool call
block, so it raises a `response.block_stop` beside its meta op and
`response.tool_call_delta`; a `message` item has no core op yet, so the whole
event stays in the meta op.

The `error` stream event still throws; a core error op does not exist yet.

## Out of scope

Structured output lowering, streaming output item protocols beyond text/tool
deltas, audio/video input, image `detail` metadata, and provider-neutral
representations for MCP, file search, computer use, provider file ids, or image
generation.
