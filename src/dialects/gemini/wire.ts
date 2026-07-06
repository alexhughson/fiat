import {
    opData,
    type JsonSchema,
    type Op,
    type OpOf,
    type Program,
    type ServerToolKind,
    type ToolChoice,
} from "../../core/ops";
import { firstOp } from "../../core/program";
import { declaredToolsByName, type DeclaredTool } from "../../core/tools";
import { LintError } from "../../core/lint";
import { asArray, asNumber, asRecord, asString } from "../../core/wire";
import type {
    WireContent,
    WireFunctionDeclaration,
    WirePart,
    WireTool,
} from "./ops";

export function requestFromWire(wire: unknown): Program {
    const body = asRecord(wire, "gemini request body");
    const program: Program = [];
    const pendingContents: Program = [];
    const hasSystemInstruction = Object.hasOwn(body, "systemInstruction");
    let sawSystemInstruction = false;
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "contents":
                for (const content of asArray(value, "contents")) {
                    const op: Op = {
                        op: "gemini.content",
                        content: contentFromWire(content, "contents[]"),
                    };
                    if (hasSystemInstruction && !sawSystemInstruction)
                        pendingContents.push(op);
                    else program.push(op);
                }
                break;
            case "systemInstruction":
                program.push(...systemInstructionFromWire(value));
                sawSystemInstruction = true;
                program.push(...pendingContents.splice(0));
                break;
            case "generationConfig":
                program.push(...generationConfigFromWire(value));
                break;
            case "tools":
                for (const tool of asArray(value, "tools"))
                    program.push(...toolFromWire(tool));
                break;
            case "toolConfig":
                program.push(...toolConfigFromWire(value));
                break;
            default:
                program.push({ op: "gemini.body_field", key, value });
        }
    }
    program.push(...pendingContents);
    if (!firstOp(program, "llm.model"))
        throw new Error("gemini request body: missing model");
    return program;
}

export function requestToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    const contents: WireContent[] = [];
    const systemParts: WirePart[] = [];
    const tools: WireTool[] = [];
    const functionDeclarations: WireFunctionDeclaration[] = [];
    const declaredTools = declaredToolsByName(program, "gemini request lower");
    const flushFunctionDeclarations = (): void => {
        if (functionDeclarations.length === 0) return;
        tools.push({ functionDeclarations: [...functionDeclarations] });
        functionDeclarations.length = 0;
    };

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "llm.temperature":
                mergeBodyRecord(body, "generationConfig", {
                    temperature: op.value,
                });
                break;
            case "llm.max_output_tokens":
                mergeBodyRecord(body, "generationConfig", {
                    maxOutputTokens: op.value,
                });
                break;
            case "llm.text":
                if (op.role !== "system") {
                    throw new LintError(
                        `gemini request toWire: unlowered llm.text with role "${op.role}"`,
                    );
                }
                systemParts.push({ text: (op as OpOf<"llm.text">).content });
                break;
            case "llm.tool":
                functionDeclarations.push(toolToWire(op as OpOf<"llm.tool">));
                break;
            case "llm.server_tool":
                flushFunctionDeclarations();
                tools.push(serverToolToWire(op as OpOf<"llm.server_tool">));
                break;
            case "llm.tool_choice":
                mergeBodyRecord(body, "toolConfig", {
                    functionCallingConfig: toolChoiceToWire(
                        (op as OpOf<"llm.tool_choice">).value,
                        declaredTools,
                        "gemini request lower",
                    ),
                });
                break;
            case "gemini.content":
                contents.push(opData<{ content: WireContent }>(op).content);
                break;
            case "gemini.tool":
                flushFunctionDeclarations();
                tools.push(opData<{ tool: WireTool }>(op).tool);
                break;
            case "gemini.generation_config":
                mergeBodyRecord(
                    body,
                    "generationConfig",
                    opData<{ value: Record<string, unknown> }>(op).value,
                );
                break;
            case "gemini.tool_config":
                mergeBodyRecord(
                    body,
                    "toolConfig",
                    opData<{ value: Record<string, unknown> }>(op).value,
                );
                break;
            case "gemini.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                mergeBodyRecord(body, param.key, param.value);
                break;
            }
            default:
                throw new LintError(
                    `gemini request toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (contents.length > 0) body.contents = contents;
    if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
    flushFunctionDeclarations();
    if (tools.length > 0) body.tools = tools;
    if (!body.model)
        throw new Error("gemini request toWire: program has no llm.model op");
    if (!body.contents)
        throw new Error("gemini request toWire: program has no contents");
    return body;
}

export function responseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "gemini response body");
    const program: Program = [];
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "candidates":
                program.push(...candidateFromWire(value));
                break;
            case "usageMetadata":
                program.push({
                    op: "gemini.usage",
                    usage: asRecord(value, "usageMetadata"),
                    appliesTo: "response",
                });
                break;
            default:
                program.push({
                    op: "gemini.body_field",
                    key,
                    value,
                    appliesTo: "response",
                });
        }
    }
    return program;
}

export function responseToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    let content: WireContent | undefined;
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let candidateMeta: Record<string, unknown> = {};

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "gemini.content":
                if (content)
                    throw new Error(
                        "gemini response toWire: expected a single candidate content",
                    );
                content = opData<{ content: WireContent }>(op).content;
                break;
            case "gemini.finish_reason":
                finishReason = opData<{ value: string }>(op).value;
                break;
            case "gemini.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "gemini.candidate_meta":
                candidateMeta = {
                    ...candidateMeta,
                    ...opData<{ candidate: Record<string, unknown> }>(op)
                        .candidate,
                };
                break;
            case "gemini.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `gemini response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (!content)
        throw new Error(
            "gemini response toWire: program has no candidate content",
        );
    body.candidates = [
        {
            ...candidateMeta,
            content,
            ...(finishReason ? { finishReason } : {}),
        },
    ];
    if (usage) body.usageMetadata = usage;
    return body;
}

