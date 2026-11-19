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

| op                                    | purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `openai_responses.input`              | one request `input[]` item                        |
| `openai_responses.output`             | one response `output[]` item                      |
| `openai_responses.output_meta`        | response status/content metadata and message ids  |
| `openai_responses.function_call_item` | side op of `llm.tool_call`: function-call item id |
| `openai_responses.reasoning_item`     | side op of `llm.reasoning`: id, encrypted_content |
| `openai_responses.tool`               | provider-specific hosted tools                    |
| `openai_responses.tool_meta`          | extra function-tool fields such as `strict`       |
| `openai_responses.finish_reason`      | response status/incomplete details                |
| `openai_responses.usage`              | shared usage plus usage extras                    |
| `openai_responses.tool_choice`        | provider-specific tool choice                     |
| `openai_responses.body_field`         | unknown request key or response envelope field    |

## Tool rules

- A function call raises `llm.tool_call.id` from `call_id`, the id its tool
  results use. Its item `id` raises separately as
  `openai_responses.function_call_item` with string params `of` and `itemId`.
  `of` resolves to the nearest earlier op with that id and must name an
  `llm.tool_call`; a same-id tool result does not satisfy the reference.
- Request lowering restores the item id from that side op and omits the
  optional input item id when no side op exists. Response lowering restores
  the same item id or synthesizes an `fc_` id for a call from another dialect.
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

## Out of scope

Structured output lowering, streaming output item protocols beyond text/tool
deltas, audio/video input, image `detail` metadata, and provider-neutral
representations for MCP, file search, computer use, provider file ids, or image
generation.
