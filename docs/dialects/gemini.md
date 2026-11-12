# Dialect: `gemini`

Gemini Generate Content (`POST /v1beta/{model}:generateContent`). The library
keeps `model` in the body for translation; live callers strip it into the REST
path. Code: `src/dialects/gemini/`.

## Direct mappings

| wire                                         | core                    |
| -------------------------------------------- | ----------------------- |
| `model`                                      | `llm.model`             |
| `responseId`                                 | `response.id`           |
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

| op                         | purpose                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini.content`           | one request content or response candidate content                                                                                                              |
| `gemini.part_meta`         | part metadata such as `thoughtSignature`; for a `functionResponse` part, the function `name`, its `llm.tool_result` id under `of`, and any extras under `meta` |
| `gemini.tool`              | configured built-ins, URL context, and other raw tool objects                                                                                                  |
| `gemini.generation_config` | Gemini-only `generationConfig` fields                                                                                                                          |
| `gemini.tool_config`       | `toolConfig` fields not mapped to `llm.tool_choice`                                                                                                            |
| `gemini.finish_reason`     | maps `STOP`, `MAX_TOKENS`, and `SAFETY` to `response.stop`                                                                                                     |
| `gemini.usage`             | shared usage plus `usageMetadata` extras                                                                                                                       |
| `gemini.candidate_meta`    | response candidate fields outside content/finish reason                                                                                                        |
| `gemini.body_field`        | unknown top-level field                                                                                                                                        |

## Lints

- A bare `llm.tool_result` needs a known function name from an
  `llm.tool_call` or the `gemini.part_meta` that names the result.
- Multiple response candidates are rejected.
- `toolConfig` with several `allowedFunctionNames` has no core equivalent.
- Forced server-tool choices throw; Gemini can force function tools only.
- `llm.output` conflicts with existing native `responseMimeType` or
  `responseSchema`.
- A `gemini.part_meta` for a text or functionCall part must stay adjacent
  to the lowered part it annotates. A functionResponse `gemini.part_meta`
  names its `llm.tool_result` by id under `of`, so its position is free;
  lowering binds it to the nearest earlier result with that id, or the
  nearest later one, and removes it when no result has that id.

## Tool results

Gemini requires the `functionResponse.response` field of a request body to be
a JSON object. A tool result whose content parses to a JSON object lowers into
`response` as that object. Every other content is text, so it lowers as that
string wrapped under the `output` key, which Gemini's docs name for function
output — including content that parses as JSON but is not an object, such as a
number, boolean, array, or `null`. Text keeps its exact characters: the digit
text `12345678901234567890` does not become a number that loses digits, and
`1.10` does not become `1.1`.

This section's examples use a proxy which exposes the Gemini API to its
clients: the proxy raises each request body a client sends into a fiat
program, edits ops in that program, and lowers the program back into a
request body to send on to Gemini's API. For text content, the proxy sends
Gemini's API this `functionResponse.response` object, nested inside the
`functionResponse` of a part nested inside the request body's content:

```json
{
    "output": "<content>"
}
```

`GeminiTranslator.fromBody` raises a `response` whose only key is `output`
into the wrapped value: a string as text, anything else as JSON. A
`response` with `output` among other keys raises as the whole object. When
the proxy's client sends a request whose `response` holds the number 378,
`GeminiTranslator.fromBody` raises the part to the text `"378"`, and
`GeminiTranslator.toBody` writes text as a string under `output`, so the
proxy sends the part on to Gemini's API with the type changed. The diff shows
the `functionResponse` object, nested inside the part the proxy sends to
Gemini's API:

```diff
 {
     "name": "get_population",
     "response": {
-        "output": 378
+        "output": "378"
     },
     "id": "call_pop"
 }
```

This is the accepted cost of keeping every other kind of text intact. Every
non-string value under `output` changes the same way when the proxy's client
sends the body and the proxy sends it on: a number, boolean, array, or
`null` under `output` returns as that value's JSON text in a string, so the
array with the entries 1 and 2 returns as the string `[1,2]` and the boolean
`true` as the string `true`. A `response` holding an object under `output`
returns with the wrapper removed, and the same holds for a string under
`output` whose text is a JSON object: such a string returns as the object it
holds. A string under `output` whose text is not a JSON object returns
unchanged.

`gemini.part_meta` with `kind: "functionResponse"` carries the function
`name`, which Gemini requires on every `functionResponse` part and which
`llm.tool_result` does not hold, and it names the `llm.tool_result` the part
answers by that op's id under `of`, plus any other keys of the wire part under
`meta`. `GeminiTranslator.fromBody` returns the op directly after the
`llm.tool_result` raised from the same part. The op's `part` field holds, with
`meta` present only when the wire part had other keys:

```json
{
    "kind": "functionResponse",
    "of": "<the id of the llm.tool_result the part answers>",
    "name": "<the function the tool result answers>",
    "meta": {
        "<any other wire part key>": "<its value>"
    }
}
```

Lowering finds the result by `of` — the nearest earlier `llm.tool_result`
with that id, or the nearest later one when no earlier result exists, so the
op's position in the program is free and a transform may move either op.
Two results that reuse one id each keep their own name, because each
part_meta binds to the nearest earlier result. Request lowering reads only
`of` and `name`; the keys under `meta` are not written back to the request
body. A part_meta whose `of` names no `llm.tool_result` in the program —
for example after a transform cuts the answered turn out of a history —
holds only the name of a part that no longer exists, so lowering removes
the op and writes the rest of the body.

When the proxy's client sends a request body whose `functionResponse.response`
holds an object under `output`, the proxy sends the part on to Gemini's API
with the wrapper removed. The diff shows the `functionResponse` object, nested
inside the part the proxy sends to Gemini's API:

```diff
 {
     "name": "get_population",
     "response": {
-        "output": {
-            "a": 1
-        }
+        "a": 1
     },
     "id": "call_pop"
 }
```

The object under the `output` key is the tool result itself, so lowering
writes it as the whole `functionResponse.response`, the same response a tool
result whose content is the JSON text of the object with the single key `a`
produces from any dialect.

When the proxy's client sends a request body whose `functionResponse` part has
no `response` field, `GeminiTranslator.fromBody` raises the part to content
`"{}"` and `GeminiTranslator.toBody` writes an empty `response` object, so
the proxy sends the part on with an empty `response` object and the body
differs from the request.

## Thinking and signatures

A `thought: true` text part raises to `llm.reasoning`. When the part has a
`thoughtSignature`, the op holds it as a `signature` field whose `dialect`
is `"gemini"` and whose `value` is the signature.

Gemini thinking continuity is carried by encrypted `thoughtSignature` fields
on parts. On a `functionCall` or answer text part, `thoughtSignature` stays in
`gemini.part_meta`.

When a Gemini response program is appended to the next Gemini request, lowering
reattaches the exact `thoughtSignature` to the historical `functionCall` part.
If a transform separates a text or functionCall part from its
`gemini.part_meta`, lowering throws instead of guessing.

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
- Gemini 2.5 maps efforts to budgets:
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
and response media core ops.
