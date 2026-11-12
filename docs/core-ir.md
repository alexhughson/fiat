# Core IR

Core IR is the provider-neutral op vocabulary. Types live in
`src/core/ops.ts`.

A program is `Op[]`. Conversation order matters for:

- `llm.text`
- `llm.reasoning`
- `llm.image`
- `llm.audio`
- `llm.document`
- `llm.video`
- `llm.tool_call`
- `llm.tool_result`

Config ops such as `llm.model` and `llm.temperature` may appear anywhere.

## Request ops

| op                       | fields                                    | notes                                      |
| ------------------------ | ----------------------------------------- | ------------------------------------------ |
| `llm.model`              | `model`                                   | passed through verbatim                    |
| `llm.temperature`        | `value`                                   | no range normalization                     |
| `llm.max_output_tokens`  | `value`                                   | provider token-cap field                   |
| `request.user`           | `value`                                   | provider user/account id when available    |
| `request.stream`         | `value`                                   | stream request flag                        |
| `request.stop_sequences` | `value: string[]`                         | provider stop strings                      |
| `llm.thinking`           | `effort`                                  | portable effort; dialects choose wire form |
| `llm.text`               | `role`, `content`                         | one piece of text; see Text below          |
| `llm.reasoning`          | `id`, `content`                           | model reasoning; see Reasoning below       |
| `llm.image`              | `role:"user"`, `source`                   | image URL or base64 image data             |
| `llm.audio`              | `role:"user"`, `source`                   | base64 audio data                          |
| `llm.document`           | `role:"user"`, `source`                   | PDF URL or base64 PDF data                 |
| `llm.video`              | `role:"user"`, `source`                   | base64 video data                          |
| `llm.tool`               | `name`, `description?`, `inputSchema`     | client-executed function tool              |
| `llm.server_tool`        | `name`, `kind`                            | hosted web search or code execution        |
| `llm.tool_choice`        | `auto`, `none`, `required`, or `{ name }` | name resolves in the request tool scope    |
| `llm.tool_call`          | `id`, `name`, `arguments`                 | `arguments` is always a parsed object      |
| `llm.tool_result`        | `id`, `content`                           | result for a prior tool call               |
| `llm.output`             | `format:"json_schema"`, `name`, `schema`  | structured output                          |

Media sources are explicit. Images use `{ type:"url", url }` or
`{ type:"base64", mediaType, data }` and require `image/*` for base64.
Audio is base64-only and requires `audio/*`. Documents are PDFs only and use
either `{ type:"url", url }` or `{ type:"base64", mediaType:"application/pdf",
data, filename? }`. Video is base64-only and requires `video/*`.

Provider-owned file ids, provider file URIs, image detail knobs, tool config,
usage details, and message metadata stay in dialect residual ops. Residuals
that preserve user content are marked so translating them to another backend
throws instead of warning and dropping the content.

## Text

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

The example is a run of the code for a proxy which accepts OpenAI Chat
Completions requests and sends each one to Anthropic's Messages API.

**In**: the whole request body that the proxy's client sends to the proxy.

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
that request body. Each message is one `llm.text` op.

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

**Out**: the whole request body that `AnthropicTranslator.toBody` returns for
that program, which the proxy sends to Anthropic's API.

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

Where lowering writes the text in each dialect:

| dialect              | `system` text in a request body                       | `user` or `assistant` text in a request body                        | `assistant` text in a response body                                       |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `anthropic_messages` | top-level `system`                                    | `text` block of a message in `messages`                             | `text` block in `content`                                                 |
| `openai_chat`        | message with role `system` in `messages`              | `content` of a message in `messages`                                | `content` of `choices[0].message`                                         |
| `openai_responses`   | top-level `instructions`                              | `input_text` part of a `message` item in `input`                    | `output_text` part of a `message` item in `output`                        |
| `gemini`             | `text` part in `systemInstruction`                    | `text` part of a content in `contents`; `assistant` is role `model` | `text` part in `candidates[0].content`                                    |
| `openai_realtime`    | `instructions` in the `response` of `response.create` | text part of the message item of a `conversation.item.create` event | `output_text` part of a message item in the `response` of `response.done` |

What a dialect cannot write:

