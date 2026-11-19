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

## Stream events

The OpenAI Responses API sends each event of a stream to a proxy as one SSE
`data` body; `OpenAIResponsesTranslator.fromStreamResponse` raises one such
event body into a program, and `toStreamResponse` lowers that program back
into the same event. This section shows a proxy which exposes the Gemini API
to its clients and routes some requests to the OpenAI Responses API.

| event the Responses API sends to the proxy                   | ops in the raised program                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `response.created`, `response.in_progress`                   | `response.id`, `llm.model`                                    |
| `response.completed`                                         | `response.id`, `llm.model`, `response.stop`, `response.usage` |
| `response.output_text.delta`                                 | `response.text_delta`                                         |
| `response.function_call_arguments.delta`                     | `response.tool_call_delta`                                    |
| `response.function_call_arguments.done`                      | `response.tool_call_delta` with the complete `arguments`      |
| `response.output_item.added` / `.done` for a `function_call` | `response.tool_call_delta`                                    |
| `response.failed`, `response.incomplete`                     | `response.id`, `llm.model`, `response.usage`                  |

Every other value of these events — the event `type`, the `sequence_number`,
the `item_id` and `content_index` bookkeeping, the response envelope's own
fields such as `object` and `created_at`, a content part or an output item —
stays in `openai_responses.body_field` ops, so the event it came from can be
lowered back. A text block starting or ending (`response.content_part.added`,
`response.content_part.done`) has no core op yet, so those events, and
`response.output_text.done`, raise their whole body as residuals; the
`response.usage` op holds only the shared token counts, and the rest of the
provider's usage object stays behind as an `openai_responses.usage` residual.

## Out of scope

Structured output lowering; stream events for reasoning
(`response.reasoning_text.*`, `response.reasoning_summary_part.*`,
`response.reasoning_summary_text.*`), refusals (`response.refusal.*`),
annotations (`response.output_text.annotation.added`), built-in tools
(`response.web_search_call.*`, `response.file_search_call.*`,
`response.code_interpreter_call.*`, `response.image_generation_call.*`,
`response.mcp_*`, `response.shell_call.*`, `response.custom_tool_call_input.*`),
and background mode (`response.queued`); audio/video input, image `detail`
metadata, and provider-neutral representations for MCP, file search, computer
use, provider file ids, or image generation.
