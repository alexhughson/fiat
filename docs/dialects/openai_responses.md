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

| op                                | purpose                                           |
| --------------------------------- | ------------------------------------------------- |
| `openai_responses.input`          | one request `input[]` item                        |
| `openai_responses.output`         | one response `output[]` item                      |
| `openai_responses.output_meta`    | response item ids/status/content metadata         |
| `openai_responses.reasoning_item` | side op of `llm.reasoning`: id, encrypted_content |
| `openai_responses.tool`           | provider-specific hosted tools                    |
| `openai_responses.tool_meta`      | extra function-tool fields such as `strict`       |
| `openai_responses.finish_reason`  | response status/incomplete details                |
| `openai_responses.usage`          | shared usage plus usage extras                    |
| `openai_responses.tool_choice`    | provider-specific tool choice                     |
| `openai_responses.body_field`     | unknown request key or response envelope field    |

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
event in, one event out:

| wire event                                       | raised ops                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `response.output_text.delta`                     | one `body_field` op per event field + `response.text_delta`      |
| `response.function_call_arguments.delta`         | one `body_field` op per event field + `response.tool_call_delta` |
| `response.content_part.added` (`output_text`)    | `openai_responses.stream_event_meta` + `response.text_start`     |
| `response.output_item.added` / `.done`           | one `body_field` op per event field, plus the item               |
| `response.completed` / `.incomplete` / `.failed` | one `body_field` op per event field, plus usage                  |

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
                "type": "output_text",
                "text": "",
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

`output_index` is the core op's `index`; the fields only OpenAI has
(`item_id`, `content_index`, `sequence_number`, and the `part` object, whose
text the `response.text_delta` ops already carry) stay together in one
`openai_responses.stream_event_meta` op, and lowering folds the two ops back
into the same wire event. A part other than `output_text` is not raised yet
and keeps the whole event in the meta op, so it round-trips.

Other stream events (`response.created`, `response.in_progress`,
`response.output_text.done`, `response.content_part.done`) are not raised
yet and still throw.

## Out of scope

Structured output lowering, streaming output item protocols beyond text/tool
deltas, audio/video input, image `detail` metadata, and provider-neutral
representations for MCP, file search, computer use, provider file ids, or image
generation.
