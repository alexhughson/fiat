# Fiat

Fiat is:

1. An alternative schema for LLM prompts/requests
2. Functions to convert to AND from major LLM APIs and this alternative schema

The prompt schema looks like this:

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

It also covers responses from LLMs, which have an aligned schema:

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

You can convert correct prompt payloads for LLM providers into this format:

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

And convert the fiat schema into any LLM provider formats:

```javascript
import { AnthropicTranslator } from "metamodel"

AnthropicTranslator.toBody(program)
// =>
{
  model: "gpt-4o",          // rerouting the model is a one-line transform
  max_tokens: 4096,          // filled in by a legalization — anthropic requires it
  system: "You are an omniscient AI",
  messages: [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    { role: "assistant", content: [{ type: "text", text: "I am an omniscient ai" }] },
  ],
}
```

Or compose the two edges directly:

```javascript
import { AnthropicTranslator, OpenAIChatTranslator } from "metamodel";

const anthropicBody = AnthropicTranslator.toBody(
    OpenAIChatTranslator.fromBody(openaiBody),
);
const openaiResponse = OpenAIChatTranslator.toResponse(
    AnthropicTranslator.fromResponse(anthropicResponse),
);
```

For streamed responses, compose `fromStreamResponse(...)` with
`toStreamResponse(...)` one provider chunk/event at a time. The library
handles the payload shape conversion, but it does not open SSE connections or
websocket sessions for you.

Available translator wrappers:

| Export                      | Wire dialect             | 
| --------------------------- | ------------------------ | 
| `OpenAIChatTranslator`      | OpenAI Chat Completions  | 
| `OpenAIResponsesTranslator` | OpenAI Responses         | 
| `OpenAIRealtimeTranslator`  | OpenAI Realtime          | 
| `AnthropicTranslator`       | Anthropic Messages       | 
| `GeminiTranslator`          | Gemini `generateContent` | 

Each wrapper exposes the same conversion methods:

```js
Translator.fromBody(body); // request wire payload -> core IR
Translator.toBody(program); // core IR -> request wire payload
Translator.fromResponse(response); // response wire payload -> core IR
Translator.toResponse(program); // core IR -> response wire payload
Translator.fromStreamResponse(event); // one stream event/chunk -> core IR
Translator.toStreamResponse(program); // core IR -> one stream event/chunk
Translator.toStreamResponses(program); // core IR -> stream event/chunk list
```

This gives us some nice benefits:

- You can write pure transforms against the fiat format, and apply them to prompts against any LLM provider
- You can build endpoints that accept and return the signature of any llm provider, backed by your own routing and transformation logic.  Build your own LiteLLM 
- Responses can be directly appended to existing requests, so mutations read a lot more simple

## Why?

If you've built an LLM backed app, I am sure that you have built some system to allow you to route the same LLM prompt to different providers.

There are a lot of libraries that abstract on top of all the LLM providers, but they take a lot out of your hands and you are dependent on the library for any feature you want.

Fiat:

- only covers structuring the data, so you can control how the calls actually get made.
- Is a tool rather than an abstraction, so if there is something truly weird you want to do, you can still make those modifications.
- Has an explicit way of adding provider specific data, so you can have full fidelity calls to particular providers, and best effort porting to another if you want.


## How it works

