# Dialect: `openai_chat`

OpenAI Chat Completions (`POST /v1/chat/completions`). Code:
`src/dialects/openai_chat/`.

## Wire ↔ core direct mappings (no dialect op)

| wire                                        | core op                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `model`                                     | `llm.model`                                                                                  |
| `temperature`                               | `llm.temperature`                                                                            |
| `max_tokens`, `max_completion_tokens`       | `llm.max_output_tokens` (`gpt-5*` and `o*` reasoning chat models lower as `max_completion_tokens`; older chat models lower as `max_tokens`) |
| `tools[].function`                          | `llm.tool` (`parameters` ⇄ `inputSchema`)                                                    |
| `tool_choice`                               | `llm.tool_choice` (`{type:"function",function:{name}}` ⇄ `{name}`)                           |
| `response_format` (type `json_schema` only) | `llm.output`; unsupported formats or json-schema extras become `openai_chat.response_format` |

## Dialect ops

| op                            | holds                                          | raise →                                                                                                                                                                                | lower ←                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai_chat.message`         | one wire message verbatim                      | `llm.text` per text unit, `llm.tool_call` per embedded call (arguments JSON-parsed, throws on garbage), `llm.tool_result` for `role:"tool"`                                            | regroups: assistant text + following calls merge into one message; a bare call gets `content: null`                                                                                                  |
| `openai_chat.message_meta`    | OpenAI-only message metadata                   | preserves request `role:"developer"` as request-only metadata; refusal-only assistant responses also raise `refusal` as assistant `llm.text` and keep response metadata for round-trip | request lowering restores `role:"developer"` only in this dialect; response lowering restores `refusal`/`annotations`/`audio` and throws if refusal metadata conflicts with changed synthesized text |
| `openai_chat.finish_reason`   | wire enum string                               | `response.stop` via `stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`, `content_filter→content_filter`; anything else throws                                                 | reverse map (`stop_sequence→stop`, refusal/content filter→`content_filter`)                                                                                                                          |
| `openai_chat.usage`           | wire usage object                              | `response.usage` from `prompt_tokens`/`completion_tokens`; leftover fields re-emitted as this op with `appliesTo:"response", required:false`                                           | response usage ops merge into one wire object in `toWire`                                                                                                                                            |
| `openai_chat.response_format` | unsupported or extra `response_format` payload | request residual                                                                                                                                                                       | serialized back as `response_format`                                                                                                                                                                 |
| `openai_chat.choice_count`    | request `n`                                    | request residual                                                                                                                                                                       | serialized back as `n`                                                                                                                                                                               |
| `openai_chat.max_completion_tokens` | reasoning-model request token cap | n/a | serialized back as `max_completion_tokens` |
| `openai_chat.body_field`      | unknown body key                               | residual (requests: required; response envelope: `appliesTo:"response", required:false`)                                                                                               | serialized back as `body[key] = value`                                                                                                                                                               |

## Quirks learned from the real API

- A **forced** tool choice returns `finish_reason: "stop"`, not
  `"tool_calls"` — detect tool use by the presence of `llm.tool_call` ops,
  never by the stop reason (`test/live.test.ts`).
- Consecutive `llm.tool_call` ops lower into one assistant message with
  multiple `tool_calls`, matching the OpenAI wire shape for parallel calls.
- Responses with `n > 1` choices are rejected at `fromWire` (out of scope).
- `toResponse` synthesizes envelope boilerplate (`id`, `object`, `created`)
  when the program has none — the proxy case where the real response came
  from another provider.
- Response envelope and vendor-usage residuals are response-only; they
  round-trip through `toResponse`, but appending that response to a request
  will not resend `id`, `created`, or `usage.total_tokens`.

## Out of scope today (add via the cookbook)

Streaming chunks, image/audio content parts, and `logprobs`. The Responses
API is modeled separately as `openai_responses`.
