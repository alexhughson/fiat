# Dialect: `gemini`

Gemini Generate Content (`POST /v1beta/{model}:generateContent`). The library
keeps `model` in the body for translation; live callers strip it into the REST
path. Code: `src/dialects/gemini/`.

## Direct mappings

| wire                                         | core                    |
| -------------------------------------------- | ----------------------- |
| `model`                                      | `llm.model`             |
| `systemInstruction.parts[].text`             | system `llm.text`       |
| `generationConfig.maxOutputTokens`           | `llm.max_output_tokens` |
| `generationConfig.temperature`               | `llm.temperature`       |
| `tools[].functionDeclarations[]`             | `llm.tool`              |
| minimal Google Search / code execution tools | `llm.server_tool`       |
| portable `functionCallingConfig` modes       | `llm.tool_choice`       |
| JSON response schema config                  | `llm.output`            |
| REST `inline_data` image parts               | `llm.image`             |
| REST `inline_data` audio parts               | `llm.audio`             |
| REST `inline_data` PDF parts                 | `llm.document`          |
| REST `inline_data` video parts               | `llm.video`             |

## Dialect ops

| op                         | purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `gemini.content`           | one request content or response candidate content                           |
| `gemini.part_meta`         | part metadata such as `thoughtSignature` and exact function response fields |
| `gemini.tool`              | configured built-ins, URL context, and other raw tool objects               |
| `gemini.generation_config` | Gemini-only `generationConfig` fields                                       |
| `gemini.tool_config`       | `toolConfig` fields not mapped to `llm.tool_choice`                         |
| `gemini.finish_reason`     | maps `STOP`, `MAX_TOKENS`, and `SAFETY` to `response.stop`                  |
| `gemini.usage`             | shared usage plus `usageMetadata` extras                                    |
| `gemini.candidate_meta`    | response candidate fields outside content/finish reason                     |
| `gemini.body_field`        | unknown top-level field                                                     |

## Lints

- A bare `llm.tool_result` needs a known function name from a prior
  `llm.tool_call` or `gemini.part_meta`.
- Tool result content must be JSON for `functionResponse.response`.
- Multiple response candidates are rejected.
- `toolConfig` with several `allowedFunctionNames` has no core equivalent.
- Forced server-tool choices throw; Gemini can force function tools only.
- `llm.output` conflicts with existing native `responseMimeType` or
  `responseSchema`.
- `gemini.part_meta` must stay adjacent to the lowered part it annotates.

## Thinking and signatures

Gemini thinking continuity is carried by encrypted `thoughtSignature` fields
on parts, not by a core thinking content block.

When a Gemini response program is appended to the next Gemini request, lowering
reattaches the exact `thoughtSignature` to the historical `functionCall` part.
If a transform separates the core part from its `gemini.part_meta`, lowering
throws instead of guessing.

Some Gemini models omit `functionCall.id`. Raising synthesizes a core id such
as `gemini_call_0`; `gemini.part_meta` marks it so lowering back to Gemini
omits the synthetic id again.

## Model-specific behavior

- Portable `llm.thinking` lowers to Gemini 3 `thinkingLevel` or Gemini 2.5
  `thinkingBudget`.
- Gemini 3 maps `low=LOW`; Pro maps `medium/high=HIGH`; Flash maps
  `medium=MEDIUM`, `high=HIGH`.
- Gemini 3 does not accept `xhigh` or `max`; default lowering clamps to
  `HIGH`, strict mode throws.
- Fiat maps portable `minimal` to `thinkingBudget: 512` on Gemini 2.5.
  This is deliberately below `low` (1024); it is a fiat convention, not a
  documented Google wire value.
- - Gemini 2.5 maps efforts to budgets:
  `low=1024`, `medium=4096`, `high=8192`, `xhigh=16384`, `max=24576`.
- Native `thinkingLevel` reaching Gemini 2.5 is legalized to budgets by
  default.
- Configured built-ins and URL context stay as `gemini.tool` residuals.
- REST `inline_data` image/audio/PDF/video parts raise to portable media ops.
  Gemini file URIs and SDK camelCase media parts stay as content-bearing
  `gemini.content` residuals unless they are text/function-call/function-
  response parts.
- URL image/document sources cannot lower directly to GenerateContent; upload
  them and pass native Gemini file data, or use base64 data.
- Media model validation is hard failure even in lenient mode. It never drops
  media.
- Roleless request `contents[]` entries stay residuals.
- Image/audio/TTS/video response parts throw today; core has no response media
  op.

## Live facts pinned in tests

- Live tests use `models/gemini-3.5-flash` in this environment.
- Text responses include `content.role: "model"`, text parts, `finishReason:
"STOP"`, and token counts.
- Forced tool calls use mode `ANY` with one allowed function and thinking
  budget `0`.
- Forced tool responses can include `thoughtSignature`; e2e validation checks
  that chained requests send it back.
- Some live models, including `models/gemini-2.5-flash`, can omit
  `functionCall.id`.

## On-demand e2e

`bun run e2e:gemini` writes live artifacts under
`e2e/gemini/output/latest/`. `bun run e2e:gemini:validate` validates those
artifacts against the fixture shapes used by unit tests.

The `multimodal-tool` scenario is intentionally mixed: core ops carry portable
request fields, and native media parts can remain `gemini.content` residuals
when they are not portable core images.

## Out of scope

Streaming, Interactions API, multiple candidates, cache/batch/countTokens,
response media core ops, and provider-neutral thinking content.
