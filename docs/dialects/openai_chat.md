# Dialect: `openai_chat`

OpenAI Chat Completions (`POST /v1/chat/completions`). Code:
`src/dialects/openai_chat/`.

## Direct mappings

| wire                                  | core                    |
| ------------------------------------- | ----------------------- |
| `model`                               | `llm.model`             |
| `temperature`                         | `llm.temperature`       |
| `max_tokens`, `max_completion_tokens` | `llm.max_output_tokens` |
| `tools[].function`                    | `llm.tool`              |
| `tool_choice`                         | `llm.tool_choice`       |
| `response_format.type:"json_schema"`  | `llm.output`            |
| `messages[].content[].image_url.url`  | `llm.image`             |
| `messages[].content[].input_audio`    | `llm.audio`             |
| `messages[].content[].file.file_data` | `llm.document` for PDFs |

Reasoning chat models lower token caps as `max_completion_tokens`; older chat
models lower them as `max_tokens`.

## Dialect ops

| op                                  | purpose                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `openai_chat.message`               | preserves one Chat message; raises text, tool calls, and tool results |
| `openai_chat.message_meta`          | developer-role metadata and response-only message metadata            |
| `openai_chat.finish_reason`         | maps Chat finish reasons to `response.stop`                           |
| `openai_chat.usage`                 | maps shared token counts and preserves usage extras                   |
| `openai_chat.response_format`       | unsupported or extra response-format payload                          |
| `openai_chat.choice_count`          | request `n`                                                           |
| `openai_chat.max_completion_tokens` | reasoning-model token cap                                             |
| `openai_chat.body_field`            | unknown top-level field                                               |

## Quirks

- Forced tool choice can return `finish_reason: "stop"`. Detect tool use by
  `llm.tool_call`, not stop reason.
- Consecutive tool calls lower into one assistant message with multiple
  `tool_calls`.
- Responses-style ids like `call_id|item_id` lower to the Chat `call_id`; ids
  over 40 characters are truncated.
- Reasoning chat models serialize portable system text as `developer`.
- Tool history without current tools still serializes `tools: []`.
- Responses with `n > 1` are rejected.
- Chat has no field for reasoning: `llm.reasoning` is dropped with a warning.
- Response envelope and usage residuals are response-only and are not resent
  when a response program is appended to a request.
- A Chat stream has no event that states the stream's start or its end: the
  first chunk carries the model and the last chunk carries the finish_reason.
  Stream lowering accepts `response.start` and `response.done` and writes no
  field and no event for them, so a program raised from another dialect's
  start or end event lowers to the same chunk as before the ops existed. The
  drop emits no warning: the Chat stream has neither a start nor an end
  event, so no data is lost.
- Request image URL parts lower as ordered message content parts. Data URLs
  raise to portable base64 image sources and lower back to data URLs.
- `input_audio` raises to base64 `llm.audio` for `wav` and `mp3`; other
  formats throw.
- PDF `file.file_data` raises to `llm.document`. `file_id` stays as a native
  content-bearing residual.
- Media model validation is hard failure even in lenient mode. It never drops
  media.

## Out of scope

Image `detail` metadata, file-backed images, video inputs, and `logprobs`.
The Responses API is modeled separately as `openai_responses`.

## Streaming

Chat Completions chunks translate as streams. A text delta chunk raises
`llm.model` and `response.text_delta`, keeping the chunk's `id`, `object`, and
`created` as `openai_chat.body_field` residuals, and lowers back to the same
chunk. A tool-call delta chunk raises `response.tool_call_delta`. A chunk whose
choice holds `finish_reason` raises `response.stop`; a chunk that holds `usage`
raises `response.usage`; one chunk can hold either or both. The `[DONE]`
sentinel is not a chunk and does not translate.
