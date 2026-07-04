# Dialect: `anthropic_messages`

Anthropic Messages (`POST /v1/messages`). Code:
`src/dialects/anthropic_messages/`.

## Wire ↔ core direct mappings (no dialect op)

| wire                             | core op                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                          | `llm.model`                                                                                                                                                                                   |
| `temperature`                    | `llm.temperature`                                                                                                                                                                             |
| `max_tokens`                     | `llm.max_output_tokens`                                                                                                                                                                       |
| `system` (string or text blocks) | `llm.text` with `role: "system"` — there is no system _message_ on this wire, so system text stays a core op through lowering and `toWire` joins the parts into the top-level `system` string |
| `tools[]`                        | `llm.tool` (`input_schema` ⇄ `inputSchema`) or minimal `llm.server_tool` for canonical `web_search_20260318` / `code_execution_20260521`                                                      |
| `tool_choice`                    | `llm.tool_choice` (`any` ⇄ `required`, `{type:"tool",name}` ⇄ `{name}`)                                                                                                                       |

## Dialect ops

| op                                      | holds                                     | raise →                                                                                                                               | lower ←                                                                                                                       |
| --------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `anthropic_messages.message`            | one wire message verbatim                 | per block: `text→llm.text`, `tool_use→llm.tool_call` (input is already an object), `tool_result→llm.tool_result` (`is_error→isError`) | regroups: consecutive same-role ops merge into one message's block list so turns alternate; tool results are user-role blocks |
| `anthropic_messages.tool`               | provider-specific tool                    | residual when a server/client tool has Anthropic-only config fields                                                                   | serialized back exactly                                                                                                       |
| `anthropic_messages.stop_reason`        | wire enum                                 | `response.stop` via same-name values including `refusal`, `pause_turn`, and `model_context_window_exceeded`; unknown values throw     | same-name values; `content_filter` maps to `refusal`                                                                          |
| `anthropic_messages.usage`              | wire usage object                         | `response.usage` from `input_tokens`/`output_tokens`; leftovers (cache fields) re-emitted with `appliesTo:"response", required:false` | response usage ops merge in `toWire`                                                                                          |
| `anthropic_messages.metadata`           | top-level `metadata` object               | `metadata.user_id→request.user`; leftovers remain on this op                                                                          | merges into `metadata`                                                                                                        |
| `anthropic_messages.sampling`           | top-level `top_p` or `top_k`              | request residual; model legalizations delete it for models that reject explicit sampling unless `{ strict: true }` is set             | serialized as `top_p` or `top_k`                                                                                              |
| `anthropic_messages.thinking_config`    | raw top-level `thinking` object           | supported disabled/adaptive housekeeping is marked droppable; otherwise residual                                                      | serialized as `thinking`                                                                                                      |
| `anthropic_messages.output_config`      | raw top-level `output_config` object      | `effort→llm.thinking`, json schema `format→llm.output`; leftovers remain on this op                                                   | serialized as `output_config`                                                                                                 |
| `anthropic_messages.context_management` | raw top-level `context_management` object | supported clear-thinking housekeeping is marked droppable; otherwise residual                                                         | serialized as `context_management`                                                                                            |
| `anthropic_messages.body_field`         | unknown body key                          | residual (requests: required; response envelope: `appliesTo:"response", required:false`)                                              | `body[key] = value`                                                                                                           |

## Legalizations (`legalize.ts`)

- `anthropic_messages.default-max-tokens` (requests only): the API rejects
  requests without `max_tokens`, most other providers treat it as optional —
  inserts `llm.max_output_tokens: 4096` when absent. A cap is conformance,
  not a meaning change, so this is a legalization rather than a lint.
- `anthropic_messages.legalize-unsupported-sampling-params`: for Claude
  models that reject explicit sampling controls, removes `llm.temperature`,
  `top_p`, and `top_k` by default. With `{ strict: true }`, the same request
  throws before `toWire`.
- `anthropic_messages.legalize-thinking`: chooses the target model's thinking
  wire shape. Claude Sonnet 5-style adaptive models get
  `thinking:{type:"adaptive"}` plus `output_config.effort`; Sonnet 4.5-style
  budget models get `thinking:{type:"enabled", budget_tokens}`. Unsupported
  efforts clamp by default (`xhigh` becomes `high` when needed), and strict
  mode throws.

## Lints

- `llm.output` has no Messages-API equivalent: lowering throws a `LintError`
  instead of dropping it. If you want json-schema output on anthropic, write
  a core-IR pass that rewrites `llm.output` into a forced tool.
- `llm.text` with `role:"system"` after user/assistant content lints instead
  of being hoisted to the top-level `system` field, because hoisting would
  reorder the instruction.

## Out of scope today (add via the cookbook)

Streaming events, image blocks, extended thinking blocks, prompt caching
markers (`cache_control`), citations.
