# Dialect: `anthropic_messages`

Anthropic Messages (`POST /v1/messages`). Code:
`src/dialects/anthropic_messages/`.

## Direct mappings

| wire                                        | core                    |
| ------------------------------------------- | ----------------------- |
| `model`                                     | `llm.model`             |
| `temperature`                               | `llm.temperature`       |
| `max_tokens`                                | `llm.max_output_tokens` |
| `system`                                    | system `llm.text`       |
| ordinary tools                              | `llm.tool`              |
| canonical web search / code execution tools | `llm.server_tool`       |
| `tool_choice`                               | `llm.tool_choice`       |
| `image` blocks with url/base64 sources      | `llm.image`             |
| PDF `document` blocks with url/base64 source | `llm.document`          |

Anthropic has no system message. System text lowers to the top-level `system`
field.

## Dialect ops

| op                                      | purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `anthropic_messages.message`            | one wire message; raises text, tool use, and tool result blocks |
| `anthropic_messages.content_block`      | provider-only content blocks such as documents or image extras  |
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

## Out of scope

Streaming events, provider-neutral provider file handles, audio/video, extended
thinking blocks, prompt caching markers, and citations.
