import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AnthropicTranslator, firstOp, type Program } from "../../src/index";

export const defaultFixtureDir = resolve("e2e/anthropic/fixtures");

export type ScenarioName =
    | "thinking-signature-response"
    | "live-thinking-signature-response"
    | "provider-tool-metadata-request"
    | "server-tool-response";

type ArtifactKind = "request" | "response";

interface BaseArtifact {
    scenario: ScenarioName;
    kind: ArtifactKind;
    model: string;
}

export interface RequestArtifact extends BaseArtifact {
    kind: "request";
    requestBody: Record<string, unknown>;
}

export interface ResponseArtifact extends BaseArtifact {
    kind: "response";
    responseBody: Record<string, unknown>;
}

export type AnthropicArtifact = RequestArtifact | ResponseArtifact;

export interface ValidatedRequestArtifact extends RequestArtifact {
    requestProgram: Program;
    roundTripRequestBody: unknown;
    checks: string[];
}

export interface ValidatedResponseArtifact extends ResponseArtifact {
    responseProgram: Program;
    roundTripResponseBody: unknown;
    checks: string[];
}

export type ValidatedAnthropicArtifact =
    ValidatedRequestArtifact | ValidatedResponseArtifact;

export function fixtureDirFromArgs(args: string[]): string {
    return resolve(optionValue(args, "--dir") ?? defaultFixtureDir);
}

export async function readFixtureArtifacts(
    dir: string,
): Promise<AnthropicArtifact[]> {
    const files = (await readdir(dir))
        .filter((file) => file.endsWith(".json"))
        .sort();
    if (files.length === 0) throw new Error(`${dir}: no fixture artifacts`);
    return Promise.all(
        files.map(async (file) => {
            const artifact = record(
                JSON.parse(await readFile(join(dir, file), "utf8")),
                file,
            ) as unknown as AnthropicArtifact;
            validateFixtureEnvelope(artifact, file);
            return artifact;
        }),
    );
}

export function validateArtifact(
    artifact: AnthropicArtifact,
): ValidatedAnthropicArtifact {
    switch (artifact.kind) {
        case "request":
            return validateRequestArtifact(artifact);
        case "response":
            return validateResponseArtifact(artifact);
    }
}

function validateRequestArtifact(
    artifact: RequestArtifact,
): ValidatedRequestArtifact {
    const checks: string[] = [];
    const requestProgram = AnthropicTranslator.fromBody(artifact.requestBody);
    const roundTripRequestBody = AnthropicTranslator.toBody(requestProgram);

    assertDeepEqual(
        roundTripRequestBody,
        artifact.requestBody,
        `${artifact.scenario} request body round-trip`,
    );
    checks.push("request body round-trips without normalizing provider fields");

    validateProviderToolMetadata(artifact.requestBody, roundTripRequestBody);
    checks.push("tool metadata fields and version strings are preserved");

    return {
        ...artifact,
        requestProgram,
        roundTripRequestBody,
        checks,
    };
}

function validateResponseArtifact(
    artifact: ResponseArtifact,
): ValidatedResponseArtifact {
    const checks: string[] = [];
    const responseProgram = AnthropicTranslator.fromResponse(
        artifact.responseBody,
    );
    const roundTripResponseBody =
        AnthropicTranslator.toResponse(responseProgram);

    assertDeepEqual(
        roundTripResponseBody,
        artifact.responseBody,
        `${artifact.scenario} response body round-trip`,
    );
    checks.push("response body round-trips without content block changes");

    const usage = firstOp(responseProgram, "response.usage");
    if (!usage?.inputTokens || !usage.outputTokens) {
        throw new Error(`${artifact.scenario}: expected response.usage counts`);
    }
    checks.push("response raises to response.usage counts");

    if (
        artifact.scenario === "thinking-signature-response" ||
        artifact.scenario === "live-thinking-signature-response"
    ) {
        validateThinkingSignature(artifact.responseBody, roundTripResponseBody);
        checks.push("thinking signature is passed back byte-for-byte");
    }

    if (artifact.scenario === "server-tool-response") {
        validateServerToolPair(artifact.responseBody, roundTripResponseBody);
        checks.push("server_tool_use and result block stay paired");
    }

    return {
        ...artifact,
        responseProgram,
        roundTripResponseBody,
        checks,
    };
}

