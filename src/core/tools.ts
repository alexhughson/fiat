import type { OpOf, Program, ServerToolKind } from "./ops";
import { LintError } from "./pass";

export type DeclaredTool =
    | { type: "function"; name: string }
    | { type: "server"; name: string; kind: ServerToolKind };

export function declaredToolsByName(
    program: Program,
    context: string,
): Map<string, DeclaredTool> {
    const tools = new Map<string, DeclaredTool>();
    for (const op of program) {
        let tool: DeclaredTool | undefined;
        if (op.op === "llm.tool") {
            const fn = op as OpOf<"llm.tool">;
            tool = { type: "function", name: fn.name };
        }
        if (op.op === "llm.server_tool") {
            const server = op as OpOf<"llm.server_tool">;
            tool = { type: "server", name: server.name, kind: server.kind };
        }
        if (!tool) continue;
        if (tools.has(tool.name)) {
            throw new LintError(
                `${context}: duplicate tool name ${JSON.stringify(tool.name)}`,
            );
        }
        tools.set(tool.name, tool);
    }
    return tools;
}
