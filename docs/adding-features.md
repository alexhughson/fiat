# Adding features: the cookbook

Every change has exactly one home. Find your change in this table, touch
only the listed files, and add both kinds of test.

| you want to…                                              | recipe                             |
| --------------------------------------------------------- | ---------------------------------- |
| support a new wire field/construct in an existing dialect | [1](#1-extend-an-existing-dialect) |
| support a new provider or endpoint                        | [2](#2-add-a-new-dialect)          |
| conform requests for a specific endpoint/model            | [3](#3-add-a-legalization-or-lint) |
| represent a concept shared by 2+ providers                | [4](#4-add-a-core-op)              |

## Repo map

```
src/core/
  ops.ts        core op types + OpOf/opData narrowing helpers
  program.ts    firstOp / opsOf / append
  rewrite.ts    Stage type + stagePipeline (raise/lower are stage pipelines)
  lint.ts       LintError + lintOrWarn
  registry.ts   Dialect contract
  pipeline.ts   raise/lower entrypoints, residual lint
  translator.ts Translator + makeTranslator (fromBody/toBody/fromResponse/toResponse/fromStreamResponse/toStreamResponse)
  wire.ts       asRecord/asString/... wire parsing assertions
src/dialects/<name>/
  ops.ts        dialect op types + DIALECT constant
  wire.ts       requestFromWire/requestToWire/responseFromWire/responseToWire/streamResponseFromWire/streamResponseToWire
  raise.ts      raiseStages: Stage[] — dialect ops -> core ops (+ enum maps)
  lower.ts      lowerRequestStages / lowerResponseStages / lowerStreamResponseStages: Stage[] — core ops -> dialect ops
  legalize.ts   request legalizer functions (optional)
  index.ts      exported Dialect object + exported translator
test/
  dialects/<name>/
    <name>.test.ts  per-dialect executable documentation (no network)
    stages.test.ts  per-stage executable documentation (no network)
  translate.test.ts cross-dialect pipeline behavior
  live.test.ts      real API round-trips (skip without keys in .env)
docs/
  architecture.md core-ir.md dialects.md dialects/<name>.md
```

Before writing anything, decide where the construct sits using the rule in
[dialects.md](dialects.md#when-does-a-wire-construct-get-a-dialect-op):
direct core mapping, dialect op, or residual.

## 1. Extend an existing dialect

Example shape: "add image content to openai_chat".

1. If the concept is cross-provider, first do recipe 4 (e.g. `llm.image`).
2. `src/dialects/<name>/raise.ts` — write a new `Stage` function that maps
   the wire shape to the core op(s) and append it to `raiseStages`. If the
   construct lives _inside_ a message/block, extend the existing
   `raiseMessage`/`raiseBlock` helper instead; today's code throws
   `LintError` on unknown parts, so you are replacing a loud failure, never
   changing silent behavior. Do not grow an existing stage to handle a new
   op kind.
3. `src/dialects/<name>/lower.ts` — the inverse: a new per-op stage appended
   to `lowerRequestStages`/`lowerResponseStages`. Only write a cross-op
   stage (one that inspects neighbors) if the rewrite is inherently about op
   sequences — see `mergeAdjacentSameRole` / `collectAssistantMessage` for
   the two established shapes.
4. `wire.ts` only changes if a new top-level body key is involved.
5. Tests: extend `test/dialects/<name>/<name>.test.ts` with the wire fixture ⇄
   program fixture (exact `toEqual`, both directions), add or update
   `test/dialects/<name>/stages.test.ts` for new stage behavior, and update
   `test/live.test.ts` with one real call if the construct affects what the
   provider returns.
6. Update the dialect doc's tables.

## 2. Add a new dialect

Example shape: "add gemini" (`generateContent`). Copy the layout of
`src/dialects/anthropic_messages/` — it is the better template because its
wire shape differs more from the core IR.

1. `src/dialects/gemini/ops.ts` — `DIALECT = "gemini"`, wire types, dialect
   op types. Expect roughly: a `gemini.content` op (grouping), a finish/stop
   enum op, a usage op, named ops for known provider-only payloads, and
   `gemini.body_field` for unknown top-level fields.
2. `wire.ts` — four functions. Every unknown body key becomes
   `gemini.body_field`; require the fields the API requires; throw on everything
   malformed.
3. `raise.ts` / `lower.ts` — semantic mapping. Enum maps are two explicit
   `Record`s; unmapped values throw.
4. `index.ts` — export `GeminiDialect = {...} satisfies Dialect`, then
   export `GeminiTranslator = makeTranslator(GeminiDialect)`.
   Add the import + re-export to `src/index.ts`.
5. Tests: new `test/dialects/gemini/gemini.test.ts` mirroring the structure of
   `test/dialects/anthropic_messages/anthropic_messages.test.ts` (request
   roundtrip, tool roundtrip, grouping behavior, response raise, response
   roundtrip); `test/dialects/gemini/stages.test.ts` for individual stage
   behavior; a cross-provider case in `test/translate.test.ts`; live tests keyed
   on `GEMINI_API_KEY`.
6. New `docs/dialects/gemini.md` with the two mapping tables; link it from
   `docs/dialects.md`.

Nothing else changes — the pipeline, lint, and translator code are
dialect-agnostic.

## 3. Add a legalization or lint

1. `src/dialects/<name>/legalize.ts` — add a request legalization function and append it to
   the exported `legalizations` array, then attach that array to the dialect's
   `request` codec in `index.ts`. Model scoping belongs inside the function: read
   `target.model`, return the input program unchanged when it does not apply.
2. Decide the type honestly: if the rewrite preserves meaning (defaults,
   caps, renames, clamping an unsupported effort to the nearest supported
   effort) it's a legalization. If the caller set `{ strict: true }`, throw
   `LintError` for the same unsupported data instead of cleaning it up.
3. Test in `test/dialects/<name>/<name>.test.ts`: one case where the legalization
   changes the payload, one strict-mode case where it throws, and one model
   where the legalization is a no-op.

Caller-supplied transforms (routing, prompt rewrites) are not registered
anywhere. Call the function on the core program between `fromBody(...)` and
`toBody(...)`; that policy belongs to the application, not this library.

## 4. Add a core op

1. Extend `CoreOp` in `src/core/ops.ts` (new namespace entries beyond
   `llm/meta/response` also need `CORE_NAMESPACES`).
2. Teach every existing dialect about it — either a direct `fromWire`/`toWire`
   mapping or raise/lower handling. A dialect that cannot express it must
   throw `LintError` in `lower` or `toWire` (see `llm.output` on
   anthropic_messages), so programs using the op fail loudly there.
3. Document it in `docs/core-ir.md`; test the mapping in each dialect's
   suite.

## Definition of done

- `bun test` green **with keys in `.env`** — the live suite is the proof;
  unit tests alone don't count as verified.
- `bunx tsc --noEmit` clean.
- Round-trips are exact (`toEqual` on the original body), not subset checks.
- No new silent drop: anything you can't map either round-trips as a
  residual or throws.
- Docs updated in the same change (dialect tables, core-ir catalog).
