import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    runPasses,
    type Pass,
    type Program,
} from "../src/index";

const port = Number(Bun.env.PORT ?? 3000);
const backendModel = Bun.env.OPENAI_BACKEND_MODEL ?? "gpt-5.5";
const openaiApiKey = Bun.env.OPENAI_API_KEY;
const openaiBaseUrl = Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const logDir = resolve(
    Bun.env.PROXY_LOG_DIR ??
        `examples/output/anthropic-openai-proxy/${new Date().toISOString().replaceAll(":", "-")}`,
);

if (!openaiApiKey) throw new Error("OPENAI_API_KEY is required");

await mkdir(logDir, { recursive: true });

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
            return json({
                ok: true,
                backend: "openai_chat",
                backendModel,
                logDir,
            });
        }
        if (request.method === "GET" && url.pathname === "/v1/models") {
            return json({
                object: "list",
                data: [
                    {
                        id: backendModel,
                        object: "model",
                        created: 0,
                        owned_by: "openai",
                    },
                ],
            });
        }
        if (request.method === "POST" && url.pathname === "/v1/messages") {
            return handleMessages(request);
        }
        return anthropicError(
            404,
            "not_found_error",
            `${request.method} ${url.pathname}`,
        );
    },
});

console.log(
    JSON.stringify({
        event: "proxy.started",
        url: `http://localhost:${server.port}`,
        endpoint: `http://localhost:${server.port}/v1/messages`,
        backendModel,
        logDir,
    }),
);

async function handleMessages(request: Request): Promise<Response> {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    const trace: Trace = {
        traceId,
        startedAt: new Date(startedAt).toISOString(),
        backendModel,
        steps: [],
    };

    try {
        const body = record(await readJson(request), "Anthropic request body");
        trace.anthropicRequest = body;
        const wantsStream = body.stream === true;
        const requestedModel = string(body.model, "Anthropic request model");
        const openaiRequest = anthropicRequestToOpenAI(body, trace);
        const openaiResponse = await callOpenAI(openaiRequest, trace);
        const converted = openAIResponseToAnthropic(
            openaiResponse,
            requestedModel,
            trace,
        );
        trace.anthropicResponse = converted.body;
        trace.durationMs = Date.now() - startedAt;

        if (wantsStream) {
            const streamEvents = convertedToAnthropicStreamEvents(converted);
            trace.anthropicStreamEvents = streamEvents;
            await saveTrace(trace);
            return anthropicStream(streamEvents);
        }

        await saveTrace(trace);
        return json(converted.body);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        trace.error = {
            name: error instanceof Error ? error.name : "Error",
            message,
        };
        trace.durationMs = Date.now() - startedAt;
        await saveTrace(trace);
        console.error(
            JSON.stringify({ event: "proxy.error", traceId, message }),
        );
        return anthropicError(
            error instanceof ClientError ? 400 : 502,
            error instanceof ClientError
                ? "invalid_request_error"
                : "api_error",
            message,
        );
    }
}

function anthropicRequestToOpenAI(
    body: Record<string, unknown>,
    trace: Trace,
): Record<string, unknown> {
    try {
        let core = AnthropicTranslator.fromBody(body);
        trace.steps.push({
            name: "anthropic.request.raise",
            program: core,
        });
        core = runPasses(core, requestPasses(), {
            dialect: "openai_chat",
            kind: "request",
            model: backendModel,
        });
        trace.steps.push({
            name: "proxy.request.policy",
            program: core,
        });
        const openaiBody = record(
            OpenAIChatTranslator.toBody(core),
            "OpenAI request body",
        );
        trace.openaiRequest = openaiBody;
        return openaiBody;
    } catch (error) {
        throw clientError(formatError("request conversion failed", error));
    }
}

function openAIResponseToAnthropic(
    body: Record<string, unknown>,
    requestedModel: string,
    trace: Trace,
): ConvertedAnthropicResponse {
    let core = OpenAIChatTranslator.fromResponse(body);
    trace.steps.push({
        name: "openai.response.raise",
        program: core,
    });
    core = runPasses(core, responsePasses(requestedModel), {
        dialect: "anthropic_messages",
        kind: "response",
        model: requestedModel,
    });
    trace.steps.push({
        name: "proxy.response.policy",
        program: core,
    });
    const anthropicBody = record(
        AnthropicTranslator.toResponse(core),
        "Anthropic response body",
    );
    return { body: anthropicBody, core };
}

function requestPasses(): Pass[] {
    return [
        {
            name: "examples.anthropic-openai-proxy.route-openai-model",
            run(program) {
                return program.map((op) => {
                    if (op.op === "llm.model") {
                        return { ...op, model: backendModel };
                    }
                    if (op.op === "request.stream") {
                        return { ...op, value: false };
                    }
                    return op;
                });
            },
        },
    ];
}

function responsePasses(requestedModel: string): Pass[] {
    return [
        {
            name: "examples.anthropic-openai-proxy.response-policy",
            run(program) {
                return program.map((op) =>
                    op.op === "llm.model"
                        ? { ...op, model: requestedModel }
                        : op,
                );
            },
        },
    ];
}

async function callOpenAI(
    body: Record<string, unknown>,
    trace: Trace,
): Promise<Record<string, unknown>> {
    const response = await fetch(`${openaiBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${openaiApiKey}`,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    trace.openaiStatus = response.status;
    trace.openaiResponseText = text;
    if (!response.ok) {
        throw new Error(
            `OpenAI ${response.status} ${response.statusText}: ${text}`,
        );
    }
    return record(JSON.parse(text), "OpenAI response body");
}

function convertedToAnthropicStreamEvents(
    converted: ConvertedAnthropicResponse,
): Record<string, unknown>[] {
    return AnthropicTranslator.toStreamResponses(converted.core).map((event) =>
        record(event, "Anthropic stream event"),
    );
}

function anthropicStream(events: Record<string, unknown>[]): Response {
    return new Response(events.map(formatSse).join(""), {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        },
    });
}

function formatSse(event: Record<string, unknown>): string {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function readJson(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        throw clientError("request body must be valid JSON");
    }
}

async function saveTrace(trace: Trace): Promise<void> {
    const file = join(logDir, `${trace.startedAt}-${trace.traceId}.json`);
    await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`);
    console.log(
        JSON.stringify({
            event: trace.error ? "proxy.trace.error" : "proxy.trace.saved",
            traceId: trace.traceId,
            file,
            durationMs: trace.durationMs,
            openaiStatus: trace.openaiStatus,
        }),
    );
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function anthropicError(
    status: number,
    type: string,
    message: string,
): Response {
    return json({ type: "error", error: { type, message } }, status);
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${what}: expected object`);
    }
    return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
    if (typeof value !== "string") throw new Error(`${what}: expected string`);
    return value;
}

function clientError(message: string): ClientError {
    return new ClientError(message);
}

function formatError(prefix: string, error: unknown): string {
    const message =
        error instanceof Error ? error.message : JSON.stringify(error);
    return `${prefix}: ${message}`;
}

class ClientError extends Error {}

interface Trace {
    traceId: string;
    startedAt: string;
    backendModel: string;
    durationMs?: number;
    anthropicRequest?: Record<string, unknown>;
    openaiRequest?: Record<string, unknown>;
    openaiStatus?: number;
    openaiResponseText?: string;
    anthropicResponse?: Record<string, unknown>;
    anthropicStreamEvents?: Record<string, unknown>[];
    error?: { name: string; message: string };
    steps: Array<{ name: string; program: Program }>;
}

interface ConvertedAnthropicResponse {
    body: Record<string, unknown>;
    core: Program;
}
