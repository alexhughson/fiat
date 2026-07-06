# Dialect: `openai_realtime`

OpenAI Realtime JSON event batches. Code: `src/dialects/openai_realtime/`.

This is not an HTTP body dialect. A wire value is a batch of client/server
events, optionally with top-level call/session fields such as `model`.

## Direct mappings

| wire                                    | core                    |
| --------------------------------------- | ----------------------- |
| `response.create.response.instructions` | system `llm.text`       |
| text conversation items                 | `llm.text`              |
| `response.create.response.tools[]`      | `llm.tool`              |
| `response.create.response.tool_choice`  | `llm.tool_choice`       |
| numeric `max_output_tokens`             | `llm.max_output_tokens` |
| top-level request `model`               | `llm.model`             |
| `response.done.response.model`          | `llm.model`             |

## Dialect ops

| op                                    | purpose                                     |
| ------------------------------------- | ------------------------------------------- |
| `openai_realtime.item`                | `conversation.item.create` event            |
| `openai_realtime.item_meta`           | request item/event metadata                 |
| `openai_realtime.response_input_mode` | places lowered items under `response.input` |
| `openai_realtime.output`              | `response.done.response.output[]` item      |
| `openai_realtime.output_meta`         | response output metadata                    |
| `openai_realtime.tool_meta`           | extra function-tool fields                  |
| `openai_realtime.finish_reason`       | maps completion status to `response.stop`   |
| `openai_realtime.usage`               | shared usage plus realtime usage extras     |
| `openai_realtime.response_param`      | unsupported `response.create.response` key  |
| `openai_realtime.event_param`         | event envelope fields                       |
| `openai_realtime.body_field`          | top-level or response envelope key          |

## Scope

- Text, function tools, final function calls, and function call outputs map to
  core.
- Audio and other Realtime-only parts stay residuals.
- `toBody` emits `response.create.response.output_modalities: ["text"]`
  unless supplied by the caller.
- Prefix system text lowers to `response.create.response.instructions`.
  Interleaved system text throws.
- Streaming deltas are out of scope; parse `response.done` for final output.
- WebRTC setup, auth, and live connection management are out of scope.