function validateProviderToolMetadata(
    originalBody: Record<string, unknown>,
    roundTripBody: unknown,
): void {
    const originalTools = array(originalBody.tools, "requestBody.tools");
    const roundTripTools = array(
        record(roundTripBody, "roundTripRequestBody").tools,
        "roundTripRequestBody.tools",
    );
    if (roundTripTools.length !== originalTools.length) {
        throw new Error(
            `provider-tool-metadata-request: expected ${originalTools.length} tools, got ${roundTripTools.length}`,
        );
    }

    for (const toolName of [
        "web_search",
        "code_execution",
        "lookup_customer",
    ]) {
        const original = toolByName(originalTools, toolName, "requestBody");
        const roundTrip = toolByName(
            roundTripTools,
            toolName,
            "roundTripRequestBody",
        );
        assertDeepEqual(
            roundTrip,
            original,
            `provider-tool-metadata-request ${toolName}`,
        );
    }

    const webSearch = toolByName(roundTripTools, "web_search", "roundTrip");
    if (webSearch.type !== "web_search_20260318") {
        throw new Error(
            `web_search type normalized to ${JSON.stringify(webSearch.type)}`,
        );
    }
    const codeExecution = toolByName(
        roundTripTools,
        "code_execution",
        "roundTrip",
    );
    if (codeExecution.type !== "code_execution_20260521") {
        throw new Error(
            `code_execution type normalized to ${JSON.stringify(codeExecution.type)}`,
        );
    }
}

function validateThinkingSignature(
    originalBody: Record<string, unknown>,
    roundTripBody: unknown,
): void {
    const originalBlock = contentBlockByType(
        originalBody,
        "thinking",
        "responseBody",
    );
    const roundTripBlock = contentBlockByType(
        record(roundTripBody, "roundTripResponseBody"),
        "thinking",
        "roundTripResponseBody",
    );
    if (originalBlock.signature !== roundTripBlock.signature) {
        throw new Error("thinking signature changed during round-trip");
    }
    assertDeepEqual(
        roundTripBlock,
        originalBlock,
        "thinking-signature-response thinking block",
    );
}

function validateServerToolPair(
    originalBody: Record<string, unknown>,
    roundTripBody: unknown,
): void {
    const originalUse = contentBlockByType(
        originalBody,
        "server_tool_use",
        "responseBody",
    );
    const roundTripUse = contentBlockByType(
        record(roundTripBody, "roundTripResponseBody"),
        "server_tool_use",
        "roundTripResponseBody",
    );
    assertDeepEqual(
        roundTripUse,
        originalUse,
        "server-tool-response server_tool_use block",
    );

    const originalResult = contentBlockByType(
        originalBody,
        "web_search_tool_result",
        "responseBody",
    );
    const roundTripResult = contentBlockByType(
        record(roundTripBody, "roundTripResponseBody"),
        "web_search_tool_result",
        "roundTripResponseBody",
    );
    assertDeepEqual(
        roundTripResult,
        originalResult,
        "server-tool-response result block",
    );

    if (roundTripResult.tool_use_id !== roundTripUse.id) {
        throw new Error(
            `server tool result points at ${JSON.stringify(roundTripResult.tool_use_id)}, expected ${JSON.stringify(roundTripUse.id)}`,
        );
    }
}

export function assertDeepEqual(
    actual: unknown,
    expected: unknown,
    label: string,
): void {
    const actualJson = canonicalJson(actual);
    const expectedJson = canonicalJson(expected);
    if (actualJson !== expectedJson) {
        throw new Error(
            `${label} mismatch\nexpected ${expectedJson}\nactual   ${actualJson}`,
        );
    }
}

function validateFixtureEnvelope(
    artifact: AnthropicArtifact,
    label: string,
): void {
    if (!artifact.scenario) throw new Error(`${label}: missing scenario`);
    const kind = (artifact as { kind?: unknown }).kind;
    if (kind !== "request" && kind !== "response") {
        throw new Error(`${label}: unsupported kind ${JSON.stringify(kind)}`);
    }
    if (!artifact.model) throw new Error(`${label}: missing model`);
    if (artifact.kind === "request") {
        record(artifact.requestBody, `${label}.requestBody`);
    } else {
        record(artifact.responseBody, `${label}.responseBody`);
    }
}

function contentBlockByType(
    body: Record<string, unknown>,
    type: string,
    label: string,
): Record<string, unknown> {
    const content = array(body.content, `${label}.content`);
    const block = content
        .map((item, index) => record(item, `${label}.content[${index}]`))
        .find((item) => item.type === type);
    if (!block) throw new Error(`${label}: missing ${type} content block`);
    return block;
}

function toolByName(
    tools: unknown[],
    name: string,
    label: string,
): Record<string, unknown> {
    const tool = tools
        .map((item, index) => record(item, `${label}.tools[${index}]`))
        .find((item) => item.name === name);
    if (!tool) throw new Error(`${label}: missing ${name} tool`);
    return tool;
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label}: expected object`);
    }
    return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label}: expected array`);
    return value;
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, sortJson(item)]),
    );
}

function optionValue(args: string[], name: string): string | undefined {
    const prefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}
