Change:
Adds portable core server tools while keeping `llm.tool_choice` name-only. Minimal OpenAI Responses, Anthropic, and Gemini server tools raise/lower through `llm.server_tool { name, kind }`; provider-configured tools remain dialect residuals. Adds duplicate-name checking for declared function/server tools and tests/docs.

Known decisions:
- Do not add a discriminated `ToolChoice`; `{ name }` remains the only forced specific-tool shape.
- Declaration carries capability: `llm.server_tool { name, kind: "web_search" | "code_execution" }`.
- Duplicate declared names are invalid because name-only choice would be ambiguous.
- OpenAI Responses hosted tools cannot express aliases, so names must be canonical there.
- Gemini server tools can be declared but forced server-tool choice is rejected because current `functionCallingConfig.allowedFunctionNames` applies to functions.
- MCP/file_search/computer/image_generation remain residual, not core.

Checks:
- No provider-specific configured server tool is normalized into core and then loses fields.
- OpenAI Responses `tool_choice` resolves by declared name and does not guess function/server when the name is missing or duplicated.
- Anthropic configured server tool fixtures still stay residual and exact.
- Gemini does not emit `allowedFunctionNames` for a server tool.
- New `llm.server_tool` does not accidentally serialize through OpenAI Chat or Realtime as a function tool.
- Tests cover core server tool translation and residual preservation.
- Docs match behavior.
- Type/core helper names are appropriately scoped and not over-abstracted.

Delegation boundary:
Work directly in this run. Do not use the squad-build skill. Do not create, brief, or manage additional agents, threads, or squads. If another instruction says to get a subagent review or use a squad workflow, treat that as satisfied by this delegated run and complete the assigned implementation or review yourself.

Out of scope:
Style-only comments, unrelated pre-existing dirty files, live API behavior beyond tests already run.

Report format:
Verdict / High-priority findings / Medium / Confirmed OK. Require file:line cites and one-line impact.
