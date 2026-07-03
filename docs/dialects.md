# Dialects

A dialect is one provider endpoint's lower IR plus the four converters that
move programs between the wire and the core IR. The contract is
`Dialect` in `src/core/registry.ts`:

```ts
registerDialect({
  name: "openai_chat",            // also the op namespace: openai_chat.*
  request:  { fromWire, toWire, raise, lower },
  response: { fromWire, toWire, raise, lower },
  legalizations,                  // optional Pass[], run on lower IR before toWire
})
```

## The four edges

| function | direction | job | strictness |
|---|---|---|---|
| `fromWire` | wire → program | mechanical flattening. Emit core ops for trivially bijective fields, dialect ops for everything else, `<dialect>.param` for unknown keys | throw on malformed input |
| `raise` | program → program | rewrite own dialect ops into core ops (ungroup messages, map enums, parse argument strings). Leave endpoint-only ops as residuals. Pass through everything else | throw on unmappable values |
| `lower` | program → program | inverse of raise: regroup core conversation ops into wire message structure. Pass through everything else | lint core ops the endpoint can't express |
| `toWire` | program → wire | assemble the body. **Final gate: throw on any op with no serialization** | never skip an op silently |

Registration is the module's only side effect: `import "./dialects/foo"`
makes `getDialect("foo")`, `translateRequest`, and `makeTranslator("foo")`
work.

## When does a wire construct get a dialect op?

Apply in order; first match wins:

1. **Trivially bijective rename of one core op** (model, temperature, token
   caps, tool definitions, tool_choice) → no dialect op. `fromWire` emits the
   core op; `toWire` serializes it.
2. **Structure the core IR reshapes** (message grouping, embedded tool
   calls, block lists, provider enums) → dialect op holding the wire shape
   verbatim; `raise`/`lower` own the mapping.
3. **Endpoint-only construct** → dialect op that survives raise as a
   residual. Unknown body keys always become `<dialect>.param { key, value }`
   so nothing is ever dropped at parse time.

## Residual conventions every dialect must follow

- Request params default to **required** (translation to a foreign dialect
  halts unless a pass consumes them or marks `required: false`).
- Response envelope bookkeeping (`id`, `created`, `type`, ...) is born
  `required: false`.
- Vendor usage detail beyond input/output counts goes back into the stream
  as `{ op: "<dialect>.usage", usage: <extras>, required: false }`; the home
  dialect's `toWire` merges all usage ops into one wire object.

## Existing dialects

- [`openai_chat`](dialects/openai_chat.md) — OpenAI Chat Completions
- [`anthropic_messages`](dialects/anthropic_messages.md) — Anthropic Messages

Both support text conversations, tool definitions/calls/results, tool
choice, and usage/stop mapping. Streaming, images, and thinking are not yet
modeled anywhere.
