# Adding Features

Start by choosing the owner of the change.

| change                                    | home                                 |
| ----------------------------------------- | ------------------------------------ |
| new field in an existing provider payload | `src/dialects/<name>/`               |
| new provider endpoint                     | new `src/dialects/<name>/` directory |
| model/provider conformance rule           | `<dialect>/legalize.ts`              |
| concept shared by multiple providers      | `src/core/ops.ts` plus every dialect |

## Repo map

```text
src/core/                 shared Program, Op, Stage, Dialect, pipeline code
src/dialects/<name>/      endpoint ops, wire codec, raise/lower, legalizers
test/dialects/<name>/     dialect round-trips and stage tests
test/translate.test.ts    cross-dialect behavior
docs/                     architecture and dialect reference
```

## Extend a dialect

Example: add a new OpenAI Chat content part.

1. If the concept is portable, add the core op first.
2. Add or extend the smallest raise stage that maps the wire shape to core.
   If the construct is inside an existing message/block parser, extend that
   parser instead of adding a disconnected pass.
3. Add the inverse lower stage.
4. Touch `wire.ts` only for top-level wire keys or serialization changes.
5. Add exact `toEqual` tests for wire -> program and program -> wire.
6. Update the dialect doc table.

Keep unknown/unsupported input loud. Replacing a `LintError` with a mapping is
fine; replacing it with a silent drop is not.

## Add a dialect

1. Create `src/dialects/<name>/ops.ts` with `DIALECT`, wire types, and dialect
   op types.
2. Implement `wire.ts`: parse known keys, preserve unknown top-level keys as
   `<dialect>.body_field`, throw on malformed required fields.
3. Implement `raise.ts` and `lower.ts` as stage arrays.
4. Export `<Name>Dialect` and `<Name>Translator` from `index.ts`; re-export
   from `src/index.ts`.
5. Add request, response, stream, and cross-provider tests as applicable.
6. Add `docs/dialects/<name>.md` and link it from `docs/dialects.md`.

Use `anthropic_messages` as the template when the provider wire differs
substantially from core IR.

## Add a legalization or lint

1. Add the function in `src/dialects/<name>/legalize.ts`.
2. Append it to the dialect's `legalizations` array and attach that array to
   the request or response codec.
3. Scope by `target.model` inside the function.
4. Test default behavior, strict-mode failure, and a no-op model.

Use a legalization when the rewrite preserves intent. Use a lint when the
request cannot be represented without changing intent.

## Add a core op

1. Extend `CoreOp` in `src/core/ops.ts`.
2. Add the namespace to `CORE_NAMESPACES` if needed.
3. Teach each dialect to map it or fail loudly when lowering.
4. Document it in `docs/core-ir.md`.
5. Add cross-dialect tests.

Do not add a core op for a one-provider feature. Keep that data in a residual.

## Done

- `bun test`
- `bunx tsc --noEmit`
- exact round-trip assertions where the home dialect should be lossless
- no silent drop: map it, preserve it as a residual, warn/drop it as foreign,
  or throw
