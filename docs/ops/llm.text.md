# llm.text

`llm.text` is one piece of text in a conversation. `role` says whether the
text is an instruction to the model (`system`), input from the user (`user`),
or output of the model (`assistant`), and `content` is the text.

```ts
{
    op: "llm.text";
    role: "system" | "user" | "assistant";
    content: string;
}
```

Both params are required.

Each example below is one run of the code. It shows a request body, the program
that the body raises to, the program after lowering to the
[lower dialect](../higher-and-lower-dialects.md) of the API that receives the
request, and the request body that fiat writes from the lower program. A
translator's `toBody` function lowers the program and writes the request body in
one call, so the program after lowering is read through the `afterLower` hook of
`toBody`.

The runs are for two proxies:

- The Chat-to-Anthropic proxy is a proxy which exposes OpenAI's Chat
  Completions API to its client, sends each request body it receives to
  Anthropic's Messages API as an Anthropic request body, and returns each
  response body of Anthropic's API to its client as a Chat Completions response
  body.
- The Anthropic-to-Chat proxy is a proxy which exposes Anthropic's Messages API
  to its client, sends each request body it receives to OpenAI's Chat
  Completions API as a Chat Completions request body, and returns each response
  body of OpenAI's API to its client as an Anthropic response body.

## Example 1: `system` and `user` text, to Anthropic's Messages API

**In**: the whole request body that the client of the Chat-to-Anthropic proxy
sends to that proxy.

```json
{
    "model": "claude-sonnet-4-5",
    "max_tokens": 100,
    "messages": [
        {
            "role": "system",
            "content": "Answer in French."
        },
        {
            "role": "user",
            "content": "hi"
        }
    ]
}
```

**Raised**: the whole program that `OpenAIChatTranslator.fromBody` returns for
that request body.

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "llm.max_output_tokens",
        "value": 100
    },
    {
        "op": "llm.text",
        "role": "system",
        "content": "Answer in French."
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "hi"
    }
]
```

**Lower**: the whole program that the lower step of `AnthropicTranslator.toBody`
returns for the raised program. That lower step leaves the `system` text as an
`llm.text` op. `toWire`, the step of `toBody` that writes the request body,
writes the content of that op to `system`, as the **Out** block shows.

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
    },
    {
        "op": "llm.max_output_tokens",
        "value": 100
    },
    {
        "op": "llm.text",
        "role": "system",
        "content": "Answer in French."
    },
    {
        "op": "anthropic_messages.message",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "hi"
                }
            ]
        }
    }
]
```

**Out**: the whole request body that `AnthropicTranslator.toBody` returns for
the raised program, and that the Chat-to-Anthropic proxy sends to Anthropic's
API.

```json
{
    "model": "claude-sonnet-4-5",
    "max_tokens": 100,
    "system": "Answer in French.",
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "hi"
                }
            ]
        }
    ]
}
```

## Example 2: `system`, `user`, and `assistant` text, to OpenAI's Chat Completions API

**In**: the whole request body that the client of the Anthropic-to-Chat proxy
sends to that proxy. The message with role `assistant` is a reply that the model
gave earlier in the conversation.

```json
{
    "model": "gpt-4o",
    "max_tokens": 100,
    "system": "Answer in French.",
    "messages": [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "hi"
                }
            ]
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "salut"
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "and in German?"
                }
            ]
        }
    ]
}
```

**Raised**: the whole program that `AnthropicTranslator.fromBody` returns for
that request body.

```json
[
    {
        "op": "llm.model",
        "model": "gpt-4o"
    },
    {
        "op": "llm.max_output_tokens",
        "value": 100
    },
    {
        "op": "llm.text",
        "role": "system",
        "content": "Answer in French."
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "hi"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "salut"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "and in German?"
    }
]
```

**Lower**: the whole program that the lower step of
`OpenAIChatTranslator.toBody` returns for the raised program.

```json
[
    {
        "op": "llm.model",
        "model": "gpt-4o"
    },
    {
        "op": "llm.max_output_tokens",
        "value": 100
    },
    {
        "op": "openai_chat.message",
        "message": {
            "role": "system",
            "content": "Answer in French."
        }
    },
    {
        "op": "openai_chat.message",
        "message": {
            "role": "user",
            "content": "hi"
        }
    },
    {
        "op": "openai_chat.message",
        "message": {
            "role": "assistant",
            "content": "salut"
        }
    },
    {
        "op": "openai_chat.message",
        "message": {
            "role": "user",
            "content": "and in German?"
        }
    }
]
```

**Out**: the whole request body that `OpenAIChatTranslator.toBody` returns for
the raised program, and that the Anthropic-to-Chat proxy sends to OpenAI's API.

```json
{
    "model": "gpt-4o",
    "max_tokens": 100,
    "messages": [
        {
            "role": "system",
            "content": "Answer in French."
        },
        {
            "role": "user",
            "content": "hi"
        },
        {
            "role": "assistant",
            "content": "salut"
        },
        {
            "role": "user",
            "content": "and in German?"
        }
    ]
}
```
