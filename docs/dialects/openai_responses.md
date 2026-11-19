# Dialect: `openai_responses`

OpenAI Responses (`POST /v1/responses`). Code:
`src/dialects/openai_responses/`.

## Direct mappings

| wire                                        | core                                |
| ------------------------------------------- | ----------------------------------- |
| `model`                                     | `llm.model`                         |
| response `id`                               | `response.id`                       |
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
| `openai_responses.usage`          | the cache-write lifetime breakdown                |
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

## Stream events

The OpenAI Responses API sends each stream event to a proxy as one SSE `data`
body. `OpenAIResponsesTranslator.fromStreamResponse` raises that event body,
and `toStreamResponse` writes the same event back.

| event the Responses API sends to the proxy                   | shared ops in the raised program                              |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `response.created`, `response.in_progress`                   | `response.id`, `llm.model`                                    |
| `response.completed`, `response.incomplete`                  | `response.id`, `llm.model`, `response.stop`, `response.usage` |
| `response.failed`                                            | `response.id`, `llm.model`, `response.usage`                  |
| `response.output_text.delta`                                 | `response.text_delta`                                         |
| `response.function_call_arguments.delta`                     | `response.tool_call_delta` with an argument fragment          |
| `response.function_call_arguments.done`                      | no shared op                                                  |
| `response.output_item.added` / `.done` for a `function_call` | `response.tool_call_delta`                                    |
| other output items                                           | no shared op                                                  |
| `response.content_part.added` / `.done`                      | no shared op                                                  |
| `response.output_text.done`                                  | no shared op                                                  |

A stop reason is present only when the response status has a core mapping, and
usage is present only when the event reports it. `output_index` becomes the
delta op's `index`, and a function item's `call_id` and `name` become its `id`
and `name`. Only `response.output_item.done` raises the complete arguments;
`response.function_call_arguments.done` keeps them in saved fields so the same
completed call does not raise a second core op.

Every event keeps its `type` and `sequence_number` in
`openai_responses.body_field` residuals. `item_id`, `content_index`, `logprobs`,
the saved response envelope, and whole content parts and output items also
stay in residuals. These saved fields keep a copy of the event for the round
trip, including values that also raise into core ops. Lowering combines the
saved fields with the shared ops without supplying an event type, response
status, id, index, or argument text that the event did not report.

## Out of scope

Structured output lowering; stream events for reasoning
(`response.reasoning_text.*`, `response.reasoning_summary_part.*`,
`response.reasoning_summary_text.*`), refusals (`response.refusal.*`),
annotations (`response.output_text.annotation.added`), built-in tools, audio,
compaction, queued responses, and the stream `error` event; audio/video input,
image `detail` metadata, and provider-neutral representations for MCP, file
search, computer use, provider file ids, or image generation.
