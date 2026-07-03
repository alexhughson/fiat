# Dialect: `openai_chat`

OpenAI Chat Completions (`POST /v1/chat/completions`). Code:
`src/dialects/openai_chat/`.

## Wire ↔ core direct mappings (no dialect op)

| wire | core op |
|---|---|
| `model` | `llm.model` |
| `temperature` | `llm.temperature` |
| `max_tokens`, `max_completion_tokens` | `llm.max_output_tokens` (serializes back as `max_tokens`) |
| `tools[].function` | `llm.tool` (`parameters` ⇄ `inputSchema`) |
| `tool_choice` | `llm.tool_choice` (`{type:"function",function:{name}}` ⇄ `{name}`) |
| `response_format` (type `json_schema` only) | `llm.output`; other types stay a `param` residual |

## Dialect ops

| op | holds | raise → | lower ← |
|---|---|---|---|
| `openai_chat.message` | one wire message verbatim | `llm.text` per text unit, `llm.tool_call` per embedded call (arguments JSON-parsed, throws on garbage), `llm.tool_result` for `role:"tool"` | regroups: assistant text + following calls merge into one message; a bare call gets `content: null` |
| `openai_chat.finish_reason` | wire enum string | `response.stop` via `stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`; anything else throws | reverse map (`stop_sequence→stop`) |
| `openai_chat.usage` | wire usage object | `response.usage` from `prompt_tokens`/`completion_tokens`; leftover fields re-emitted as this op with `required: false` | usage ops merge into one wire object in `toWire` |
| `openai_chat.param` | unknown body key | residual (requests: required; response envelope: `required: false`) | serialized back as `body[key] = value` |

## Quirks learned from the real API

- A **forced** tool choice returns `finish_reason: "stop"`, not
  `"tool_calls"` — detect tool use by the presence of `llm.tool_call` ops,
  never by the stop reason (`test/live.test.ts`).
- Responses with `n > 1` choices are rejected at `fromWire` (out of scope).
- `toResponse` synthesizes envelope boilerplate (`id`, `object`, `created`)
  when the program has none — the proxy case where the real response came
  from another provider.

## Out of scope today (add via the cookbook)

Streaming chunks, image/audio content parts, `logprobs`, the Responses API
(`openai_responses` should be its own dialect).
