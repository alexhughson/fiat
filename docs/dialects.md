# Dialects

A dialect is one endpoint's lower IR plus codecs for requests, responses, and
optional stream events.

```ts
export const OpenAIChatDialect = {
    name: "openai_chat",
    request: { fromWire, toWire, raise, lower, legalizations },
    response: { fromWire, toWire, raise, lower },
    responseStream: { fromWire, toWire, raise, lower },
} satisfies Dialect;
```

## Edges

| edge       | direction          | job                                                     |
| ---------- | ------------------ | ------------------------------------------------------- |
| `fromWire` | wire -> program    | parse and flatten provider payloads                     |
| `raise`    | program -> program | map owned dialect ops to core ops; leave residuals      |
| `lower`    | program -> program | map core ops to the target dialect's wire-shaped ops    |
| `toWire`   | program -> wire    | serialize; throw on any target-owned op it cannot write |

`responseStream` uses the same edges one event/chunk at a time.

A `responseStream` codec may also define `splitEvents`. One chunk of one
provider's stream can lower to a program that the target stream sends as more
than one event: a Gemini chunk holds text and `finishReason` together, and an
`openai_responses` stream sends a text delta event and then a terminal event.
`splitEvents` receives the lowered program and returns the ops of each event,
in the order the stream sends the events. `toWire` then serializes each
returned program as one event. `openai_responses` and `openai_realtime` define
`splitEvents`. For such a program `toStreamResponses` returns every event.

`toStreamResponse` returns one event and does not call `splitEvents`: it passes
the whole lowered program to `toWire`. The stream `toWire` functions of
`openai_responses` and `openai_realtime` throw a `LintError` for a program that
holds a delta and a stop reason, because one event cannot hold both. Each
dialect decides this in its own `toWire`; the shared pipeline rejects nothing.

## Stage pipelines

`raise` and `lower` are composed from `Stage` functions:

```ts
type Stage = (program: Program, target?: Target) => Program;
```

Most stages rewrite one op kind and pass everything else through. Cross-op
stages are used only when the wire shape depends on neighboring ops, such as
merging adjacent same-role Anthropic messages or folding OpenAI tool calls
into the preceding assistant message.

Per-call extensions belong in:

- `beforeRaise`
- `afterRaise`
- `beforeLower`
- `afterLower`

Do not mutate exported stage arrays after import; `stagePipeline` snapshots
them.

## When to define a dialect op

Use the first matching rule:

1. One-to-one wire field -> core op.
   Example: `model` -> `llm.model`.
2. Wire structure core reshapes -> named dialect op.
   Example: `openai_chat.message`.
3. Known provider-only data -> named dialect op.
   Example: `anthropic_messages.output_config`.
4. Unknown top-level field -> `<dialect>.body_field`.

Known payloads should not hide in `body_field`.

## Dialect docs

- [openai_chat](dialects/openai_chat.md)
- [openai_responses](dialects/openai_responses.md)
- [anthropic_messages](dialects/anthropic_messages.md)
- [gemini](dialects/gemini.md)
- [openai_realtime](dialects/openai_realtime.md)
