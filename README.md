# metamodel

Metamodel is:

1. An alternative schema for LLM requests
2. Functions to convert to AND from major LLM APIs and this alternative schema

It looks like this:

```javascript
[
    { op: "llm.model", model: "gpt-5.5" },
    {
        op: "llm.text",
        role: "user",
        content: "My last invoice looks wrong. Was I double charged?",
    },
];
```

It also covers responses from LLMs, which have an aligq`ned schema:

```javascript
[
    {
        op: "llm.text",
        role: "assistant",
        content: "No, it is correct, things are more expensive these days",
    },
    { op: "response.stop", reason: "end_turn" },
    { op: "response.usage", inputTokens: 20, outputTokens: 9 },
];
```

You can convert payloads for LLM providers into this format:

```js
import { OpenAIChatTranslator } from "metamodel"

const program = OpenAIChatTranslator.fromBody({
  model: "gpt-4o",
  messages: [
    { role: "system", content: "You are an omniscient AI" },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "I am an omniscient ai" },
  ],
})
// =>
[
  { op: "llm.model", model: "gpt-4o" },
  { op: "llm.text", role: "system", content: "You are an omniscient AI" },
  { op: "llm.text", role: "user", content: "Hello" },
  { op: "llm.text", role: "assistant", content: "I am an omniscient ai" },
]
```

And convert this representation into other LLM provider formats:

```javascript
import { AnthropicTranslator } from "metamodel"

AnthropicTranslator.toBody(program)
// =>
{
  model: "gpt-4o",          // rerouting the model is a one-line pass
  max_tokens: 4096,          // filled in by a legalization — anthropic requires it
  system: "You are an omniscient AI",
  messages: [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    { role: "assistant", content: [{ type: "text", text: "I am an omniscient ai" }] },
  ],
}
```

Or do the whole wire-to-wire hop in one call:

```javascript
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    translateRequest,
    translateResponse,
} from "metamodel";

const anthropicBody = translateRequest(openaiBody, {
    from: OpenAIChatTranslator,
    to: AnthropicTranslator,
});
const openaiResponse = translateResponse(anthropicResponse, {
    from: AnthropicTranslator,
    to: OpenAIChatTranslator,
});
```

This gives us some nice benefits:

- You can write pure transforms against one format, and apply them to prompts against any LLM provider
- You can build endpoints that accept and return OpenAI compatible payloads, backed by your own routing and transformation logic
- Responses can be directly appended to requests, making it easy to append/log chat chains

## Why?

We have all built variants of this over and over again.

Just about every existing tool tries to abstract away too much, looping in
the API connection, assuming that you want to call tools which are functions
in a loop, locking you into their design decisions.

What we actually need is just a super flexible IR, working translators for
major providers, and the ability to bend the tool to our needs when stuff
gets weird.

## How it works

MLIR-style, two levels. A shared **core IR** (`llm.*`, `response.*`,
`meta.*` ops) carries everything providers have in common. Each endpoint has
a **dialect** — a lower IR high-fidelity to that API — and four converters:

```
wire ⇄ (fromWire/toWire) ⇄ lower IR ⇄ (raise/lower) ⇄ core IR
```

Endpoint-only constructs survive raising as **residual ops** in the stream:
going back to their home dialect they round-trip losslessly; going to a
foreign dialect the pipeline halts unless they're marked droppable or a pass
consumes them. Endpoint/model quirks live in **legalization passes**; when a
rewrite would change the request's meaning, a **lint** raises instead.
Nothing is ever dropped silently.

Docs:

- [docs/architecture.md](docs/architecture.md) — the pipeline, residuals, passes
- [docs/core-ir.md](docs/core-ir.md) — the core op catalog
- [docs/dialects.md](docs/dialects.md) — the dialect contract
- [docs/adding-features.md](docs/adding-features.md) — **the cookbook: where every kind of change goes**

## Development

```bash
bun install
bun test            # unit suites + live API suites (live ones skip without keys)
bunx tsc --noEmit   # typecheck
bun run e2e:gemini # on-demand Gemini validation; writes e2e/gemini/output/latest
bun run e2e:openai-realtime:validate # offline Realtime artifact validation
```

`bun test` reads provider keys from `.env` (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`); with keys present it proves the
translators against the real APIs, including an openai-in/anthropic-backend
proxy flow. The unit tests in `test/` are written as executable
documentation — read them as examples.

Gemini and OpenAI Realtime have separate e2e harnesses in [e2e/gemini](e2e/gemini)
and [e2e/openai_realtime](e2e/openai_realtime). They save readable
request/response/core artifacts and validate them later with
`bun run e2e:gemini:validate` or `bun run e2e:openai-realtime:validate`.

## Status

Dialects: `openai_chat`, `openai_responses`, `openai_realtime`,
`anthropic_messages`, `gemini` — text, tools, tool choice, usage/stop
mapping, request, response, response-stream conversion where the provider
supports them, structured output, and portable thinking effort where an
endpoint has a documented control. Not yet modeled: streaming transport,
images, and returned thinking content.
