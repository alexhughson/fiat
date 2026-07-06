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
import { OpenAIChatTranslator } from "fiat"

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
import { AnthropicTranslator } from "fiat"

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

Which means that you can port request bodies from one API format to another.

```javascript
import { AnthropicTranslator, OpenAIChatTranslator } from "fiat";

const anthropicBody = AnthropicTranslator.toBody(
    OpenAIChatTranslator.fromBody(openaiBody),
);
const openaiResponse = OpenAIChatTranslator.toResponse(
    AnthropicTranslator.fromResponse(anthropicResponse),
);
```

## Examples

There are a few example tools using fiat in the `examples/` folder.

### Anthropic do no Evil router

Inspired by the safeguards around Fable, `examples/anthropic-evil-router.ts` exposes an Anthropic compatible endpoint.  It passes requests straight through to Anthropic _unless_ there is any mention of evil.  Requests that mention evil are served by Google Gemini, which should do a much worse job of whatever evil task is being asked.

### OpenAI realtime over completions

`examples/openai-realtime-chat-server.ts` exposes an OpenAI completions endpoint, but allows you to use OpenAIs realtime models.  I built it because I was wondering if the realtime models could get below the 1s minimum execution time on major LLM APIs.  They can't.

### Anthropic OpenAI proxy

`examples/anthropic-openai-proxy.ts` is a super simple server which exposes the Anthropic APi but is backed by gpt-5.5.  It works with Claude code, and is pretty simple.

### CLI Chat

There is a small CLI chat app in `examples/cli-chat.ts`


## API Specific concepts

Some concepts exist only in one API, or cannot be converted losslessly between different APIs.  In those cases Fiat includes endpoint specific operations.  

So for Anthropic cache control on a message, there is a modifier operation:

```
{
    op: "llm.text",
    role: "user",
    content: "refund invoice inv_1001 if it was paid twice.",
},
{
    op: "anthropic_messages.text_meta",
    fields: { cache_control: { type: "ephemeral" } },
},
```

When you convert this payload to a non anthropic endpoint, the anthropic cache control data will be lost, but it is still readable by anthropic backends.

## Model particularities

As much as possible, fiat will try to map `llm.*` operations to the best possible match for a given model/endpoint.

So where there are a million different ways of expressing thinking effort, fiat will attempt to map the `none`, `minimal`, `low`, `medium`, `high`, `xhigh` gradiant as closely as possible to what the model supports. 


## Available translator wrappers:

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

## Why?

If you've built an LLM backed app, I am sure that you have built some system to allow you to route the same LLM prompt to different providers.

There are plenty of libraries that try to abstract the whole inference system, but I find that they take too much control away.  They bound you by what the library abstracts.  The goal of Fiat is to give you the tools to convert payloads, but let you do what you like with that data.

Fiat:

- only covers structuring the data, so you can control how the calls actually get made.
- Is a tool rather than an abstraction, so if there is something truly weird you want to do, you can just do it.
- Has an explicit way of adding provider specific data, so you can have full fidelity calls to particular providers, and best effort porting to another if you want.


This gives us some nice benefits:

- You can write pure transforms against the fiat format, and apply them to prompts against any LLM provider
- You can build endpoints that accept and return the signature of any llm provider, backed by your own routing and transformation logic.  Build your own LiteLLM 
- Responses can be directly appended to existing requests, so mutations read a lot more simple

## Install

Install version `0.1` directly from the GitHub repo:

```bash
npm install github:alexhughson/fiat#v0.1
pnpm add github:alexhughson/fiat#v0.1
yarn add github:alexhughson/fiat#v0.1
```

To follow `main` instead:

```bash
npm install github:alexhughson/fiat#main
```

Then import the package as `fiat`:

```js
import { OpenAIChatTranslator } from "fiat";
```