# Core IR

Core IR is the provider-neutral op vocabulary. Types live in
`src/core/ops.ts`.

A program is `Op[]`. Conversation order matters for:

- `llm.text`
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
| `request.store`          | `value`                                   | OpenAI Responses store flag; no default    |
| `request.stop_sequences` | `value: string[]`                         | provider stop strings                      |
| `llm.thinking`           | `effort`                                  | portable effort including `off` and `minimal`; dialects choose wire form |
| `llm.service_tier`       | `value: "priority"`                       | priority routing when the target supports it |
| `llm.text`               | `role`, `content`                         | one text unit                              |
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
and message metadata stay in dialect residual ops. `response.usage` carries
the provider's own input/output and cache counts when the wire exposes them;
other usage detail (reasoning tokens, totals, tier labels, ...) stays in the
dialect usage residual. `inputTokens` is not normalized across providers:
OpenAI-family `prompt_tokens` / `input_tokens` includes cached tokens, while
other APIs may report cache reads separately — fiat passes the provider number
through, and consumers that need a single billable-input figure subtract cache
reads themselves. Cost is not modeled in core IR. Residuals
that preserve user content are marked so translating them to another backend
throws instead of warning and dropping the content.

## Response ops

| op                         | fields                                 | notes                         |
| -------------------------- | -------------------------------------- | ----------------------------- |
| `response.stop`            | normalized stop reason                 | provider enum values map here |
| `response.id`              | `id`                                   | provider response id when echoed |
| `response.usage`           | `inputTokens?`, `outputTokens?`, `cacheReadTokens?`, `cacheWriteTokens?` | provider-native counts |
| `response.text_delta`      | `index?`, `role?`, `content`           | stream text delta             |
| `response.tool_call_delta` | `index?`, `id?`, `name?`, `arguments?` | stream tool-call delta        |

Assistant responses raise to `llm.text` and `llm.tool_call`. That is why a
response program can be appended to the next request program.

## Host ops

| op           | fields    | notes                              |
| ------------ | --------- | ---------------------------------- |
| `meta.trace` | `traceId` | host correlation; stripped on wire |

## Adding a core op

Add a core op only when at least two providers share the concept. Otherwise,
keep the data in a dialect residual. After adding a core op, every dialect must
either map it or fail loudly when it reaches an unsupported target.
