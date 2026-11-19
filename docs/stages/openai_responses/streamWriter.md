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
                "input_tokens_details": {
                    "cached_tokens": 0,
                    "cache_write_tokens": 0
                },
                "output_tokens": 2,
                "output_tokens_details": {
                    "reasoning_tokens": 0
                },
                "total_tokens": 15
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
                            "annotations": []
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
message and one answer. Gemini raising keeps `responseId` and `modelVersion`
in the `gemini.body_field` ops shown in the input. OpenAI Responses lowering
drops those foreign residual ops with a warning, so the terminal event's
response carries no `id` and no `model`; the response-id and response-model
rows cover that loss.

## What the writer keeps

- The output items in stream order, each with a stable `output_index`. A
  stream lowered from OpenAI Responses events keeps the ids and indexes that
  the source events supplied.
- One item id for each message's text deltas, invented on the message's first
  text delta when the source stream supplied no id. A function call closes the
  current message, so later text starts a new message with a new id and index.
- The text of each message, assembled from its text deltas and written into
  the terminal event's `response.output` at the message's position. A message
  closed by a function call has status `completed`; a message still open at
  the end takes the terminal response's status, which must be `in_progress`,
  `completed` or `incomplete`.
- The function-call items at their own positions, with the argument fragments
  of a stream that sends them in pieces joined. The writer keeps the source
  `call_id`, omits the optional `ResponseFunctionToolCall.id` when the source
  supplied no item id, and throws an error naming `call_id` when that required
  id is missing.
- Everything else the per-chunk lowering produced, unchanged. `write` adds
  `output` to the terminal event's response only when the stream built items
  and the response does not already hold an `output` of its own.

`toStreamResponse` and `toStreamResponses` lower one chunk alone, as before:
they give each text delta event its own item id and leave the terminal event
without `output`.
