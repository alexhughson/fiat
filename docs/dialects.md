# Dialects

A dialect is one provider endpoint's lower IR plus the converters that move
programs between the wire and the core IR. The contract is
`Dialect` in `src/core/registry.ts`:

```ts
export const OpenAIChatDialect = {
    name: "openai_chat", // also the op namespace: openai_chat.*
    request: { fromWire, toWire, raise, lower, legalizations },
    response: { fromWire, toWire, raise, lower },
    responseStream: { fromWire, toWire, raise, lower },
} satisfies Dialect;

export const OpenAIChatTranslator = makeTranslator(OpenAIChatDialect);
```

## The four edges

| function   | direction         | job                                                                                                                                                                                  | strictness                               |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `fromWire` | wire → program    | mechanical flattening. Emit core ops for trivially bijective fields, named dialect ops for known provider payloads, and `<dialect>.body_field` only for unknown top-level keys       | throw on malformed input                 |
| `raise`    | program → program | pipeline of stages rewriting own dialect ops into core ops (ungroup messages, map enums, parse argument strings). Leave endpoint-only ops as residuals. Pass through everything else | throw on unmappable values               |
| `lower`    | program → program | inverse of raise: pipeline of stages regrouping core conversation ops into wire message structure. Pass through everything else                                                      | lint core ops the endpoint can't express |
| `toWire`   | program → wire    | assemble the body. **Final gate: throw on any op with no serialization**                                                                                                             | never skip an op silently                |

Each dialect module exports one dialect object and one translator wrapper.
Callers compose wrappers directly, for example
`translateRequest(body, { from: OpenAIChatTranslator, to: AnthropicTranslator })`.
There is no import-time registration or string-name lookup.

`responseStream` is the same four-edge pipeline applied to one provider
stream payload at a time. For example, an OpenAI Chat chunk with
`choices[0].delta.content = "hi"` raises to
`response.text_delta { role: "assistant", content: "hi" }`; an Anthropic
`input_json_delta.partial_json = "{\"x\""` raises to
`response.tool_call_delta { arguments: "{\"x\"" }` without trying to parse
the incomplete JSON.

## raise and lower are stage pipelines

`raise` and `lower` are not switch statements — they are pipelines of
`Stage` functions (`Stage = (program: Program, target?: Target) => Program`,
composed with `stagePipeline` from `src/core/rewrite.ts`). Each dialect exports its stage
arrays (`raiseStages`, `lowerRequestStages`, `lowerResponseStages`);
`stagePipeline` reads the array on every call, so appending a stage after
import extends the codec without touching existing code.

Two kinds of stage, by convention:

- **Per-op stage** — a `flatMap` that rewrites one op kind and passes
  everything else through (`raiseMessages`, `lowerToolCalls`). This is the
  default; a partially raised or partially lowered program is still a valid
  program, so each stage can do exactly one job.
- **Cross-op stage** — used only when the rewrite is inherently about op
  _sequences_: merging adjacent same-role messages (`mergeAdjacentSameRole`),
  folding tool calls into the preceding assistant message
  (`mergeToolCallMessages`), collecting a whole response into one wire
  message (`collectAssistantMessage`), or order lints
  (`lintMidConversationSystem`).

When a new quirk shows up (a model that rejects a provider field, a construct that
needs reshaping), it becomes one new small stage appended to the right
array — existing stages never grow.

## When does a wire construct get a dialect op?

Apply in order; first match wins:

1. **Trivially bijective rename of one core op** (model, temperature, token
   caps, tool definitions, tool_choice) → no dialect op. `fromWire` emits the
   core op; `toWire` serializes it.
2. **Structure the core IR reshapes** (message grouping, embedded tool
   calls, block lists, provider enums) → dialect op holding the wire shape
   verbatim; `raise`/`lower` own the mapping.
3. **Known endpoint-only construct** → named dialect op that survives raise
   as a residual. For example, Anthropic `output_config` becomes
   `anthropic_messages.output_config`, Gemini `toolConfig` leftovers become
   `gemini.tool_config`, and OpenAI Responses provider-specific tool choices
   become `openai_responses.tool_choice`.
4. **Unknown top-level field** → `<dialect>.body_field { key, value }`.
   This is the only generic bag. A known payload should not hide in it.

## Residual conventions every dialect must follow

- Request body fields default to **required** (translation to a foreign dialect
  halts unless a pass consumes them or marks `required: false`).
- Response envelope bookkeeping (`id`, `created`, `type`, ...) is born
  `appliesTo: "response", required: false`.
- Vendor usage detail beyond input/output counts goes back into the stream
  as `{ op: "<dialect>.usage", usage: <extras>, appliesTo: "response", required: false }`;
  the home dialect's response `toWire` merges all usage ops into one wire
  object. Because these ops apply only to responses, appending a response
  program to a request does not resend them.

## Existing dialects

- [`openai_chat`](dialects/openai_chat.md) — OpenAI Chat Completions
- [`openai_responses`](dialects/openai_responses.md) — OpenAI Responses
- [`anthropic_messages`](dialects/anthropic_messages.md) — Anthropic Messages
- [`gemini`](dialects/gemini.md) — Gemini Generate Content
- [`openai_realtime`](dialects/openai_realtime.md) — OpenAI Realtime event wire

The HTTP-body dialects support text conversations, tool definitions/calls/results,
tool choice, usage/stop mapping, and response-stream chunk conversion. The
Realtime dialect supports text event batches, final `response.done` events,
stream text/tool deltas, and home round-trip preservation for realtime-only
item/content metadata such as audio parts. Audio and images are not
cross-provider core ops.
