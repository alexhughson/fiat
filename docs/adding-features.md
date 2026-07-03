# Adding features: the cookbook

Every change has exactly one home. Find your change in this table, touch
only the listed files, and add both kinds of test.

| you want to… | recipe |
|---|---|
| support a new wire field/construct in an existing dialect | [1](#1-extend-an-existing-dialect) |
| support a new provider or endpoint | [2](#2-add-a-new-dialect) |
| conform requests for a specific endpoint/model | [3](#3-add-a-legalization-or-lint) |
| represent a concept shared by 2+ providers | [4](#4-add-a-core-op) |

## Repo map

```
src/core/
  ops.ts        core op types + OpOf/opData narrowing helpers
  program.ts    firstOp / opsOf / append
  pass.ts       Pass, Target, LintError, runPasses
  registry.ts   Dialect contract, registerDialect/getDialect
  pipeline.ts   raiseFromWire, lowerToWire, translateRequest/Response, residual lint
  translator.ts makeTranslator (fromBody/toBody/fromResponse/toResponse)
  wire.ts       asRecord/asString/... wire parsing assertions
src/dialects/<name>/
  ops.ts        dialect op types + DIALECT constant
  wire.ts       requestFromWire/requestToWire/responseFromWire/responseToWire
  raise.ts      dialect ops -> core ops (+ enum maps)
  lower.ts      core ops -> dialect ops (lowerRequest / lowerResponse)
  legalize.ts   Pass[] (optional)
  index.ts      registerDialect(...) + exported translator
test/
  <name>.test.ts    per-dialect executable documentation (no network)
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
2. `src/dialects/<name>/raise.ts` — map the wire shape to the core op(s). If
   the construct lives inside a message/block, extend the existing
   `raiseMessage`/`raiseBlock`; today's code throws `LintError` on unknown
   parts, so you are replacing a loud failure, never changing silent
   behavior.
3. `src/dialects/<name>/lower.ts` — the inverse mapping.
4. `wire.ts` only changes if a new top-level body key is involved.
5. Tests: extend `test/<name>.test.ts` with the wire fixture ⇄ program
   fixture (exact `toEqual`, both directions), and `test/live.test.ts` with
   one real call if the construct affects what the provider returns.
6. Update the dialect doc's tables.

## 2. Add a new dialect

Example shape: "add gemini" (`generateContent`). Copy the layout of
`src/dialects/anthropic_messages/` — it is the better template because its
wire shape differs more from the core IR.

1. `src/dialects/gemini/ops.ts` — `DIALECT = "gemini"`, wire types, dialect
   op types. Expect roughly: a `gemini.content` op (grouping), a finish/stop
   enum op, a usage op, and `gemini.param`.
2. `wire.ts` — four functions. Every unknown body key becomes
   `gemini.param`; require the fields the API requires; throw on everything
   malformed.
3. `raise.ts` / `lower.ts` — semantic mapping. Enum maps are two explicit
   `Record`s; unmapped values throw.
4. `index.ts` — `registerDialect({...})`, export `makeTranslator(DIALECT)`.
   Add the import + re-export to `src/index.ts`.
5. Tests: new `test/gemini.test.ts` mirroring the structure of
   `test/anthropic_messages.test.ts` (request roundtrip, tool roundtrip,
   grouping behavior, response raise, response roundtrip); a cross-provider
   case in `test/translate.test.ts`; live tests keyed on `GEMINI_API_KEY`.
6. New `docs/dialects/gemini.md` with the two mapping tables; link it from
   `docs/dialects.md`.

Nothing else changes — the pipeline, lint, and translator code are
dialect-agnostic.

## 3. Add a legalization or lint

1. `src/dialects/<name>/legalize.ts` — add a `Pass` and append it to the
   exported `legalizations` array. Scope with `appliesTo(target)` on
   `target.kind` and/or `target.model` (e.g. only models matching
   `/^claude-3/`).
2. Decide the type honestly: if the rewrite preserves meaning (defaults,
   caps, renames) it's a legalization; if it can't (dropping a semantic
   param, degrading `llm.output`), **throw `LintError`** instead of
   rewriting. Never both.
3. Test in `test/<name>.test.ts`: one case where the pass fires, one where
   `appliesTo` keeps it out.

Caller-supplied passes (routing, prompt rewrites) are not registered
anywhere — they're passed to `translateRequest(..., { passes })` and belong
to the application, not this library.

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
