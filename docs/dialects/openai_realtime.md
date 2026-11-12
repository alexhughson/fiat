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
- Realtime has no field for reasoning: `llm.reasoning` is dropped with a
  warning.
- `toBody` emits `response.create.response.output_modalities: ["text"]`
  unless supplied by the caller.
- Prefix system text lowers to `response.create.response.instructions`.
  Interleaved system text throws.
- In a complete response body, streaming detail events
  (`response.output_text.delta`, `response.output_item.done`,
  `response.output_text.done`) throw; parse `response.done` for the final
  output.
- On the stream edge, a `response.content_part.added` or
  `response.content_part.done` event of a text part raises
  `response.text_start` or `response.block_stop` beside the event's
  `openai_realtime.event_param` ops. The params hold only realtime data: no
  `output_index` or `part.type` (the core op states both) and, on `added`,
  no empty `part.text` (the part's text arrives as
  `response.output_text.delta` events). The done event's params keep the full
  `part.text`, because stream lowering holds no state, so without the text in
  the params the done event would return from a round trip without its text.
  A part other than `text` raises no block op:
  `response.content_part.added` throws, and
  `response.content_part.done` raises the event params only, as before.
  Lowering writes `response.content_part.added` for `response.text_start`
  and `response.content_part.done` for `response.block_stop`, rebuilding
  `output_index` from the op's `index` and `part.type` as `text`.
- WebRTC setup, auth, and live connection management are out of scope.
