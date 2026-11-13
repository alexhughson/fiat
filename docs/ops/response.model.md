# response.model

```ts
{
    op: "response.model";
    model: string;
}
```

## Example 1: the model that answered, in a response body

A proxy which exposes Anthropic's Messages API to its client and sends each
request on to OpenAI's Chat Completions API returns the Chat Completions
response to its client as an Anthropic response. The `openai_chat.*` ops in
**Lower** hold fields of the Chat Completions response that an Anthropic
response has no field for, so fiat writes none of them into **Out**.

**In**

```json
{
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 1700000000,
    "model": "gpt-4o-2024-08-06",
    "usage": {
        "prompt_tokens": 8,
        "completion_tokens": 2,
        "total_tokens": 10
    },
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
    ]
}
```

**Raised**

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
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    }
]
```

**Lower**

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
        "op": "anthropic_messages.stop_reason",
        "value": "end_turn"
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

**Out**

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

## Example 2: a response body that names the model in another field

A proxy which exposes Gemini's `generateContent` API to its client and sends
each request on to Anthropic's Messages API returns the Anthropic response to
its client as a Gemini response. A Gemini response names the model in
`modelVersion`. As in Example 1, fiat writes no `anthropic_messages.*` op of
**Lower** into **Out**.

**In**

```json
{
    "id": "msg_1",
    "type": "message",
    "model": "claude-sonnet-4-5-20250929",
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": {
        "input_tokens": 8,
        "output_tokens": 2
    },
    "role": "assistant",
    "content": [
        {
            "type": "text",
            "text": "hello"
        }
    ]
}
```

**Raised**

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

**Lower**

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

**Out**

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

## Example 3: beside `llm.model` in the program of the next request

A proxy which holds one conversation with OpenAI's Chat Completions API as one
program appends the ops raised from each response and each new user text, and
lowers the whole program to the next request. **Raised** holds the ops of the
first request, which asked for `gpt-4o`, then the **Raised** ops of Example 1,
then the next user text. The request in **Out** asks for the model in
`llm.model`.

**Raised**

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
        "role": "assistant",
        "content": "hello"
    },
    {
        "op": "response.stop",
        "reason": "end_turn"
    },
    {
        "op": "llm.text",
        "role": "user",
        "content": "thanks"
    }
]
```

**Lower**

```json
[
    {
        "op": "llm.model",
        "model": "gpt-4o"
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
            "content": "hello"
        }
    },
    {
        "op": "openai_chat.message",
        "message": {
            "role": "user",
            "content": "thanks"
        }
    }
]
```

**Out**

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

## Where each dialect holds the model

| dialect              | where a response names the model                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic_messages` | top-level `model` of a response body, and `message.model` of the `message_start` event that fiat writes when it lowers a whole response to stream events |
| `openai_chat`        | top-level `model` of a response body and of every stream chunk                                                                                           |
| `openai_responses`   | top-level `model` of a response body; in a stream, `response.model` of `response.completed`, `response.incomplete`, and `response.failed`                |
| `gemini`             | top-level `modelVersion` of a response body and of every stream chunk                                                                                    |
| `openai_realtime`    | see below                                                                                                                                                |

Every dialect writes `model` unchanged, so a response body of one provider can
name a model of another provider. When a program holds several
`response.model` ops, the last one is written. When a program that is lowered
to a request holds no `llm.model`, the request asks for the model in the last
`response.model`.

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
