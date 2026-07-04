import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    firstOp,
    GeminiTranslator,
    type Op,
    type Program,
} from "../../src/index";
import {
    assertGeminiFunctionCallResponseShape,
    assertGeminiTextResponseShape,
} from "../../test/fixtures/gemini";

export const defaultModels = [
    "models/gemini-3.5-flash",
    "models/gemini-2.5-flash",
    "models/gemini-2.5-pro",
];

export const defaultOutputDir = resolve("e2e/gemini/output/latest");
export const describeImageToolName = "describe_image";

export type ScenarioName = "text" | "multimodal-tool";

export interface Artifact {
    scenario: ScenarioName;
    model: string;
    requestProgram: Program;
    requestBody: Record<string, unknown>;
    rawResponseBody: Record<string, unknown>;
    responseBody: Record<string, unknown>;
    responseProgram: Program;
    roundTripResponseBody: unknown;
    chainedRequestProgram?: Program;
    chainedRequestBody?: Record<string, unknown>;
    durationMs: number;
    checks: string[];
}

export interface Manifest {
    generatedAt: string;
    models: string[];
    artifacts: string[];
}

const redPixelPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lTwLcQAAAABJRU5ErkJggg==";

export function modelsFromArgs(args: string[]): string[] {
    const raw = optionValue(args, "--models");
    if (!raw) return defaultModels;
    const models = raw
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean)
        .map((model) =>
            model.startsWith("models/") ? model : `models/${model}`,
        );
    if (models.length === 0) throw new Error("--models provided no models");
    return models;
}

export function outputDirFromArgs(args: string[]): string {
    return resolve(optionValue(args, "--out") ?? defaultOutputDir);
}

export function validationDirFromArgs(args: string[]): string {
    return resolve(optionValue(args, "--dir") ?? defaultOutputDir);
}

export function buildTextProgram(model: string): Program {
    return [
        { op: "llm.model", model },
        { op: "llm.max_output_tokens", value: 512 },
        ...thinkingBudgetOps(model),
        {
            op: "llm.text",
            role: "system",
            content: "You answer with one lowercase word.",
        },
        {
            op: "llm.text",
            role: "user",
            content: "Reply with exactly the word: pong",
        },
    ];
}

export function buildMultimodalToolProgram(model: string): Program {
    return [
        { op: "llm.model", model },
        { op: "llm.max_output_tokens", value: 512 },
        ...thinkingBudgetOps(model),
        {
            op: "llm.text",
            role: "system",
            content:
                "When a tool is forced, call it and do not answer in prose.",
        },
        {
            op: "llm.tool",
            name: describeImageToolName,
            description: "Describe one tiny image for validation.",
            inputSchema: {
                type: "object",
                properties: {
                    label: { type: "string" },
                    dominant_color: { type: "string" },
                    saw_image: { type: "boolean" },
                },
                required: ["label", "dominant_color", "saw_image"],
            },
        },
        { op: "llm.tool_choice", value: { name: describeImageToolName } },
        {
            op: "llm.text",
            role: "user",
            content:
                "Use the attached image. Call describe_image with label red_pixel, dominant_color red, and saw_image true.",
        },
        {
            op: "gemini.content",
            content: {
                role: "user",
                parts: [
                    {
                        inline_data: {
                            mime_type: "image/png",
                            data: redPixelPngBase64,
                        },
                    },
                ],
            },
        },
    ];
}

export function bodyFromProgram(program: Program): Record<string, unknown> {
    return record(GeminiTranslator.toBody(program), "gemini request body");
}

export function validateTextRequestBody(
    body: Record<string, unknown>,
    model: string,
): void {
    assertModel(body, model);
    assertThinkingBudgetIfExpected(body, model);
    const contents = array(body.contents, "text request contents");
    if (contents.length !== 1)
        throw new Error(
            `text request: expected 1 content, got ${contents.length}`,
        );
    const content = record(contents[0], "text request contents[0]");
    const parts = array(content.parts, "text request parts");
    if (
        !parts.some(
            (part) => typeof record(part, "text part").text === "string",
        )
    )
        throw new Error("text request: expected a text part");
    record(body.systemInstruction, "text request systemInstruction");
}