export function streamResponseFromWire(wire: unknown): Program {
    const body = asRecord(wire, "gemini stream response chunk");
    const program: Program = [];
    for (const [key, value] of Object.entries(body)) {
        switch (key) {
            case "model":
                program.push({
                    op: "llm.model",
                    model: asString(value, "model"),
                });
                break;
            case "candidates":
                program.push(...candidateFromWire(value));
                break;
            case "usageMetadata":
                program.push({
                    op: "gemini.usage",
                    usage: asRecord(value, "usageMetadata"),
                    appliesTo: "response",
                });
                break;
            default:
                program.push({
                    op: "gemini.body_field",
                    key,
                    value,
                    appliesTo: "response",
                });
        }
    }
    return program;
}

export function streamResponseToWire(program: Program): unknown {
    const body: Record<string, unknown> = {};
    let content: WireContent | undefined;
    let finishReason: string | undefined;
    let usage: Record<string, unknown> | undefined;
    let candidateMeta: Record<string, unknown> = {};

    for (const op of program) {
        switch (op.op) {
            case "llm.model":
                body.model = op.model;
                break;
            case "gemini.content":
                if (content)
                    throw new Error(
                        "gemini stream response toWire: expected a single candidate content",
                    );
                content = opData<{ content: WireContent }>(op).content;
                break;
            case "gemini.finish_reason":
                finishReason = opData<{ value: string }>(op).value;
                break;
            case "gemini.usage":
                usage = {
                    ...usage,
                    ...opData<{ usage: Record<string, unknown> }>(op).usage,
                };
                break;
            case "gemini.candidate_meta":
                candidateMeta = {
                    ...candidateMeta,
                    ...opData<{ candidate: Record<string, unknown> }>(op)
                        .candidate,
                };
                break;
            case "gemini.body_field": {
                const param = opData<{ key: string; value: unknown }>(op);
                body[param.key] = param.value;
                break;
            }
            default:
                throw new LintError(
                    `gemini stream response toWire: no serialization for op "${op.op}"`,
                );
        }
    }

    if (content) {
        body.candidates = [
            {
                ...candidateMeta,
                content,
                ...(finishReason ? { finishReason } : {}),
            },
        ];
    } else if (finishReason || Object.keys(candidateMeta).length > 0) {
        throw new Error(
            "gemini stream response toWire: finishReason or candidate metadata requires candidate content",
        );
    }
    if (usage) body.usageMetadata = usage;
    if (!body.candidates && !body.usageMetadata && !body.model) {
        throw new Error("gemini stream response toWire: empty stream chunk");
    }
    return body;
}

function contentFromWire(value: unknown, what: string): WireContent {
    const content = asRecord(value, what);
    assertOnlyKeys(content, ["role", "parts"], what);
    const role =
        content.role == null
            ? undefined
            : roleFromWire(content.role, `${what}.role`);
    return {
        ...(role ? { role } : {}),
        parts: asArray(content.parts, `${what}.parts`) as WirePart[],
    };
}

function roleFromWire(value: unknown, what: string): "user" | "model" {
    const role = asString(value, what);
    if (role !== "user" && role !== "model")
        throw new LintError(
            `${what}: unsupported role ${JSON.stringify(role)}`,
        );
    return role;
}