- `anthropic_messages`, `gemini`, and `openai_realtime` hold system text in
  one field ahead of the conversation. Lowering a program whose `system` text
  comes after a `user` or `assistant` text to a request body throws a
  `LintError` in those three dialects. `openai_chat` writes the message in
  place, and `openai_responses` moves the text into `instructions`.
- A response body holds assistant text only. Lowering a program that holds a
  `user` or `system` text to a response body throws an `Error` in every
  dialect.
- `anthropic_messages` writes nothing for an `llm.text` whose `content` is
  `""`. The other four dialects write the empty string.
- Text in a stream event is `response.text_delta`. When a program lowered to
  stream events holds an `llm.text`, `anthropic_messages` writes the text as
  `content_block_start`, `content_block_delta`, and `content_block_stop`
  events, and the other four dialects throw a `LintError`.

## Reasoning

`llm.reasoning` is reasoning that the model produced before its answer.
`content` is the readable text, and is `""` when the provider returned none.

`signature` is optional: `{ dialect, value }`. `value` is the signature the
provider attached to the reasoning (Anthropic `signature`, Gemini
`thoughtSignature`), and `dialect` names the dialect that raised it. A
signature is valid only for the provider that issued it, so a dialect writes
`value` only when `dialect` is its own name, and otherwise treats the op as
unsigned.

Other data that only one provider can read lives in a side op of that
provider's dialect, placed after the `llm.reasoning` op. The side op's `of`
field holds the `llm.reasoning` op's `id`, and resolves to the nearest earlier
`llm.reasoning` op with that id.

| dialect              | reads                        | lowering `llm.reasoning`                                       |
| -------------------- | ---------------------------- | -------------------------------------------------------------- |
| `anthropic_messages` | its own `signature`          | `thinking` block; dropped with a warning without its signature |
| `anthropic_messages` | `redacted_thinking { data }` | `redacted_thinking` block                                      |
| `openai_responses`   | `reasoning_item { fields }`  | `reasoning` item; dropped with a warning without the side op   |
| `gemini`             | its own `signature`          | `thought: true` part; dropped with a warning with no text      |
| `openai_chat`        | nothing                      | dropped with a warning                                         |
| `openai_realtime`    | nothing                      | dropped with a warning                                         |

In strict mode each warning is a `LintError`. Stream events for reasoning are
not mapped: only Anthropic writes `llm.reasoning` into a stream response.

## Response ops

| op                         | fields                                 | notes                                                            |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `response.id`              | `id`                                   | the provider's id for a complete response; see Response id below |
| `response.stop`            | normalized stop reason                 | provider enum values map here                                    |
| `response.usage`           | `inputTokens?`, `outputTokens?`        | shared counts only                                               |
| `response.text_delta`      | `index?`, `role?`, `content`           | stream text delta                                                |
| `response.tool_call_delta` | `index?`, `id?`, `name?`, `arguments?` | stream tool-call delta                                           |

Assistant responses raise to `llm.text` and `llm.tool_call`. That is why a
response program can be appended to the next request program.

## Response id

`response.id` holds the id that a provider's API gave to one complete
response. A dialect raises the op from the id field of a complete response
body, and writes the op's `id` into the same field when it lowers a program to
a complete response body.

```ts
{
    op: "response.id";
    id: string;
}
```

| dialect              | response body field that holds the id     |
| -------------------- | ----------------------------------------- |
| `anthropic_messages` | top-level `id`                            |
| `openai_chat`        | top-level `id`                            |
| `openai_responses`   | top-level `id`                            |
| `gemini`             | top-level `responseId`                    |
| `openai_realtime`    | `id` in the `response` of `response.done` |

A dialect writes the id unchanged, so an `openai_chat` response body can hold
an id that Anthropic's API issued. When a program holds several `response.id`
ops, the last one is written. When a program holds none, four dialects invent
an id and `gemini` writes no `responseId`.

Lowering a program to a request body removes `response.id`, like every other
`response.*` op. Among the stream codecs, only the `anthropic_messages` one
that lowers a complete response to stream events reads the op: it writes the
id into `message_start.message.id`.

## Host ops

| op           | fields    | notes                              |
| ------------ | --------- | ---------------------------------- |
| `meta.trace` | `traceId` | host correlation; stripped on wire |

## Adding a core op

Add a core op only when at least two providers share the concept. Otherwise,
keep the data in a dialect residual. After adding a core op, every dialect must
either map it or fail loudly when it reaches an unsupported target.