export function validateMultimodalToolRequestBody(
    body: Record<string, unknown>,
    model: string,
): void {
    assertModel(body, model);
    assertThinkingBudgetIfExpected(body, model);
    const contents = array(body.contents, "multimodal request contents");
    if (contents.length !== 1) {
        throw new Error(
            `multimodal request: expected merged user content, got ${contents.length}`,
        );
    }
    const content = record(contents[0], "multimodal request contents[0]");
    const parts = array(content.parts, "multimodal request parts");
    if (
        !parts.some(
            (part) =>
                typeof record(part, "multimodal text part").text === "string",
        )
    )
        throw new Error("multimodal request: expected text part");
    if (!parts.some((part) => record(part, "multimodal part").inline_data))
        throw new Error("multimodal request: expected inline_data part");
    const tools = array(body.tools, "multimodal request tools");
    const declaration = record(
        array(
            record(tools[0], "tool").functionDeclarations,
            "tool declarations",
        )[0],
        "function declaration",
    );
    if (declaration.name !== describeImageToolName)
        throw new Error(
            `multimodal request: expected tool ${describeImageToolName}`,
        );
    const calling = record(
        record(body.toolConfig, "multimodal request toolConfig")
            .functionCallingConfig,
        "multimodal request functionCallingConfig",
    );
    if (calling.mode !== "ANY")
        throw new Error("multimodal request: expected forced tool mode ANY");
    const allowed = array(
        calling.allowedFunctionNames,
        "multimodal request allowedFunctionNames",
    );
    if (allowed.length !== 1 || allowed[0] !== describeImageToolName) {
        throw new Error(
            `multimodal request: expected allowedFunctionNames ${describeImageToolName}`,
        );
    }
}

export async function listGenerateContentModels(
    apiKey: string,
): Promise<Set<string>> {
    const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": apiKey } },
    );
    if (!response.ok)
        throw new Error(
            `gemini list models ${response.status}: ${await response.text()}`,
        );
    const body = record(await response.json(), "models response");
    const models = array(body.models, "models response.models");
    return new Set(
        models.flatMap((model) => {
            const item = record(model, "model");
            const methods = array(
                item.supportedGenerationMethods,
                `model ${String(item.name)} supportedGenerationMethods`,
            );
            return methods.includes("generateContent")
                ? [string(item.name, "model.name")]
                : [];
        }),
    );
}

export function assertRequestedModelsAvailable(
    requested: string[],
    available: Set<string>,
): void {
    const missing = requested.filter((model) => !available.has(model));
    if (missing.length > 0)
        throw new Error(
            `gemini models unavailable for generateContent: ${missing.join(", ")}`,
        );
}

export async function callGeminiGenerateContent(
    apiKey: string,
    body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const model = string(body.model, "request body.model");
    const { model: _model, ...generateContentBody } = body;
    const started = performance.now();
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(generateContentBody),
        },
    );
    if (!response.ok)
        throw new Error(
            `gemini ${model} ${response.status}: ${await response.text()}`,
        );
    return {
        durationMs: Math.round(performance.now() - started),
        rawResponseBody: record(
            await response.json(),
            `gemini ${model} response`,
        ),
    };
}

export function artifactFromResponse(
    scenario: ScenarioName,
    model: string,
    requestProgram: Program,
    requestBody: Record<string, unknown>,
    responseBodyWithDuration: Record<string, unknown>,
): Artifact {
    const durationMs = number(
        responseBodyWithDuration.durationMs,
        `${scenario} durationMs`,
    );
    const rawResponseBody = record(
        responseBodyWithDuration.rawResponseBody,
        `${scenario} rawResponseBody`,
    );
    const responseBody = responseBodyForTranslator(model, rawResponseBody);
    const responseProgram = GeminiTranslator.fromResponse(responseBody);
    const chained =
        scenario === "multimodal-tool"
            ? chainedToolResultRequest(requestProgram, responseProgram)
            : undefined;
    const artifact: Artifact = {
        scenario,
        model,
        requestProgram,
        requestBody,
        rawResponseBody,
        responseBody,
        responseProgram,
        roundTripResponseBody: GeminiTranslator.toResponse(responseProgram),
        ...(chained
            ? {
                  chainedRequestProgram: chained.program,
                  chainedRequestBody: chained.body,
              }
            : {}),
        durationMs,
        checks: [],
    };
    artifact.checks = validateArtifactFields(artifact);
    return artifact;
}

