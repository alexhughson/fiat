# Dialect: `gemini`

Gemini Generate Content (`POST /v1beta/{model}:generateContent`). The
library wire object keeps `model` in the body so request translators can
round-trip; live callers strip it into the REST path. Code:
`src/dialects/gemini/`.

## Wire ↔ core direct mappings

| wire                                                     | core op                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `model`                                                  | `llm.model`                                                                 |
| `systemInstruction.parts[].text`                         | `llm.text` with `role: "system"`                                            |
| `generationConfig.maxOutputTokens`                       | `llm.max_output_tokens`                                                     |
| `generationConfig.temperature`                           | `llm.temperature`                                                           |
| `tools[].functionDeclarations[]`                         | `llm.tool` (`parameters` ⇄ `inputSchema`)                                   |
| minimal `tools[].googleSearch` / `tools[].codeExecution` | `llm.server_tool` (`web_search` / `code_execution`)                         |
| `toolConfig.functionCallingConfig.mode`                  | `llm.tool_choice` (`AUTO/NONE/ANY` ⇄ `auto/none/required`)                  |
| `mode:"ANY"` with one `allowedFunctionNames[]` entry     | `llm.tool_choice` `{name}`                                                  |
| `llm.output`                                             | `generationConfig.responseMimeType:"application/json"` and `responseSchema` |

## Dialect ops

| op                         | holds                                                                                                | raise →                                                                                                                                                                                                                                              | lower ←                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gemini.content`           | one `contents[]` content or one response candidate content                                           | `role:"user"` text becomes user `llm.text`; `role:"model"` text becomes assistant `llm.text`; `functionCall` becomes `llm.tool_call`; `functionResponse` becomes `llm.tool_result`; request-native parts like `inlineData`/`fileData` stay residuals | regroups core turns into `contents[]`; tool results become user `functionResponse` parts |
| `gemini.part_meta`         | provider-only part detail, e.g. `thoughtSignature`, and exact `functionResponse.name`/`response`     | residual with `required:false`; not promoted to core                                                                                                                                                                                                 | merged back into the matching Gemini part                                                |
| `gemini.tool`              | raw Gemini tool object such as configured `codeExecution`, configured `googleSearch`, or URL context | residual                                                                                                                                                                                                                                             | serialized in `tools[]` beside function declarations                                     |
| `gemini.generation_config` | Gemini `generationConfig` fields that are not direct core renames, such as `thinkingConfig`          | residual                                                                                                                                                                                                                                             | merged into top-level `generationConfig`                                                 |
| `gemini.tool_config`       | `toolConfig` fields not mapped to `llm.tool_choice`                                                  | residual                                                                                                                                                                                                                                             | merged into top-level `toolConfig`                                                       |
| `gemini.finish_reason`     | candidate `finishReason`                                                                             | `STOP→end_turn`, `MAX_TOKENS→max_tokens`, `SAFETY→content_filter`; anything else throws                                                                                                                                                              | reverse map for representable core stop reasons; `tool_use` throws                       |
| `gemini.usage`             | `usageMetadata`                                                                                      | `response.usage` from `promptTokenCount`/`candidatesTokenCount`; leftovers re-emitted with `appliesTo:"response", required:false`                                                                                                                    | response usage ops merge into `usageMetadata`                                            |
| `gemini.candidate_meta`    | candidate fields outside `content`/`finishReason`                                                    | response-only residual                                                                                                                                                                                                                               | merged back into the candidate                                                           |
| `gemini.body_field`        | unknown top-level body key                                                                           | residual (requests: required; response envelope: `appliesTo:"response", required:false`)                                                                                                                                                             | serialized back as `body[key] = value`                                                   |

## Lints

- A bare `llm.tool_result` cannot lower to Gemini unless the function name
  is known from a prior `llm.tool_call` with the same id or from
  `gemini.part_meta`. The dialect throws instead of inventing a
  `functionResponse.name`.
- Tool result content must be JSON for a Gemini `functionResponse.response`
  object.
- Multiple response candidates are rejected at `fromWire`; core has no
  candidate index or ranking op.
- `toolConfig` with several `allowedFunctionNames` has no core
  `ToolChoice` equivalent and throws rather than widening to `required`.
- Forced `llm.tool_choice {name}` can target function tools only; Gemini's
  `functionCallingConfig.allowedFunctionNames` cannot force a built-in server
  tool, so lowering a forced server-tool choice throws.
- `llm.output` throws if a Gemini `generationConfig` residual already contains
  `responseMimeType` or `responseSchema`; overwriting either would change the
  requested output contract.
- A `gemini.part_meta` residual must still be adjacent to the lowered model
  text/function-call part when request history is serialized. If a pass inserts
  another op between the core part and its metadata, lowering throws instead of
  dropping the metadata.
- `generationConfig.thinkingConfig.thinkingLevel` on pre-Gemini-3 Generate
  Content models legalizes to the matching `thinkingBudget` by default. With
  `{ strict: true }`, the same payload throws before `toWire`.

## Thinking signatures

Gemini `generateContent` does not expose thinking as a core content block.
Thinking continuity is carried by encrypted `thoughtSignature` fields on
parts. Forced function-call responses from `models/gemini-3.5-flash`,
`models/gemini-3-flash-preview`, and `models/gemini-2.5-flash` were observed
to return a `thoughtSignature` next to the `functionCall` part. Gemini 3
function-calling requires the first function-call signature from the current
turn to be sent back in history; omitting it can produce HTTP 400.

The dialect stores these fields in `gemini.part_meta` rather than adding a
core thinking op. When a Gemini response program is appended to the next
Gemini request with a tool result, request lowering reattaches the exact
`thoughtSignature` to the historical `functionCall` part. Some Gemini models
omit `functionCall.id`; raising synthesizes a core id like `gemini_call_0`,
and part metadata makes response/request lowering omit that synthetic id from
the Gemini `functionCall` again.

`gemini.part_meta` is still index-based: the metadata says "part 0 had these
extras." That is correct for immediate round-trip and response-chaining, but a
core pass that inserts or drops assistant parts between raise and lower can
misalign metadata. The current request lowering fails when metadata is no
longer adjacent to the lowered part.

## Model-specific request features

The Gemini API exposes features that are supported only by some models or
methods:

- Thinking control lives under `generationConfig.thinkingConfig`. Native
  config is carried as `gemini.generation_config`; portable `llm.thinking`
  lowers to Gemini 3 `thinkingLevel` or Gemini 2.5 `thinkingBudget`.
  Gemini 3 does not accept `xhigh`/`max` levels, so default lowering clamps
  those efforts to `high`; `{ strict: true }` throws instead. Gemini 2.5 maps
  efforts to budgets: `low=1024`, `medium=4096`, `high=8192`,
  `xhigh=16384`, `max=24576`.
  Native `thinkingLevel` that reaches Gemini 2.5 through wire input or an
  `afterLower` hook is legalized to the same budgets by default.
- Minimal built-in Google Search and code execution tools become
  `llm.server_tool`. Configured built-ins and URL context stay as
  `gemini.tool` residuals so provider-specific request fields round-trip
  exactly.
- Image, file, audio, and video request parts stay in `gemini.content`
  residuals unless they are text/function-call/function-response parts with a
  core mapping. This preserves multimodal Generate Content requests without
  pretending core IR has provider-neutral media ops.
- Roleless request `contents[]` entries from REST examples stay as
  `gemini.content` residuals so the dialect round-trips the exact request
  instead of guessing `role:"user"` and emitting a different body.
- Image/audio/TTS/video response parts are not raised into core today. A
  response containing an unsupported native part still throws because core has
  no response media representation yet.

## Live facts pinned in tests

- Use `models/gemini-3.5-flash` for live tests in this environment.
- Text responses include `content.role: "model"`, text parts, `finishReason:
"STOP"`, and `usageMetadata` token counts.
- Forced tool calls use `toolConfig.functionCallingConfig.mode: "ANY"` with
  one allowed function and `generationConfig.thinkingConfig.thinkingBudget:
