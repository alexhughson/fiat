import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    firstOp,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    translateRequest,
    translateResponse,
    type Program,
} from "../../src/index";

export const defaultModels = ["gpt-realtime-2"];
export const defaultOutputDir = resolve("e2e/openai_realtime/output/latest");
export const defaultFixtureDir = resolve("e2e/openai_realtime/fixtures");

export type ScenarioName = "text" | "tool";

export interface Artifact {
    scenario: ScenarioName;
    model: string;
    sourceRequestBody: Record<string, unknown>;
    requestBody: Record<string, unknown>;
    rawResponseEvents: Record<string, unknown>[];
    responseBody: Record<string, unknown>;
    responseProgram: Program;
    roundTripResponseBody: unknown;
    openAIChatResponse: unknown;
    durationMs: number;
    checks: string[];
}

export interface Manifest {
    generatedAt: string;
    models: string[];
    artifacts: string[];
}

export function modelsFromArgs(args: string[]): string[] {
    const raw = optionValue(args, "--models");
    if (!raw) return defaultModels;
    const models = raw
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean);
    if (models.length === 0) throw new Error("--models provided no models");
    return models;
}

export function outputDirFromArgs(args: string[]): string {
    return resolve(optionValue(args, "--out") ?? defaultOutputDir);
}

export function validationDirFromArgs(args: string[]): string {
    return resolve(optionValue(args, "--dir") ?? defaultFixtureDir);
}

export function sourceRequestBody(
    scenario: ScenarioName,
    model: string,
): Record<string, unknown> {
    if (scenario === "text") {
        return {
            model,
            messages: [
                { role: "system", content: "You answer in lowercase." },
                { role: "user", content: "Reply with exactly: pong" },
            ],
            max_tokens: 64,
        };
    }
    return {
        model,
        messages: [
            {
                role: "system",
                content: "When a tool is forced, call it and do not answer.",
            },
            { role: "user", content: "Call get_weather for Paris." },
        ],
        tools: [
            {
                type: "function",
                function: {
                    name: "get_weather",
                    description: "Get weather for a city.",
                    parameters: {
                        type: "object",
                        properties: { city: { type: "string" } },
                        required: ["city"],
                    },
                },
            },
        ],
        tool_choice: {
            type: "function",
            function: { name: "get_weather" },
        },
    };
}

export function requestBodyFromSource(
    source: Record<string, unknown>,
): Record<string, unknown> {
    return record(
        translateRequest(source, {
            from: OpenAIChatTranslator,
            to: OpenAIRealtimeTranslator,
        }),
        "realtime request body",
    );
}

export async function callRealtimeWebSocket(
    apiKey: string,
    requestBody: Record<string, unknown>,
): Promise<{ events: Record<string, unknown>[]; durationMs: number }> {
    const model = string(requestBody.model, "requestBody.model");
    const events = array(requestBody.events, "requestBody.events").map(
        (event) => record(event, "request event"),
    );
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const started = performance.now();

    return new Promise((resolve, reject) => {
        const received: Record<string, unknown>[] = [];
        const websocketOptions: Bun.WebSocketOptions = {
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
        };
        const ws = new WebSocket(url, websocketOptions as unknown as string[]);
        let sentRequest = false;
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`openai realtime ${model}: timed out`));
        }, 60_000);

        const sendRequest = () => {
            if (sentRequest) return;
            sentRequest = true;
            for (const event of events) ws.send(JSON.stringify(event));
        };
        ws.onerror = () => {};
        ws.onclose = (event) => {
            if (received.some((item) => item.type === "response.done")) return;
            clearTimeout(timeout);
            reject(
                new Error(
                    `openai realtime ${model}: websocket closed ${event.code} ${event.reason}; received events: ${eventTypes(received)}`,
                ),
            );
        };
        ws.onmessage = (message) => {
            const event = record(
                JSON.parse(String(message.data)),
                "realtime event",
            );
            received.push(event);
            if (event.type === "session.created") sendRequest();
            if (event.type === "error") {
                clearTimeout(timeout);
                ws.close();
                reject(
                    new Error(
                        `openai realtime ${model}: ${JSON.stringify(event)}`,
                    ),
                );
            }
            if (event.type === "response.done") {
                clearTimeout(timeout);
                ws.close();
                resolve({
                    events: received,
                    durationMs: Math.round(performance.now() - started),
                });
            }
        };
    });
}