export function validateArtifactFields(artifact: Artifact): string[] {
    const checks: string[] = [];
    const shapeBody = artifact.rawResponseBody ?? artifact.responseBody;
    if (artifact.scenario === "text") {
        assertGeminiTextResponseShape(shapeBody);
        checks.push("raw response body matches gemini text fixture shape");
        const text = firstOp(artifact.responseProgram, "llm.text");
        if (!text || text.role !== "assistant")
            throw new Error("text scenario: expected assistant llm.text");
        checks.push("response raises to assistant llm.text");
    } else {
        assertGeminiFunctionCallResponseShape(shapeBody, describeImageToolName);
        checks.push(
            "raw response body matches gemini function-call fixture shape",
        );
        const call = firstOp(artifact.responseProgram, "llm.tool_call");
        if (!call || call.name !== describeImageToolName)
            throw new Error(
                `multimodal-tool scenario: expected ${describeImageToolName} tool call`,
            );
        record(call.arguments, "multimodal-tool arguments");
        checks.push("response raises to forced llm.tool_call");
        const signature = functionCallThoughtSignature(shapeBody);
        if (signature) {
            if (!artifact.chainedRequestBody) {
                throw new Error(
                    "multimodal-tool scenario: expected chainedRequestBody",
                );
            }
            assertChainedRequestPreservesSignature(
                artifact.chainedRequestBody,
                signature,
            );
            checks.push(
                "chained tool-result request preserves functionCall thoughtSignature",
            );
        } else {
            if (expectsFunctionCallThoughtSignature(artifact.model)) {
                throw new Error(
                    `${artifact.model}: expected functionCall thoughtSignature`,
                );
            }
            checks.push(
                "live model returned no functionCall thoughtSignature for this run",
            );
        }
    }
    const usage = firstOp(artifact.responseProgram, "response.usage");
    if (!usage?.inputTokens || !usage.outputTokens)
        throw new Error(`${artifact.scenario}: expected response.usage counts`);
    checks.push("response raises to response.usage counts");
    const expectedRoundTrip = GeminiTranslator.toResponse(
        artifact.responseProgram,
    );
    assertDeepEqual(
        artifact.responseBody,
        expectedRoundTrip,
        `${artifact.scenario} response body round-trip`,
    );
    checks.push("live response round-trips through core without shape changes");
    assertDeepEqual(
        artifact.roundTripResponseBody,
        expectedRoundTrip,
        `${artifact.scenario} saved round-trip response`,
    );
    checks.push("saved round-trip matches recomputed round-trip");
    return checks;
}

function responseBodyForTranslator(
    model: string,
    rawResponseBody: Record<string, unknown>,
): Record<string, unknown> {
    return rawResponseBody.model == null
        ? { model, ...rawResponseBody }
        : { ...rawResponseBody };
}

function chainedToolResultRequest(
    requestProgram: Program,
    responseProgram: Program,
): { program: Program; body: Record<string, unknown> } {
    const call = firstOp(responseProgram, "llm.tool_call");
    if (!call) {
        throw new Error("multimodal-tool scenario: expected llm.tool_call");
    }
    const program: Program = [
        ...requestProgram,
        ...responseProgram,
        {
            op: "llm.tool_result",
            id: call.id,
            content: JSON.stringify({
                ok: true,
                observed_arguments: call.arguments,
            }),
        },
    ];
    return { program, body: bodyFromProgram(program) };
}

function functionCallThoughtSignature(
    responseBody: Record<string, unknown>,
): string | undefined {
    const candidate = record(
        array(responseBody.candidates, "response candidates")[0],
        "response candidate",
    );
    const content = record(candidate.content, "response candidate content");
    const parts = array(content.parts, "response candidate parts");
    for (const part of parts) {
        const recordPart = record(part, "response candidate part");
        if (recordPart.functionCall != null) {
            return typeof recordPart.thoughtSignature === "string"
                ? recordPart.thoughtSignature
                : undefined;
        }
    }
    return undefined;
}

