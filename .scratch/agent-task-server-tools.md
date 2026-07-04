Goal:
Implement portable server-side tools in the core IR and request dialects, while keeping tool_choice name-only.

Context:
- Baseline before edits: `bun test` passes 219/219.
- Core currently has only function tools:
  - `src/core/ops.ts`: `llm.tool` has `{ name, description?, inputSchema }`.
  - `ToolChoice` is `"auto" | "none" | "required" | { name: string }`.
- Current dialect behavior:
  - `src/dialects/anthropic_messages/wire.ts`: user-defined tools become `llm.tool`; non-user-defined tools are preserved as `anthropic_messages.tool`.
  - `src/dialects/gemini/wire.ts`: `functionDeclarations` become `llm.tool`; native tools are preserved as `gemini.tool`.
  - `src/dialects/openai_responses/wire.ts`: `toolFromWire` currently throws unless `tool.type === "function"`.
- Product decision:
  - Add a new core op for portable server tools, not a new tool_choice discriminant.
  - References remain name-only: `{ op: "llm.tool_choice", value: { name: "web_search" } }`.
  - Lowerers resolve the name against declared tools. Duplicate declared names must lint.

Target shape:
```ts
export type ServerToolKind = "web_search" | "code_execution";

| {
      op: "llm.server_tool";
      name: string;
      kind: ServerToolKind;
  }
```

Expected lowering/parsing:
- OpenAI Responses:
  - canonical server tools:
    - `{ type: "web_search_preview" }` or `{ type: "web_search_preview_2025_03_11" }` -> `llm.server_tool { name: "web_search", kind: "web_search" }`
    - `{ type: "code_interpreter" }` -> `llm.server_tool { name: "code_execution", kind: "code_execution" }`
  - `llm.server_tool` lowers back to minimal OpenAI tool wire.
  - If `name` is not the canonical OpenAI name for that kind, throw because OpenAI hosted tool declarations do not carry an alias.
  - Other non-function tools, e.g. `file_search`, `mcp`, `computer`, `image_generation`, must round-trip as `openai_responses.tool` residuals.
  - Forced name-only tool_choice must lower to `{ type: "function", name }` for `llm.tool`, or `{ type: hosted-type }` for `llm.server_tool`, by looking up the declared name.
- Anthropic Messages:
  - canonical server tools:
    - `web_search*` tool types named `web_search` -> core `llm.server_tool { name, kind: "web_search" }` only when no provider-specific extra fields are present.
    - `code_execution*` tool types named `code_execution` -> core `llm.server_tool { name, kind: "code_execution" }` only when no provider-specific extra fields are present.
  - configured/versioned tools with extra fields stay as `anthropic_messages.tool` residuals and round-trip exactly.
  - `llm.server_tool` lowers to the existing current/minimal Anthropic server-tool wire for that kind.
  - name aliases are okay if Anthropic can carry the `name`.
- Gemini:
  - minimal native tools lower from core:
    - `web_search` -> `{ googleSearch: {} }`
    - `code_execution` -> `{ codeExecution: {} }`
  - optional: parse those exact minimal shapes to `llm.server_tool`; configured native tools stay residuals.
  - if the Gemini API cannot force server-tool choice by name, keep current `tool_choice` handling and throw on impossible forced server tool choice.
- OpenAI Chat:
  - has no hosted server-tool request tool. If `llm.server_tool` reaches `toWire`, fail loudly via existing no-serialization error or a clearer LintError.

Tests required:
- OpenAI Responses request with `web_search_preview` raises to core `llm.server_tool` and round-trips.
- OpenAI Responses request with `file_search` or `mcp` no longer throws and round-trips as residual.
- Name-only `tool_choice: { name: "web_search" }` lowers to the OpenAI hosted choice when a matching `llm.server_tool` exists.
- Duplicate tool names across `llm.tool` and `llm.server_tool` lint before lowering tool_choice.
- Anthropic provider-specific configured server tool still stays residual and exact.
- Core server tool translates from Anthropic to OpenAI Responses for `web_search` and `code_execution`.
- Docs updated in `docs/core-ir.md` and `docs/dialects/openai_responses.md` if that file exists or is added.

Constraints:
- Do not normalize MCP/file_search/computer/image_generation.
- Do not add a discriminated tool_choice type.
- Do not silently choose function vs server tool when names collide.
- Use existing patterns; no broad refactor.
- There are many existing dirty files in the workspace. Do not revert or rewrite unrelated changes.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Verify:
- Run targeted `bun test test/openai_responses.test.ts test/anthropic_messages.test.ts test/gemini.test.ts test/translate.test.ts`.
- Run full `bun test`.
- Run typecheck if available.

Out of scope:
- Live API e2e.
- Streaming tool protocols.
- MCP, file search, computer use, image generation normalization.
- Changing `llm.tool_choice` type.

Self-report:
Write `.scratch/agent-notes-server-tools.md` with changed files, decisions, commands run, and results.
