# Architecture

Metamodel is built MLIR-style: one shared **core IR**, plus one **dialect**
(lower IR) per provider endpoint. Every request and response is a *program* —
a flat JSON array of *ops* — at every stage. A proxy that accepts openai_chat
and runs on anthropic_messages is this pipeline:

```
openai wire body
  │ fromWire        (openai_chat)   mechanical flattening
  ▼
program: core ops + openai_chat.* ops
  │ raise           (openai_chat)   semantic mapping; endpoint-only ops stay as residuals
  ▼
program: core ops + residuals            ◄── your transforms/lints run here
  │ lower           (anthropic_messages) regroup core ops into wire structure
  ▼
program: core ops + anthropic_messages.* ops
  │ legalizations   (anthropic_messages) endpoint/model conformance passes
  │ residual lint   (pipeline)           foreign ops: drop if { required: false }, else halt
  │ toWire          (anthropic_messages) strict serialization
  ▼
anthropic wire body
```

Responses run the same pipeline through each dialect's `response` codec, and
share the core op vocabulary with requests — so a raised response can be
appended directly onto a request program to build the next turn.

## Programs are mixed-dialect

There is no separate "lower IR program" type. `fromWire` already emits core
ops for wire fields that are a trivially bijective rename of one core op
(`model` → `llm.model`, anthropic `max_tokens` → `llm.max_output_tokens`,
tool definitions, tool_choice). A dialect defines an op of its own **only**
when the wire construct is something the core IR reshapes or can't represent:

- structure the core IR deliberately flattens — message grouping, tool calls
  embedded in assistant messages, content block lists
- provider-specific enums that need mapping — `finish_reason`, `stop_reason`
- endpoint-only constructs — unknown params, vendor usage detail

Each converter rewrites only the ops it owns and passes everything else
through. This kills four redundant copy steps per trivial field and keeps
`raise`/`lower` small.

## Residuals: lossless by default, loud when lost

When `raise` meets an endpoint-only construct (`logit_bias`, a vendor usage
field), it leaves a dialect op in the core program instead of dropping it.
Rules, enforced by `lintForeignResiduals` in `src/core/pipeline.ts`:

- **Home dialect**: lowering back to the dialect that produced a residual
  consumes it losslessly (round-trips are exact).
- **Foreign dialect, `required` unset**: the translation **halts** with a
  `LintError`. Silent loss of meaning is never the default.
- **Foreign dialect, `required: false`**: dropped, by design. Ops born
  droppable: response envelope bookkeeping (`id`, `created`, `type`) and
  vendor usage detail (cross-provider counts already live in
  `response.usage`).
- Any dialect can register a pass that consumes another dialect's residual
  and maps it onto its own ops — that is the interop escape hatch.

## Passes

A pass is a named pure function `Program -> Program` (`src/core/pass.ts`),
scoped by a `Target { dialect, kind, model }`. Two conventions:

- **transform / legalize**: rewrite toward what the target accepts. Example:
  `anthropic_messages.default-max-tokens` inserts the required `max_tokens`
  cap on requests (`src/dialects/anthropic_messages/legalize.ts`).
- **lint**: rewrite nothing; throw `LintError` when conforming would change
  the request's meaning. Example: `llm.output` reaching anthropic lowering.

Caller passes run on the core IR between raise and lower. A dialect's
registered `legalizations` run after its `lower`, before `toWire`. `toWire`
itself is the final gate: it throws on any op it can't serialize.

## Host ops

`meta.*` ops address the host (trace ids, routing hints), never a provider.
The pipeline strips them before lowering. In request programs it also strips
`response.*` ops — the artifact of appending a response for chaining.

## Failure posture

No silent fallbacks anywhere: malformed wire input, unparseable tool-call
arguments, unmappable enum values, and unconsumed residuals all throw. If a
translation succeeds, it means everything in the source either mapped, was
explicitly marked droppable, or round-trips losslessly.
