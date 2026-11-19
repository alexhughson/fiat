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

| op                          | fields                                    | notes                                                            |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `llm.model`                 | `model`                                   | passed through verbatim                                          |
| `llm.temperature`           | `value`                                   | no range normalization                                           |
| `llm.max_output_tokens`     | `value`                                   | provider token-cap field                                         |
| `request.user`              | `value`                                   | provider user/account id when available                          |
| `request.stream`            | `value`                                   | stream request flag                                              |
| `request.previous_response` | `responseId`                              | stored response before this request; see Previous response below |
| `request.stop_sequences`    | `value: string[]`                         | provider stop strings                                            |
| `llm.thinking`              | `effort`                                  | portable effort; dialects choose wire form                       |
| `llm.text`                  | `role`, `content`                         | one text unit; see [page](ops/llm.text.md)                       |
| `llm.reasoning`             | `id`, `content`                           | model reasoning; see Reasoning below                             |
| `llm.image`                 | `role:"user"`, `source`                   | image URL or base64 image data                                   |
| `llm.audio`                 | `role:"user"`, `source`                   | base64 audio data                                                |
| `llm.document`              | `role:"user"`, `source`                   | PDF URL or base64 PDF data                                       |
| `llm.video`                 | `role:"user"`, `source`                   | base64 video data                                                |
| `llm.tool`                  | `name`, `description?`, `inputSchema`     | client-executed function tool                                    |
| `llm.server_tool`           | `name`, `kind`                            | hosted web search or code execution                              |
| `llm.tool_choice`           | `auto`, `none`, `required`, or `{ name }` | name resolves in the request tool scope                          |
| `llm.tool_call`             | `id`, `name`, `arguments`                 | `arguments` is always a parsed object                            |
| `llm.tool_result`           | `id`, `content`                           | result for a prior tool call                                     |
| `llm.output`                | `format:"json_schema"`, `name`, `schema`  | structured output                                                |

Media sources are explicit. Images use `{ type:"url", url }` or
`{ type:"base64", mediaType, data }` and require `image/*` for base64.
Audio is base64-only and requires `audio/*`. Documents are PDFs only and use
either `{ type:"url", url }` or `{ type:"base64", mediaType:"application/pdf",
data, filename? }`. Video is base64-only and requires `video/*`.

Provider-owned file ids, provider file URIs, image detail knobs, tool config,
usage fields beyond the token-count parts, and message metadata stay in
dialect residual ops. Residuals that preserve user content are marked so
translating them to another backend throws instead of warning and dropping
the content.

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

| op                           | fields                                 | notes                                                                     |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `response.id`                | `id`                                   | the provider's id for a complete response; see Response id below          |
| `response.previous_response` | `responseId`                           | stored response this response continued from; see Previous response below |
| `response.stop`              | normalized stop reason                 | provider enum values map here                                             |
| `response.usage`             | six optional token-count parts         | non-overlapping parts, no total; see [page](ops/response.usage.md)        |
| `response.text_delta`        | `index?`, `role?`, `content`           | stream text delta                                                         |
| `response.tool_call_delta`   | `index?`, `id?`, `name?`, `arguments?` | stream tool-call delta                                                    |

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

## Previous response

### `request.previous_response`

```ts
{
    op: "request.previous_response";
    responseId: string;
}
```

When a request program holds this op, the provider retrieves the stored
inputs and outputs of the named response and places them ahead of the
program's conversation ops.

### `response.previous_response`

```ts
{
    op: "response.previous_response";
    responseId: string;
}
```

This op says that the response described by the program continued from the
named response. Request lowering removes this response echo, and response or
stream lowering removes `request.previous_response`, so an appended response
cannot make the next request continue from the wrong response.

`responseId` has the same value as `response.id` in the earlier response's
program, but it names provider storage rather than an earlier op in the
current program. No lowering resolves it against the program. The op has no
`dialect` tag because the value names whichever provider stored the response,
not a wire format. Its position in a program carries no meaning.

| dialect              | request lowering              | response and stream lowering                                                                                                                   |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai_responses`   | writes `previous_response_id` | writes `previous_response_id` in a response body or the `response` object of `response.completed`, `response.incomplete`, or `response.failed` |
| `anthropic_messages` | throws `LintError`            | drops `response.previous_response`                                                                                                             |
| `openai_chat`        | throws `LintError`            | drops `response.previous_response`                                                                                                             |
| `gemini`             | throws `LintError`            | drops `response.previous_response`                                                                                                             |
| `openai_realtime`    | throws `LintError`            | drops `response.previous_response`                                                                                                             |

The four dialects with no continuation field cannot retrieve the stored
conversation. Their response lowering drops only the echo, which repeats what
the request held. Raising `previous_response_id: null` produces no op.
Lowering an `openai_responses` response body or terminal stream event writes
`previous_response_id: null` when the program holds no
`response.previous_response`; request lowering writes no key when the program
holds no `request.previous_response`.

## Host ops

| op           | fields    | notes                              |
| ------------ | --------- | ---------------------------------- |
| `meta.trace` | `traceId` | host correlation; stripped on wire |

## Adding a core op

Add a core op only when at least two providers share the concept. Otherwise,
keep the data in a dialect residual. After adding a core op, every dialect must
either map it or fail loudly when it reaches an unsupported target.
