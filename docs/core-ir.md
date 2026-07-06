# Core IR

Core IR is the provider-neutral op vocabulary. Types live in
`src/core/ops.ts`.

A program is `Op[]`. Conversation order matters for:

- `llm.text`
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
| `llm.text`               | `role`, `content`                         | one text unit                              |
| `llm.tool`               | `name`, `description?`, `inputSchema`     | client-executed function tool              |
| `llm.server_tool`        | `name`, `kind`                            | hosted web search or code execution        |
| `llm.tool_choice`        | `auto`, `none`, `required`, or `{ name }` | name resolves in the request tool scope    |
| `llm.tool_call`          | `id`, `name`, `arguments`                 | `arguments` is always a parsed object      |
| `llm.tool_result`        | `id`, `content`                           | result for a prior tool call               |
| `llm.output`             | `format:"json_schema"`, `name`, `schema`  | structured output                          |

Provider-specific tool config, usage details, and message metadata stay in
dialect residual ops.

## Response ops

| op                         | fields                                 | notes                         |
| -------------------------- | -------------------------------------- | ----------------------------- |
| `response.stop`            | normalized stop reason                 | provider enum values map here |
| `response.usage`           | `inputTokens?`, `outputTokens?`        | shared counts only            |
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
