# Dialect: `openai_responses`

OpenAI Responses (`POST /v1/responses`). Code:
`src/dialects/openai_responses/`.

## Wire ↔ core direct mappings

| wire                                  | core op                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `model`                               | `llm.model`                                                         |
| `instructions`                        | `llm.text` with `role:"system"`                                     |
| `temperature`                         | `llm.temperature`                                                   |
| `max_output_tokens`                   | `llm.max_output_tokens`                                             |
| text `input` / message input items    | `llm.text`                                                          |
| `function_call` input/output items    | `llm.tool_call` / `llm.tool_result`                                 |
| `tools[]` with `type:"function"`      | `llm.tool` (`parameters` ⇄ `inputSchema`)                           |
| minimal `web_search_preview` tool     | `llm.server_tool { name:"web_search", kind:"web_search" }`          |
| minimal `code_interpreter` tool       | `llm.server_tool { name:"code_execution", kind:"code_execution" }`  |
| minimal function/server `tool_choice` | `llm.tool_choice`; `{name}` is resolved against declared tool names |

## Dialect ops

| op                               | holds                                                          | raise →                                                                                          | lower ←                                                                                 |
| -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `openai_responses.input`         | one request `input[]` item                                     | text, function calls, and function outputs become core ops                                       | non-system text/tool-call/tool-result core ops lower into `input[]`                     |
| `openai_responses.output`        | one response `output[]` item                                   | assistant text or function call plus `output_meta`                                               | response lowering rebuilds the `output[]` array                                         |
| `openai_responses.output_meta`   | original response output item shape                            | response-only residual                                                                           | reapplies ids/status/content metadata to lowered response output                        |
| `openai_responses.tool`          | provider-specific request tool                                 | residual for MCP, file search, computer, image generation, or configured hosted tools            | serialized back exactly                                                                 |
| `openai_responses.tool_meta`     | extra function-tool fields such as `strict`                    | request residual                                                                                 | merged into the matching lowered function tool                                          |
| `openai_responses.finish_reason` | derived response status                                        | `response.stop`                                                                                  | synthesizes response `status` / `incomplete_details` where needed                       |
| `openai_responses.usage`         | wire usage object                                              | `response.usage` from `input_tokens` / `output_tokens`; leftovers are response-only residuals    | response usage ops merge back into wire usage                                           |
| `openai_responses.tool_choice`   | provider-specific `tool_choice` value that has no core mapping | request residual                                                                                 | serialized back as `tool_choice`                                                        |
| `openai_responses.body_field`    | unknown request key or response envelope field                 | request fields are required; response envelope fields are `appliesTo:"response", required:false` | serialized back, except response-only envelope residuals are skipped for request bodies |

## Server Tool Rules

`llm.tool_choice { value:{ name } }` stays name-only. During request lowering,
the Responses dialect resolves the name against the declared tools:

- if the name belongs to `llm.tool`, it emits `{ type:"function", name }`;
- if the name belongs to `llm.server_tool { kind:"web_search" }`, it emits
  `{ type:"web_search_preview" }`;
- if the name belongs to `llm.server_tool { kind:"code_execution" }`, it emits
  `{ type:"code_interpreter" }`;
- duplicate declared names or undeclared forced names throw.

OpenAI hosted tools do not carry an alias field, so `llm.server_tool` names
must be canonical for this dialect: `web_search` and `code_execution`.
Configured hosted tools such as `file_search` with vector stores, MCP tools,
computer-use tools, image-generation tools, version-pinned hosted tools, and
provider-specific hosted `tool_choice` values stay as residuals.

## Out of scope

Structured output lowering, streaming output item protocols beyond text and
function-call deltas, and provider-neutral representations for MCP, file
search, computer use, or image generation.
