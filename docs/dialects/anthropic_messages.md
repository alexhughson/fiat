# Dialect: `anthropic_messages`

Anthropic Messages (`POST /v1/messages`). Code:
`src/dialects/anthropic_messages/`.

## Wire ↔ core direct mappings (no dialect op)

| wire | core op |
|---|---|
| `model` | `llm.model` |
| `temperature` | `llm.temperature` |
| `max_tokens` | `llm.max_output_tokens` |
| `system` (string or text blocks) | `llm.text` with `role: "system"` — there is no system *message* on this wire, so system text stays a core op through lowering and `toWire` joins the parts into the top-level `system` string |
| `tools[]` | `llm.tool` (`input_schema` ⇄ `inputSchema`) |
| `tool_choice` | `llm.tool_choice` (`any` ⇄ `required`, `{type:"tool",name}` ⇄ `{name}`) |

## Dialect ops

| op | holds | raise → | lower ← |
|---|---|---|---|
| `anthropic_messages.message` | one wire message verbatim | per block: `text→llm.text`, `tool_use→llm.tool_call` (input is already an object), `tool_result→llm.tool_result` (`is_error→isError`) | regroups: consecutive same-role ops merge into one message's block list so turns alternate; tool results are user-role blocks |
| `anthropic_messages.stop_reason` | wire enum | `response.stop` — core reasons are a subset with the same names; unknown values throw | identity |
| `anthropic_messages.usage` | wire usage object | `response.usage` from `input_tokens`/`output_tokens`; leftovers (cache fields) re-emitted with `required: false` | usage ops merge in `toWire` |
| `anthropic_messages.param` | unknown body key | residual (requests: required; response envelope: `required: false`) | `body[key] = value` |

## Legalizations (`legalize.ts`)

- `anthropic_messages.default-max-tokens` (requests only): the API rejects
  requests without `max_tokens`, most other providers treat it as optional —
  inserts `llm.max_output_tokens: 4096` when absent. A cap is conformance,
  not a meaning change, so this is a legalization rather than a lint.

## Lints

- `llm.output` has no Messages-API equivalent: lowering throws a `LintError`
  instead of dropping it. If you want json-schema output on anthropic, write
  a core-IR pass that rewrites `llm.output` into a forced tool.

## Out of scope today (add via the cookbook)

Streaming events, image blocks, extended thinking blocks, prompt caching
markers (`cache_control`), citations.
