# streamWriter

When the chunks of one provider's stream are lowered into an OpenAI Responses
stream one chunk at a time, each event is built alone: every text delta event
gets an item id no other event shares, and the terminal event holds only the
fields of its own chunk. A Responses client groups text deltas by item id and
reads the terminal event's response as the whole result, so the stream reads
as many separate messages that end in an empty answer. `streamWriter` is used
to lower one whole stream through one object that remembers what the chunks
before it held.

`streamWriter` is a method of `OpenAIResponsesTranslator`, the translator that
`src/index.ts` exports. It returns a `StreamWriter`, the interface that
`src/core/registry.ts` declares, and it takes the same options as
`toStreamResponses`.

```ts
streamWriter(opts?: LowerOptions): StreamWriter;
```

```ts
interface StreamWriter {
    write(program: Program): unknown[];
}
```

`Program` is the type `Op[]`, declared in `src/core/ops.ts`, and
`LowerOptions` is declared in `src/core/pipeline.ts`. A caller that translates
one stream creates the writer once, and calls `write` once for each chunk the
provider streams, after raising the chunk with `fromStreamResponse`.

## Example

A Gemini text stream of two answer chunks and a final chunk that carries the
stop reason and the usage, lowered into the events of an OpenAI Responses
stream. The proxy in this example accepts a request in Gemini format, sends it
to the Gemini API, and streams the answer back to its client in OpenAI
Responses format.

**In**: the programs that `GeminiTranslator.fromStreamResponse` returns for the
three chunks, in the order the Gemini API sent them. Each program is a whole
raised chunk.

```json
[
    [
        {
            "op": "response.text_delta",
            "role": "assistant",
            "content": "A"
        },
        {
            "op": "gemini.candidate_meta",
            "candidate": {
                "index": 0
            },
            "appliesTo": "response"
        }
    ],
    [
        {
            "op": "response.text_delta",
            "role": "assistant",
            "content": "B"
        },
        {
            "op": "gemini.candidate_meta",
            "candidate": {
                "index": 0
            },
            "appliesTo": "response"
        }
    ],
    [
        {
            "op": "response.text_delta",
            "role": "assistant",
            "content": ""
        },
        {
            "op": "response.stop",
            "reason": "end_turn"
        },
        {
            "op": "gemini.candidate_meta",
            "candidate": {
                "index": 0
            },
            "appliesTo": "response"
        },
        {
            "op": "gemini.body_field",
            "key": "responseId",
            "value": "gemini-response-check",
            "appliesTo": "response"
        },
        {
            "op": "gemini.body_field",
            "key": "modelVersion",
            "value": "gemini-3.5-flash-lite",
            "appliesTo": "response"
        },
        {
            "op": "response.usage",
            "inputTokens": 13,
            "outputTokens": 2
        },
        {
            "op": "gemini.usage",
            "usage": {
                "totalTokenCount": 15
            },
            "appliesTo": "response"
        }
    ]
]
```

**Out**: the events that `write` returned for those chunks, concatenated in
the order the writer returned them. Each event is a whole event that the proxy
sends to its client. The writer invented the item id once for the whole
stream; this block writes the invented id as `msg_<invented>`.

```json
[
    {
        "type": "response.output_text.delta",
        "item_id": "msg_<invented>",
        "output_index": 0,
        "content_index": 0,
        "delta": "A"
    },
    {
        "type": "response.output_text.delta",
        "item_id": "msg_<invented>",
        "output_index": 0,
        "content_index": 0,
        "delta": "B"
    },
    {
        "type": "response.output_text.delta",
        "item_id": "msg_<invented>",
        "output_index": 0,
        "content_index": 0,
        "delta": ""
    },
    {
        "type": "response.completed",
        "response": {
            "status": "completed",
            "usage": {
                "input_tokens": 13,
                "output_tokens": 2
            },
            "output": [
                {
                    "type": "message",
                    "id": "msg_<invented>",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "AB",
                            "annotations": [],
                            "logprobs": []
                        }
                    ]
                }
            ]
        }
    }
]
```

Every text delta event carries the item id the writer invented once, and the
terminal event holds the message the stream built, so the client reads one
message and one answer. The terminal event's response carries no `id` and no
`model`, because the Gemini stream raise drops `responseId` and
`modelVersion` before they reach the writer; a raise row for those fields
fills them in.

## What the writer keeps

- One item id for the text deltas of the stream's message, invented on the
  first text delta. A stream lowered from OpenAI Responses events names its
  own items; the writer keeps that id instead.
- The message text, assembled from the text deltas, written into the terminal
  event's `response.output` as one message item.
- The function-call items the stream's events carried, written into the
  terminal event's `response.output` after the message, with the argument
  fragments of a stream that sends them in pieces joined.
- Everything else the per-chunk lowering produced, unchanged. `write` adds
  `output` to the terminal event's response only when the stream built items
  and the response does not already hold an `output` of its own.

`toStreamResponse` and `toStreamResponses` lower one chunk alone, as before:
they give each text delta event its own item id and leave the terminal event
without `output`.
