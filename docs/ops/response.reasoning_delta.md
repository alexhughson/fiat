# `response.reasoning_delta`

```ts
{
    op: "response.reasoning_delta";
    index: number | null;
    content: string;
    signature: {
        dialect: string;
        value: string;
    } | null;
}
```

## Example 1: Gemini thinking returned to a Gemini client

A Gemini thinking stream returned to a Gemini client. A proxy which accepts
Gemini streams and returns Gemini streams raises each response chunk from
Gemini's API, lowers the resulting program, and sends the chunk to its Gemini
client.

**In — the whole response stream chunk Gemini's API sends to the proxy.**

```json
{
    "candidates": [
        {
            "content": {
                "role": "model",
                "parts": [
                    {
                        "text": "Check the alternatives first.",
                        "thought": true,
                        "thoughtSignature": "sig_stream_1"
                    }
                ]
            }
        }
    ]
}
```

**Raised — the whole response program the proxy's Gemini raise step returns.**

```json
[
    {
        "op": "response.reasoning_delta",
        "index": 0,
        "content": "Check the alternatives first.",
        "signature": {
            "dialect": "gemini",
            "value": "sig_stream_1"
        }
    }
]
```

**Lower — the whole lower program the proxy's Gemini lower step returns.**

```json
[
    {
        "op": "gemini.content",
        "content": {
            "role": "model",
            "parts": [
                {
                    "text": "Check the alternatives first.",
                    "thought": true,
                    "thoughtSignature": "sig_stream_1"
                }
            ]
        },
        "appliesTo": "response"
    }
]
```

**Out — the whole response stream chunk the proxy sends to its Gemini client.**

```json
{
    "candidates": [
        {
            "content": {
                "role": "model",
                "parts": [
                    {
                        "text": "Check the alternatives first.",
                        "thought": true,
                        "thoughtSignature": "sig_stream_1"
                    }
                ]
            }
        }
    ]
}
```

## Example 2: Gemini thinking returned to an OpenAI Responses client

A Gemini thinking stream returned to an OpenAI Responses client. A proxy which
accepts Gemini provider streams and exposes OpenAI Responses streams raises
the same response chunk from Gemini's API and lowers the resulting program
into a Responses event for its Responses client.

**In — the whole response stream chunk Gemini's API sends to the proxy.**

```json
{
    "candidates": [
        {
            "content": {
                "role": "model",
                "parts": [
                    {
                        "text": "Check the alternatives first.",
                        "thought": true,
                        "thoughtSignature": "sig_stream_1"
                    }
                ]
            }
        }
    ]
}
```

**Raised — the whole response program the proxy's Gemini raise step returns.**

```json
[
    {
        "op": "response.reasoning_delta",
        "index": 0,
        "content": "Check the alternatives first.",
        "signature": {
            "dialect": "gemini",
            "value": "sig_stream_1"
        }
    }
]
```

**Lower — the whole response program the proxy's OpenAI Responses lower step
returns.**

```json
[
    {
        "op": "response.reasoning_delta",
        "index": 0,
        "content": "Check the alternatives first.",
        "signature": {
            "dialect": "gemini",
            "value": "sig_stream_1"
        }
    }
]
```

**Out — one response event, nested in the stream the proxy sends to its OpenAI
Responses client.**

```json
{
    "type": "response.reasoning_text.delta",
    "item_id": "rs_a3fff2204f864515b713dcf1d4ccd08a",
    "output_index": 0,
    "content_index": 0,
    "delta": "Check the alternatives first."
}
```