function systemInstructionFromWire(value: unknown): Op[] {
    const content = asRecord(value, "systemInstruction");
    assertOnlyKeys(content, ["parts"], "systemInstruction");
    return asArray(content.parts, "systemInstruction.parts").map((part) => {
        const record = asRecord(part, "systemInstruction part");
        assertOnlyKeys(record, ["text"], "systemInstruction part");
        return {
            op: "llm.text",
            role: "system",
            content: asString(record.text, "systemInstruction part.text"),
        };
    });
}

function generationConfigFromWire(value: unknown): Program {
    const config = asRecord(value, "generationConfig");
    const program: Program = [];
    const extras: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(config)) {
        switch (key) {
            case "maxOutputTokens":
                program.push({
                    op: "llm.max_output_tokens",
                    value: asNumber(field, "generationConfig.maxOutputTokens"),
                });
                break;
            case "temperature":
                program.push({
                    op: "llm.temperature",
                    value: asNumber(field, "generationConfig.temperature"),
                });
                break;
            default:
                extras[key] = field;
        }
    }
    if (Object.keys(extras).length > 0)
        program.push({
            op: "gemini.generation_config",
            value: extras,
        });
    return program;
}

function toolFromWire(value: unknown): Program {
    const tool = asRecord(value, "tool");
    const serverTool = serverToolFromWire(tool);
    if (serverTool) return [serverTool];
    const keys = Object.keys(tool);
    if (keys.length !== 1 || keys[0] !== "functionDeclarations") {
        return [{ op: "gemini.tool", tool }];
    }
    return asArray(tool.functionDeclarations, "tool.functionDeclarations").map(
        (declaration) => {
            const fn = asRecord(declaration, "functionDeclaration");
            assertOnlyKeys(
                fn,
                ["name", "description", "parameters"],
                "functionDeclaration",
            );
            return {
                op: "llm.tool",
                name: asString(fn.name, "functionDeclaration.name"),
                ...(fn.description != null
                    ? {
                          description: asString(
                              fn.description,
                              "functionDeclaration.description",
                          ),
                      }
                    : {}),
                inputSchema: (fn.parameters ?? {}) as JsonSchema,
            };
        },
    );
}

function serverToolFromWire(tool: Record<string, unknown>): Op | undefined {
    const keys = Object.keys(tool);
    if (keys.length !== 1) return undefined;
    const key = keys[0];
    if (key === "googleSearch" && isEmptyRecord(tool.googleSearch)) {
        return {
            op: "llm.server_tool",
            name: "web_search",
            kind: "web_search",
        };
    }
    if (key === "codeExecution" && isEmptyRecord(tool.codeExecution)) {
        return {
            op: "llm.server_tool",
            name: "code_execution",
            kind: "code_execution",
        };
    }
    return undefined;
}

function serverToolToWire(op: OpOf<"llm.server_tool">): WireTool {
    const expectedName = defaultServerToolName(op.kind);
    if (op.name !== expectedName) {
        throw new LintError(
            `gemini server tool ${op.kind}: expected canonical name ${JSON.stringify(expectedName)}, got ${JSON.stringify(op.name)}`,
        );
    }
    switch (op.kind) {
        case "web_search":
            return { googleSearch: {} };
        case "code_execution":
            return { codeExecution: {} };
    }
}

function defaultServerToolName(kind: ServerToolKind): string {
    switch (kind) {
        case "web_search":
            return "web_search";
        case "code_execution":
            return "code_execution";
    }
}

function toolToWire(op: OpOf<"llm.tool">): WireFunctionDeclaration {
    return {
        name: op.name,
        ...(op.description != null ? { description: op.description } : {}),
        parameters: op.inputSchema,
    };
}

function toolConfigFromWire(value: unknown): Program {
    const config = asRecord(value, "toolConfig");
    const program: Program = [];
    const extras: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(config)) {
        if (key !== "functionCallingConfig") {
            extras[key] = field;
            continue;
        }
        const callingConfig = asRecord(
            field,
            "toolConfig.functionCallingConfig",
        );
        const { mode, allowedFunctionNames, ...rest } = callingConfig;
        if (Object.keys(rest).length > 0) extras.functionCallingConfig = rest;
        if (mode == null) {
            if (allowedFunctionNames != null)
                throw new LintError(
                    "gemini toolConfig: allowedFunctionNames without mode is unsupported",
                );
            continue;
        }
        program.push({
            op: "llm.tool_choice",
            value: toolChoiceFromWire(
                asString(mode, "toolConfig.functionCallingConfig.mode"),
                allowedFunctionNames,
            ),
        });
    }
    if (Object.keys(extras).length > 0)
        program.push({ op: "gemini.tool_config", value: extras });
    return program;
}