export function artifactFromResponse(
    scenario: ScenarioName,
    model: string,
    sourceRequestBody: Record<string, unknown>,
    requestBody: Record<string, unknown>,
    rawResponseEvents: Record<string, unknown>[],
    durationMs: number,
): Artifact {
    const done = rawResponseEvents.find(
        (event) => event.type === "response.done",
    );
    if (!done) throw new Error(`${scenario}: response.done not found`);
    const responseBody = { events: [done] };
    const responseProgram = OpenAIRealtimeTranslator.fromResponse(responseBody);
    const artifact: Artifact = {
        scenario,
        model,
        sourceRequestBody,
        requestBody,
        rawResponseEvents,
        responseBody,
        responseProgram,
        roundTripResponseBody:
            OpenAIRealtimeTranslator.toResponse(responseProgram),
        openAIChatResponse: translateResponse(responseBody, {
            from: OpenAIRealtimeTranslator,
            to: OpenAIChatTranslator,
        }),
        durationMs,
        checks: [],
    };
    artifact.checks = validateArtifactFields(artifact);
    return artifact;
}

export function validateArtifactFields(artifact: Artifact): string[] {
    const checks: string[] = [];
    const expectedRequest = requestBodyFromSource(artifact.sourceRequestBody);
    assertDeepEqual(
        artifact.requestBody,
        expectedRequest,
        `${artifact.scenario} translated realtime request`,
    );
    checks.push(
        "source openai_chat request translates to saved realtime request",
    );
    assertDeepEqual(
        artifact.requestBody,
        OpenAIRealtimeTranslator.toBody(
            OpenAIRealtimeTranslator.fromBody(artifact.requestBody),
        ),
        `${artifact.scenario} realtime request round-trip`,
    );
    checks.push("realtime request round-trips through core");

    const responseProgram = OpenAIRealtimeTranslator.fromResponse(
        artifact.responseBody,
    );
    if (artifact.scenario === "text") {
        const text = firstOp(responseProgram, "llm.text");
        if (!text || text.role !== "assistant")
            throw new Error("text scenario: expected assistant llm.text");
        checks.push("response raises to assistant llm.text");
    } else {
        const call = firstOp(responseProgram, "llm.tool_call");
        if (!call || call.name !== "get_weather")
            throw new Error("tool scenario: expected get_weather tool call");
        checks.push("response raises to forced llm.tool_call");
    }
    const roundTrip = OpenAIRealtimeTranslator.toResponse(responseProgram);
    assertDeepEqual(
        artifact.responseBody,
        roundTrip,
        `${artifact.scenario} realtime response round-trip`,
    );
    checks.push("response.done round-trips through core");
    assertDeepEqual(
        artifact.roundTripResponseBody,
        roundTrip,
        `${artifact.scenario} saved round-trip response`,
    );
    checks.push("saved round-trip matches recomputed round-trip");
    record(artifact.openAIChatResponse, "openAIChatResponse");
    checks.push("realtime response translates to openai_chat response");
    return checks;
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

function optionValue(args: string[], name: string): string | undefined {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function slug(value: string): string {
    return value.replace(/[^a-zA-Z0-9.-]+/g, "-");
}

function assertDeepEqual(
    actual: unknown,
    expected: unknown,
    what: string,
): void {
    if (stableJson(actual) !== stableJson(expected))
        throw new Error(`${what}: mismatch`);
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

function eventTypes(events: Record<string, unknown>[]): string {
    return events.map((event) => String(event.type)).join(", ") || "none";
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
