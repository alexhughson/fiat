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
| `llm.model`              | `model`                                   | the model the request asks for             |
| `llm.temperature`        | `value`                                   | no range normalization                     |
| `llm.max_output_tokens`  | `value`                                   | provider token-cap field                   |
| `request.user`           | `value`                                   | provider user/account id when available    |
| `request.stream`         | `value`                                   | stream request flag                        |
| `request.stop_sequences` | `value: string[]`                         | provider stop strings                      |
| `llm.thinking`           | `effort`                                  | portable effort; dialects choose wire form |
| `llm.text`               | `role`, `content`                         | one text unit                              |
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
| `response.model`           | `model`                                | the model that answered; see Response model below                |
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

## Response model

`llm.model` holds the model that a request asks for. `response.model` holds
the model that the provider's API reports as the one that answered. The two
names can differ: a request for the alias `claude-sonnet-4-5` is answered by
the dated model `claude-sonnet-4-5-20250929`. Both ops hold the name unchanged.

```ts
{
    op: "llm.model";
    model: string;
}
```

```ts
{
    op: "response.model";
    model: string;
}
```

A dialect raises `response.model` from every response body and stream event
that names the model and that the dialect can raise, and writes the op's
`model` into the same field when it lowers a program to a response body or a
stream event. The `anthropic_messages` stream codec does not raise
`message_start`, the one Anthropic stream event that names the model.

| dialect              | response field that names the model                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `anthropic_messages` | top-level `model`; lowering a complete response to stream events writes `message.model` of `message_start`             |
| `openai_chat`        | top-level `model` of the response body and of every stream chunk                                                       |
| `openai_responses`   | top-level `model`; in a stream, `response.model` of `response.completed`, `response.incomplete`, and `response.failed` |
| `gemini`             | top-level `modelVersion` of the response body and of every stream chunk                                                |
| `openai_realtime`    | `model` in the `response` of `response.done`, when the event holds one                                                 |

When a program holds several `response.model` ops, the last one is written.
When a stream event has no field for the model, such as an `openai_responses`
`response.output_text.delta` event, lowering removes the op.

If a raised response is appended to the program of its request, the program
holds both ops. Lowering that program to a request body removes
`response.model`, like every other `response.*` op, so the request body asks
for the model in `llm.model`.

### Request settings in a response program

If a response is lowered from a program that also holds its request, the
program contains ops that set up the request. A response body has no field for
them, so lowering to a response body or to stream events removes these ops:
every `request.*` op, and `llm.model`, `llm.temperature`,
`llm.max_output_tokens`, `llm.thinking`, `llm.tool`, `llm.server_tool`,
`llm.tool_choice`, and `llm.output`. The `dropRequestOps` function in
`src/core/pipeline.ts` removes them.

### `useRequestedModelWhenNoResponseModel`

A response body has one model field, and a provider's API always fills it. A
response program that was not raised from a provider's response, for example
one built from a request program and a text, holds `llm.model` and no
`response.model`; without this stage, `dropRequestOps` removes the `llm.model`
and the response body names no model.

```ts
function useRequestedModelWhenNoResponseModel(program: Program): Program;
```

The stage runs before `dropRequestOps` when a program is lowered to a response
body or to stream events. When the program holds no `response.model`, the
stage puts a `response.model` in the place of the last `llm.model`, which is
the `llm.model` that request lowering writes. When the program holds a
`response.model`, the stage changes nothing.

A response program that an application builds by hand, without a response
from a provider's API, and passes to `AnthropicTranslator.toResponse`. The
stage receives this whole program:

```json
[
    {
        "op": "llm.model",
        "model": "claude-sonnet-4-5"
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

The whole response body that `AnthropicTranslator.toResponse` returns to that
application for this program, which the application sends to its client.
`toResponse` invents the `id`:

```json
{
    "model": "claude-sonnet-4-5",
    "stop_reason": "end_turn",
    "id": "msg_<random>",
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

## Host ops

| op           | fields    | notes                              |
| ------------ | --------- | ---------------------------------- |
| `meta.trace` | `traceId` | host correlation; stripped on wire |

## Adding a core op

Add a core op only when at least two providers share the concept. Otherwise,
keep the data in a dialect residual. After adding a core op, every dialect must
either map it or fail loudly when it reaches an unsupported target.