function toolChoiceFromWire(
    mode: string,
    allowedFunctionNames: unknown,
): ToolChoice {
    const allowed =
        allowedFunctionNames == null
            ? undefined
            : asArray(
                  allowedFunctionNames,
                  "toolConfig.functionCallingConfig.allowedFunctionNames",
              ).map((name) =>
                  asString(
                      name,
                      "toolConfig.functionCallingConfig.allowedFunctionNames[]",
                  ),
              );
    switch (mode) {
        case "AUTO":
            if (allowed?.length)
                throw new LintError(
                    "gemini toolConfig: AUTO with allowedFunctionNames has no core mapping",
                );
            return "auto";
        case "NONE":
            if (allowed?.length)
                throw new LintError(
                    "gemini toolConfig: NONE with allowedFunctionNames has no core mapping",
                );
            return "none";
        case "ANY":
            if (allowed?.length === 1) return { name: allowed[0]! };
            if (allowed && allowed.length > 1)
                throw new LintError(
                    "gemini toolConfig: multiple allowedFunctionNames have no core mapping",
                );
            return "required";
        default:
            throw new LintError(
                `gemini toolConfig: unsupported mode ${JSON.stringify(mode)}`,
            );
    }
}

function toolChoiceToWire(
    value: ToolChoice,
    toolsByName: Map<string, DeclaredTool>,
    context: string,
): Record<string, unknown> {
    if (typeof value !== "string") {
        const tool = toolsByName.get(value.name);
        if (!tool) {
            throw new LintError(
                `${context}: tool_choice references undeclared tool ${JSON.stringify(value.name)}`,
            );
        }
        if (tool.type === "server") {
            throw new LintError(
                `${context}: forced server tool choice ${JSON.stringify(value.name)} has no Gemini mapping`,
            );
        }
        return { mode: "ANY", allowedFunctionNames: [value.name] };
    }
    switch (value) {
        case "auto":
            return { mode: "AUTO" };
        case "none":
            return { mode: "NONE" };
        case "required":
            return { mode: "ANY" };
    }
}

function isEmptyRecord(value: unknown): boolean {
    return (
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
    );
}

function candidateFromWire(value: unknown): Program {
    const candidates = asArray(value, "candidates");
    if (candidates.length !== 1) {
        throw new Error(
            `gemini response: expected exactly 1 candidate, got ${candidates.length} (n > 1 is out of scope)`,
        );
    }
    const candidate = asRecord(candidates[0], "candidate");
    const content = contentFromWire(candidate.content, "candidate.content");
    const program: Program = [
        { op: "gemini.content", content, appliesTo: "response" },
    ];
    if (candidate.finishReason != null) {
        program.push({
            op: "gemini.finish_reason",
            value: asString(candidate.finishReason, "candidate.finishReason"),
        });
    }
    const {
        content: _content,
        finishReason: _finishReason,
        ...meta
    } = candidate;
    if (Object.keys(meta).length > 0) {
        program.push({
            op: "gemini.candidate_meta",
            candidate: meta,
            appliesTo: "response",
        });
    }
    return program;
}

function mergeBodyRecord(
    body: Record<string, unknown>,
    key: string,
    value: unknown,
): void {
    if (
        (key === "generationConfig" || key === "toolConfig") &&
        isRecord(value)
    ) {
        if (body[key] != null && !isRecord(body[key])) {
            throw new LintError(
                `gemini request toWire: ${key} must be an object to merge fields`,
            );
        }
        const existing = isRecord(body[key]) ? body[key] : {};
        body[key] = deepMergeStrict(existing, value, key);
        return;
    }
    body[key] = value;
}

function deepMergeStrict(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    path: string,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
        const nextPath = `${path}.${key}`;
        if (Object.hasOwn(out, key)) {
            if (isRecord(out[key]) && isRecord(value)) {
                out[key] = deepMergeStrict(out[key], value, nextPath);
                continue;
            }
            throw new LintError(`gemini request toWire: duplicate ${nextPath}`);
        }
        out[key] = value;
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
    value: Record<string, unknown>,
    keys: string[],
    what: string,
): void {
    const allowed = new Set(keys);
    const extra = Object.keys(value).filter((key) => !allowed.has(key));
    if (extra.length > 0)
        throw new LintError(`${what}: unsupported fields ${extra.join(", ")}`);
}
