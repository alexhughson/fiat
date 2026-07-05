# Architecture

Metamodel is built MLIR-style: one shared **core IR**, plus one **dialect**
(lower IR) per provider endpoint. Every request and response is a _program_ —
a flat JSON array of _ops_ — at every stage. A proxy that accepts openai_chat
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
  │ legalizations   (anthropic request codec) endpoint/model conformance transforms
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

Because passthrough is universal, a _partially_ raised or lowered program is
still a valid program — which is why `raise` and `lower` are pipelines of
small `Stage` functions (`src/core/rewrite.ts`), each rewriting one op kind,
rather than monolithic switches. Extending a conversion means passing a
custom stage via the `beforeRaise`/`afterRaise`/`beforeLower`/`afterLower`
hooks (`src/core/pipeline.ts`); see
[dialects.md](dialects.md#raise-and-lower-are-stage-pipelines).

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
- **Wrong direction, `appliesTo` set**: stripped before lowering. A response
  residual such as `openai_chat.usage { appliesTo: "response" }` round-trips
  through `toResponse`, but does not get sent when the same response program
  is appended to a request for the next turn.
- Any dialect can register a legalization that consumes another dialect's residual
  and maps it onto its own ops — that is the interop escape hatch.

## Legalizations

Registered legalizations live on the request/response codec they apply to, and
receive `Target { dialect, kind, model, strict }`. They are plain functions
run left to right after lowering. Two conventions:

- **transform / legalize**: rewrite toward what the target accepts. Example:
  `anthropic_messages.default-max-tokens` inserts the required `max_tokens`
  cap on requests (`src/dialects/anthropic_messages/legalize.ts`).
- **strict lint**: when callers pass `{ strict: true }`, throw `LintError`
  for unsupported request controls that default legalization would otherwise
  clean up. Example: `top_p` on a Claude model that no longer accepts explicit
  sampling params.

Hard representational failures are still errors in every mode. Example:
`llm.output` reaching a dialect with no output-schema wire home throws during
lowering.

Caller transforms run on the core IR between raise and lower. For edge-local
customization, the half-pipeline APIs also accept pure `Stage` hooks:
`beforeRaise`/`afterRaise` around a dialect's raise edge, and
`beforeLower`/`afterLower` around its lower edge. These hooks only see the op
stream for that edge; for example, `anthropic_messages` raise does not know
whether the program will later lower to OpenAI, Gemini, or Anthropic again.

A dialect's registered `legalizations` run after `lower` and `afterLower`,
before `toWire`. `toWire` itself is the final gate: it throws on any op it
can't serialize.

## Host ops

`meta.*` ops address the host (trace ids, routing hints), never a provider.
The pipeline strips them before lowering. In request programs it also strips
`response.*` ops and response-only dialect residuals — the artifact of
appending a response for chaining.

## Failure posture

No silent fallbacks anywhere: malformed wire input, unparseable tool-call
arguments, unmappable enum values, and unconsumed residuals all throw. If a
translation succeeds, it means everything in the source either mapped, was
explicitly marked droppable, or round-trips losslessly.
