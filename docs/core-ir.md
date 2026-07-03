# Core IR

The shared vocabulary. Types live in `src/core/ops.ts`; that file is the
source of truth, this is the annotated catalog. Core ops represent what is
shared across LLM APIs and deliberately ignore distinctions that carry no
meaning (message grouping, JSON-string vs object tool arguments, provider
field names for token counts).

A program is `Op[]`. Op order is meaningful only where conversation order is
meaningful: `llm.text` / `llm.tool_call` / `llm.tool_result` ops replay in
order. Config ops (`llm.model`, `llm.temperature`, ...) may appear anywhere.

## `llm.*` — request semantics

| op | fields | notes |
|---|---|---|
| `llm.model` | `model: string` | passed through verbatim; rerouting is a pass |
| `llm.temperature` | `value: number` | no range rescaling — a legalization's job if a target needs it |
| `llm.max_output_tokens` | `value: number` | openai `max_tokens`/`max_completion_tokens`, anthropic `max_tokens` |
| `llm.text` | `role: "system"\|"user"\|"assistant"`, `content: string` | one op per text unit; grouping into wire messages is the dialect's job |
| `llm.tool` | `name`, `description?`, `inputSchema: JsonSchema` | a tool the model may call |
| `llm.tool_choice` | `value: "auto"\|"none"\|"required"\|{ name }` | anthropic `any` ⇄ `required` |
| `llm.tool_call` | `id`, `name`, `arguments: object` | **always a parsed object.** openai's JSON-string arguments are parsed at raise (throwing on garbage) and re-stringified at lower |
| `llm.tool_result` | `id`, `content: string`, `isError?` | `id` matches the `llm.tool_call.id` |
| `llm.output` | `format: "json_schema"`, `name`, `schema` | structured output. Dialects without an equivalent lint rather than drop |

## `response.*` — response semantics

| op | fields | notes |
|---|---|---|
| `response.stop` | `reason: "end_turn"\|"max_tokens"\|"tool_use"\|"stop_sequence"` | dialects map their enum onto this; unmapped values throw |
| `response.usage` | `inputTokens?`, `outputTokens?` | cross-provider counts only. Vendor detail (cache hits, totals) stays in the stream as a `{ required: false }` residual on the source dialect's usage op |

Assistant output is not a special type: a response raises to `llm.text` /
`llm.tool_call` ops, which is what makes `append(request, ...response)` the
whole chaining story. When a request program is lowered, `response.*` ops are
stripped (bookkeeping doesn't get re-sent).

## `meta.*` — host semantics

| op | fields | notes |
|---|---|---|
| `meta.trace` | `traceId: string` | host-side correlation; stripped before any wire |

## Growing the core IR

Add a core op only for a concept at least two providers share (thinking
budgets, images, stop sequences are natural next candidates). One-provider
concepts stay dialect ops — that's what residuals are for. When adding one:
extend `CoreOp` in `src/core/ops.ts`, then teach each dialect's converters
about it; `toWire`'s strictness means unhandled programs fail loudly, not
silently.