function assertChainedRequestPreservesSignature(
    body: Record<string, unknown>,
    signature: string,
): void {
    const contents = array(body.contents, "chained request contents");
    for (const contentValue of contents) {
        const content = record(contentValue, "chained request content");
        if (content.role !== "model") continue;
        const parts = array(content.parts, "chained model parts");
        for (const partValue of parts) {
            const part = record(partValue, "chained model part");
            if (part.functionCall == null) continue;
            if (part.thoughtSignature !== signature) {
                throw new Error(
                    "chained request: functionCall thoughtSignature changed",
                );
            }
            return;
        }
    }
    throw new Error(
        "chained request: expected model functionCall with thoughtSignature",
    );
}

function expectsFunctionCallThoughtSignature(model: string): boolean {
    return /^(?:models\/)?gemini-3(?:[.-]|$)/.test(model);
}

export async function writeArtifact(
    outDir: string,
    artifact: Artifact,
): Promise<string> {
    await mkdir(outDir, { recursive: true });
    const file = `${artifact.scenario}.${slug(artifact.model)}.json`;
    await Bun.write(
        join(outDir, file),
        `${JSON.stringify(artifact, null, 2)}\n`,
    );
    return file;
}

export async function writeManifest(
    outDir: string,
    manifest: Manifest,
): Promise<void> {
    await mkdir(outDir, { recursive: true });
    await Bun.write(
        join(outDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
}

export async function readSavedArtifacts(dir: string): Promise<Artifact[]> {
    const files = (await readdir(dir))
        .filter((file) => file.endsWith(".json") && file !== "manifest.json")
        .sort();
    if (files.length === 0) throw new Error(`${dir}: no saved artifacts`);
    return Promise.all(
        files.map(
            async (file) =>
                record(
                    JSON.parse(await readFile(join(dir, file), "utf8")),
                    file,
                ) as unknown as Artifact,
        ),
    );
}

function thinkingBudgetOps(model: string): Op[] {
    if (!expectsThinkingBudget(model)) return [];
    return [
        {
            op: "gemini.generation_config",
            value: { thinkingConfig: { thinkingBudget: 0 } },
        },
    ];
}

function expectsThinkingBudget(model: string): boolean {
    return (
        model.includes("gemini-2.5-flash") || model.includes("gemini-3.5-flash")
    );
}

function assertThinkingBudgetIfExpected(
    body: Record<string, unknown>,
    model: string,
): void {
    if (!expectsThinkingBudget(model)) return;
    const thinking = record(
        record(body.generationConfig, `${model} generationConfig`)
            .thinkingConfig,
        `${model} generationConfig.thinkingConfig`,
    );
    if (thinking.thinkingBudget !== 0)
        throw new Error(`${model}: expected thinkingBudget 0`);
}

function assertModel(body: Record<string, unknown>, model: string): void {
    if (body.model !== model)
        throw new Error(
            `request body: expected model ${JSON.stringify(model)}, got ${JSON.stringify(body.model)}`,
        );
}

function optionValue(args: string[], name: string): string | undefined {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function slug(value: string): string {
    return value.replace(/^models\//, "").replace(/[^a-zA-Z0-9.-]+/g, "-");
}

function assertDeepEqual(
    actual: unknown,
    expected: unknown,
    what: string,
): void {
    if (stableJson(actual) !== stableJson(expected))
        throw new Error(`${what}: round-trip mismatch`);
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (typeof value !== "object" || value === null)
        return JSON.stringify(value);
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
        .join(",")}}`;
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${what}: expected object`);
    return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${what}: expected array`);
    return value;
}

function string(value: unknown, what: string): string {
    if (typeof value !== "string") throw new Error(`${what}: expected string`);
    return value;
}

function number(value: unknown, what: string): number {
    if (typeof value !== "number") throw new Error(`${what}: expected number`);
    return value;
}
