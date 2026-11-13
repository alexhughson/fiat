# llm.text

```ts
{
    op: "llm.text";
    role: "system" | "user" | "assistant";
    content: string;
}
```

## Example 1: `system` and `user` text, to Anthropic's Messages API

A Chat Completions request sent on to Anthropic's Messages API.

**In**

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

**Raised**

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

**Lower**

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

**Out**

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

An Anthropic Messages request sent on to OpenAI's Chat Completions API.

**In**

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

**Raised**

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

**Lower**

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

**Out**

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