0`; responses return `functionCall.name`, object `args`, and `id`.
- Forced tool responses can include `thoughtSignature` on the `functionCall`
  part. The on-demand e2e artifacts save the next request body built from that
  response and verify the signature is present in request history.
- Some live models, including `models/gemini-2.5-flash`, can omit
  `functionCall.id`. Raising synthesizes a stable core id such as
  `gemini_call_0` because `llm.tool_call` requires one, and keeps a
  `gemini.part_meta` marker so lowering the response back to Gemini omits the
  id again.

## On-demand e2e

`bun run e2e:gemini` calls the live Gemini API for several models, including
`models/gemini-2.5-flash`, then writes readable artifacts under
`e2e/gemini/output/latest/`. `bun run e2e:gemini:validate` re-reads those
artifacts and validates them against the same response fixture shapes used by
`test/dialects/gemini/gemini.test.ts`.

The `multimodal-tool` scenario is deliberately a mixed program: normal core
ops carry model, system text, max tokens, tools, and forced tool choice; a
`gemini.content` residual carries the inline image part. The saved artifact
also includes a chained request body built from the live function-call
response plus a tool result. When the live model returned a
`thoughtSignature`, validation checks that the chained request sends back the
exact same signature.

## Out of scope today

Streaming, the Interactions API, multiple candidates, cache/batch/countTokens
methods, image/audio/video response core ops, and a provider-neutral core
representation for thinking.
