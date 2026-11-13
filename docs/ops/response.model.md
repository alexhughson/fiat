# response.model

`response.model` is the model that a provider's API reports as the one that
answered. `llm.model` is the model that a request asks for. The two names
differ when a request for an alias such as `claude-sonnet-4-5` is answered by
the dated model `claude-sonnet-4-5-20250929`.

```ts
{
    op: "response.model";
    model: string;
}
```

The param is required. Every dialect writes `model` unchanged, so a response
body of one provider can name a model of another provider. When a program
holds several `response.model` ops, the last one is written.

| dialect              | where a response names the model                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic_messages` | top-level `model` of a response body, and `message.model` of the `message_start` event that fiat writes when it lowers a whole response to stream events |
| `openai_chat`        | top-level `model` of a response body and of every stream chunk                                                                                           |
| `openai_responses`   | top-level `model` of a response body; in a stream, `response.model` of `response.completed`, `response.incomplete`, and `response.failed`                |
| `gemini`             | top-level `modelVersion` of a response body and of every stream chunk                                                                                    |
| `openai_realtime`    | see below                                                                                                                                                |

The `RealtimeResponse` type of OpenAI's SDK `openai-node`, which is the
type of the `response` of a `response.done` event, lists no `model`. A
whole `openai_realtime` response body is a batch of events. When the
`response` of the `response.done` event in that batch holds a `model`, fiat
raises `response.model` from it, and fiat writes `response.model` to the
same place. For an `openai_realtime` stream event, fiat raises no
`response.model` and writes none from a `response.model` op. When a stream
`response.done` event holds a `model`, that `model` stays inside the
`openai_realtime.event_param` op for `response`, so fiat writes it back when
it lowers the program to `openai_realtime`, and no other dialect receives it.

`AnthropicTranslator.fromStreamResponse` throws for a `message_start` event,
so fiat raises no `response.model` from an Anthropic stream. When a stream
event has no field for the model, such as a `response.output_text.delta`
event of `openai_responses`, lowering removes `response.model`.

Each example below is one run of the code. Examples 1 and 2 show a response
body, the program that the body raises to, the program after lowering to the
target lower dialect, and the response body that fiat writes from the lower
program. Each **In** body is a reduced fixture in the shape of the provider's
API, not a body recorded from the API.

The runs are for three proxies:

- The Anthropic-to-Chat proxy is a proxy which exposes Anthropic's Messages API
  to its client, sends each request body it receives to OpenAI's Chat
  Completions API as a Chat Completions request body, and returns each response
  body of OpenAI's API to its client as an Anthropic response body.
- The Gemini-to-Anthropic proxy is a proxy which exposes Gemini's
  `generateContent` API to its client, sends each request body it receives to
  Anthropic's Messages API as an Anthropic request body, and returns each
  response body of Anthropic's API to its client as a Gemini response body.
- The conversation proxy is a proxy which holds one conversation with OpenAI's
  Chat Completions API as one program. The conversation proxy raises its first
  request body, appends the ops raised from each response body of OpenAI's API,
  appends each new user text, and lowers the whole program to the next request
  body.

## Example 1: a Chat Completions response, returned as an Anthropic response

**In**: the whole response body that OpenAI's API returns to the
Anthropic-to-Chat proxy.

```json
{
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 1700000000,
    "model": "gpt-4o-2024-08-06",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "hello"
            },
            "finish_reason": "stop",
            "logprobs": null
        }
    ],
    "usage": {
        "prompt_tokens": 8,
        "completion_tokens": 2,
        "total_tokens": 10
    }
}
```

**Raised**: the whole program that `OpenAIChatTranslator.fromResponse` returns
for that response body.

```json
[
    {
        "op": "response.id",
        "id": "chatcmpl-1"
    },
    {
        "op": "openai_chat.body_field",
        "key": "object",
        "value": "chat.completion",
        "appliesTo": "response"
    },
    {
        "op": "openai_chat.body_field",
        "key": "created",
        "value": 1700000000,
        "appliesTo": "response"
    },
    {
        "op": "response.model",
        "model": "gpt-4o-2024-08-06"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    },
    {
        "op": "response.usage",
        "inputTokens": 8,
        "outputTokens": 2
    },
    {
        "op": "openai_chat.usage",
        "usage": {
            "total_tokens": 10
        },
        "appliesTo": "response"
    }
]
```

**Lower**: the whole program that the lower step of
`AnthropicTranslator.toResponse` returns for the raised program, read through
the `afterLower` hook of `toResponse`. After the lower step,
`dropForeignResiduals` removes the three `openai_chat.*` ops and warns, and
fiat writes the response body from the ops that are left.

```json
[
    {
        "op": "response.id",
        "id": "chatcmpl-1"
    },
    {
        "op": "openai_chat.body_field",
        "key": "object",
        "value": "chat.completion",
        "appliesTo": "response"
    },
    {
        "op": "openai_chat.body_field",
        "key": "created",
        "value": 1700000000,
        "appliesTo": "response"
    },
    {
        "op": "response.model",
        "model": "gpt-4o-2024-08-06"
    },
    {
        "op": "anthropic_messages.stop_reason",
        "value": "end_turn"
    },
    {
        "op": "anthropic_messages.usage",
        "usage": {
            "input_tokens": 8,
            "output_tokens": 2
        }
    },
    {
        "op": "openai_chat.usage",
        "usage": {
            "total_tokens": 10
        },
        "appliesTo": "response"
    },
    {
        "op": "anthropic_messages.message",
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "hello"
                }
            ]
        }
    }
]
```

**Out**: the whole response body that `AnthropicTranslator.toResponse` returns
for the raised program, and that the Anthropic-to-Chat proxy returns to its
client.

```json
{
    "id": "chatcmpl-1",
    "model": "gpt-4o-2024-08-06",
    "stop_reason": "end_turn",
    "usage": {
        "input_tokens": 8,
        "output_tokens": 2
    },
    "type": "message",
    "role": "assistant",
    "content": [
        {
            "type": "text",
            "text": "hello"
        }
    ]
}
```

## Example 2: an Anthropic response, returned as a Gemini response

**In**: the whole response body that Anthropic's API returns to the
Gemini-to-Anthropic proxy.

```json
{
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-4-5-20250929",
    "content": [
        {
            "type": "text",
            "text": "hello"
        }
    ],
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {
        "input_tokens": 8,
        "output_tokens": 2
    }
}
```

**Raised**: the whole program that `AnthropicTranslator.fromResponse` returns
for that response body.

```json
[
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.id",
        "id": "msg_1"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "type",
        "value": "message",
        "appliesTo": "response"
    },
    {
        "op": "response.model",
        "model": "claude-sonnet-4-5-20250929"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "stop_sequence",
        "value": null,
        "appliesTo": "response"
    },
    {
        "op": "response.usage",
        "inputTokens": 8,
        "outputTokens": 2
    }
]
```

**Lower**: the whole program that the lower step of
`GeminiTranslator.toResponse` returns for the raised program, read through the
`afterLower` hook of `toResponse`. After the lower step,
`dropForeignResiduals` removes the two `anthropic_messages.*` ops and warns,
and fiat writes the response body from the ops that are left.

```json
[
    {
        "op": "response.id",
        "id": "msg_1"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "type",
        "value": "message",
        "appliesTo": "response"
    },
    {
        "op": "response.model",
        "model": "claude-sonnet-4-5-20250929"
    },
    {
        "op": "gemini.finish_reason",
        "value": "STOP"
    },
    {
        "op": "anthropic_messages.body_field",
        "key": "stop_sequence",
        "value": null,
        "appliesTo": "response"
    },
    {
        "op": "gemini.usage",
        "usage": {
            "promptTokenCount": 8,
            "candidatesTokenCount": 2
        }
    },
    {
        "op": "gemini.content",
        "content": {
            "role": "model",
            "parts": [
                {
                    "text": "hello"
                }
            ]
        },
        "appliesTo": "response"
    }
]
```

**Out**: the whole response body that `GeminiTranslator.toResponse` returns for
the raised program, and that the Gemini-to-Anthropic proxy returns to its
client. Gemini's field for the model that answered is `modelVersion`.

```json
{
    "responseId": "msg_1",
    "modelVersion": "claude-sonnet-4-5-20250929",
    "candidates": [
        {
            "content": {
                "role": "model",
                "parts": [
                    {
                        "text": "hello"
                    }
                ]
            },
            "finishReason": "STOP"
        }
    ],
    "usageMetadata": {
        "promptTokenCount": 8,
        "candidatesTokenCount": 2
    }
}
```

## The next request

If a raised response is appended to the program of its request, the program
holds both `llm.model` and `response.model`. Lowering that program to a
request body removes `response.model`, like every other `response.*` op, so
the request body asks for the model in `llm.model`.

**In**: the whole program that the conversation proxy passes to
`OpenAIChatTranslator.toBody` for its second request. The program holds, in
this order: the ops that `OpenAIChatTranslator.fromBody` returns for the first
request body that the conversation proxy sent to OpenAI's API, which asks for
`gpt-4o`; the **Raised** program of Example 1; and one `llm.text` op for the
next user text.

```json
[
    {
        "op": "llm.model",
        "model": "gpt-4o"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "hi"
    },
    {
        "op": "response.id",
        "id": "chatcmpl-1"
    },
    {
        "op": "openai_chat.body_field",
        "key": "object",
        "value": "chat.completion",
        "appliesTo": "response"
    },
    {
        "op": "openai_chat.body_field",
        "key": "created",
        "value": 1700000000,
        "appliesTo": "response"
    },
    {
        "op": "response.model",
        "model": "gpt-4o-2024-08-06"
    },
    {
        "op": "llm.text",
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    },
    {
        "op": "response.usage",
        "inputTokens": 8,
        "outputTokens": 2
    },
    {
        "op": "openai_chat.usage",
        "usage": {
            "total_tokens": 10
        },
        "appliesTo": "response"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "thanks"
    }
]
```

**Out**: the whole request body that `OpenAIChatTranslator.toBody` returns for
that program, and that the conversation proxy sends to OpenAI's API.

```json
{
    "model": "gpt-4o",
    "messages": [
        {
            "role": "user",
            "content": "hi"
        },
        {
            "role": "assistant",
            "content": "hello"
        },
        {
            "role": "user",
            "content": "thanks"
        }
    ]
}
```
