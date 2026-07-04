Change: The codebase now removes the string-keyed dialect registration/lookup workflow. `Translator` is a class over a concrete `Dialect`; dialect modules export `*Dialect` objects and `*Translator` instances; `translateRequest`/`translateResponse` take translator/dialect objects instead of string names. The Anthropic proxy example uses `AnthropicTranslator` and `OpenAIChatTranslator` wrappers directly.

Known decisions:
- Dialect namespace strings remain inside ops and `Target.dialect`; those are data labels for residual linting and passes, not handler lookup.
- `registry.ts` remains as the home of the `Dialect`/`Codec` contract, but no longer registers or resolves anything.
- The lower-level `raiseFromWire`/`lowerToWire` functions remain as internals used by `Translator`; they now receive a concrete dialect object.
- Docs/tests/e2e were updated away from `{ from: "openai_chat", to: "anthropic_messages" }` to wrapper objects.

Checks:
- No source conversion path should import or call `registerDialect`/`getDialect`.
- `makeTranslator` must not accept or collapse to a string dialect name.
- `translateRequest`/`translateResponse` should not accept plain strings in types or implementation.
- Dialect modules must still expose complete request/response/stream codecs and legalizations.
- The proxy example must not call lower-level string pipeline functions directly.
- Residual linting target names must still use the target dialect namespace correctly.
- Docs must not teach the old registration pattern.
- No broad provider behavior or wire semantics should have changed.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
- Style-only feedback.
- Re-litigating whether dialect namespace strings should exist as data.
- Generated trace output under `examples/output`.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Use file:line cites and one-line impact for each finding.
