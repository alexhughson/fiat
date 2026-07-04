# Dialect: `openai_realtime`

OpenAI Realtime event wire for JSON client/server events. Code:
`src/dialects/openai_realtime/`.

This is not an HTTP request body dialect. A wire value is a self-contained
request or response event batch. For validation against Realtime calls, the
request body may also carry top-level call/session fields such as `model`:

```json
{
    "model": "gpt-realtime",
    "events": [
        {
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "hi" }]
            }
        },
        {
            "type": "response.create",
            "response": { "output_modalities": ["text"] }
        }
    ]
}
```

## Wire ↔ core direct mappings

| wire                                                       | core op                                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| `response.create.response.instructions`                    | request-level `llm.text { role:"system" }` |
| text `conversation.item.create.item` message content       | `llm.text`                                 |
| `response.create.response.tools[]`                         | `llm.tool` (`parameters` ⇄ `inputSchema`)  |
| `response.create.response.tool_choice`                     | `llm.tool_choice`                          |
| `response.create.response.max_output_tokens` (number only) | `llm.max_output_tokens`                    |
| top-level request `model`                                  | `llm.model`                                |
| `response.done.response.model`                             | `llm.model` when present                   |

## Dialect ops

| op                                    | holds                                       | raise →                                                                                     | lower ←                                                                          |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `openai_realtime.item`                | one `conversation.item.create` event        | `llm.text`, `llm.tool_call`, or `llm.tool_result`                                           | emits ordered `conversation.item.create` events                                  |
| `openai_realtime.item_meta`           | original request item/event template        | required request residual when metadata or multiple parts must round-trip                   | reapplies metadata to lowered request item(s)                                    |
| `openai_realtime.response_input_mode` | marker for `response.create.response.input` | residual marker                                                                             | puts lowered items into `response.input` instead of separate conversation events |
| `openai_realtime.output`              | one `response.done.response.output[]` item  | assistant `llm.text` or `llm.tool_call`                                                     | builds `response.done.response.output[]`                                         |
| `openai_realtime.output_meta`         | original response output item template      | response residual when item/content metadata must round-trip                                | reapplies metadata to lowered response output item(s)                            |
| `openai_realtime.tool_meta`           | extra function tool fields like `strict`    | required request residual                                                                   | reapplies fields to the matching lowered tool                                    |
| `openai_realtime.finish_reason`       | normalized realtime completion reason       | `response.stop`                                                                             | synthesizes `status` / `status_details` when needed                              |
| `openai_realtime.usage`               | realtime usage object                       | `response.usage` from `input_tokens`/`output_tokens`; leftovers are response-only residuals | response usage ops merge back into wire usage                                    |
| `openai_realtime.response_param`      | unsupported `response.create.response` key  | required residual                                                                           | serialized back under `response.create.response`                                 |
| `openai_realtime.event_param`         | event envelope fields like `event_id`       | response envelope residual when response-side                                               | serialized back onto the event                                                   |
| `openai_realtime.body_field`          | top-level or response envelope key          | response envelope residuals are `appliesTo:"response", required:false`                      | serialized back in place                                                         |

## Scope

- Text is the only cross-provider content represented as core `llm.text`.
  Realtime-only parts such as audio remain realtime residuals and round-trip
  when targeting `openai_realtime`; translating them to another provider halts
  unless a pass explicitly marks the residual droppable.
- `toBody` emits `response.create.response.output_modalities: ["text"]` unless
  the caller supplied a realtime response param.
- `llm.model` lowers to top-level `model`, so OpenAI Chat/Responses-shaped
  requests can become Realtime call validation bodies.
- Prefix system text lowers to `response.create.response.instructions`.
  Interleaved system text would require event reordering, so it is rejected.
- Function tools, final function calls, and function call outputs are
  supported using Realtime's documented `function` / `function_call` /
  `function_call_output` shapes.
- Streaming deltas are out of scope for response translation; parse
  `response.done`, which carries the final output items. Live websocket
  validation lives under `e2e/openai_realtime/`.
- WebRTC setup, session auth, and live connection management are out of scope
  for the dialect. The e2e runner performs only the validation event exchange.
