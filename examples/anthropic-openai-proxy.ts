import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    type Program,
    type Stage,
} from "../src/index";

const port = Number(Bun.env.PORT ?? 3000);
const backendModel = Bun.env.OPENAI_BACKEND_MODEL ?? "gpt-5.5";
const openaiApiKey = Bun.env.OPENAI_API_KEY;
const openaiBaseUrl = Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com";

if (!openaiApiKey) throw new Error("OPENAI_API_KEY is required");

const server = Bun.serve({
    port,
    routes: {
        "/health": health,
        "/v1/models": models,
        "/v1/messages": messages,
    },
    fetch: notFound,
});

console.log(
    JSON.stringify({
        event: "proxy.started",
        url: `http://localhost:${server.port}`,
        endpoint: `http://localhost:${server.port}/v1/messages`,
        backendModel,
    }),
);

function health(request: Request): Response {
    if (request.method !== "GET") return notFound(request);
    return Response.json({
        ok: true,
        backend: "openai_chat",
        backendModel,
    });
}

function models(request: Request): Response {
    if (request.method !== "GET") return notFound(request);
    return Response.json({
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

async function messages(request: Request): Promise<Response> {
    try {
        if (request.method !== "POST") return notFound(request);

        const { body, requestedModel, wantsStream } =
            await readAnthropicRequest(request);
        const openaiRequest = anthropicRequestToOpenAI(body);
        const openaiResponse = await callOpenAI(openaiRequest);
        const converted = openAIResponseToAnthropic(
            openaiResponse,
            requestedModel,
        );

        if (wantsStream) {
            return anthropicStream(convertedToAnthropicStreamEvents(converted));
        }

        return Response.json(converted.body);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        console.error(JSON.stringify({ event: "proxy.error", message }));
        return Response.json(
            {
                type: "error",
                error: {
                    type:
                        error instanceof ClientError
                            ? "invalid_request_error"
                            : "api_error",
                    message,
                },
            },
            { status: error instanceof ClientError ? 400 : 502 },
        );
    }
}

function notFound(request: Request): Response {
    const url = new URL(request.url);
    return Response.json(
        {
            type: "error",
            error: {
                type: "not_found_error",
                message: `${request.method} ${url.pathname}`,
            },
        },
        { status: 404 },
    );
}

function anthropicRequestToOpenAI(
    body: Record<string, unknown>,
): Record<string, unknown> {
    try {
        const core = requestStages().reduce(
            (current, stage) => stage(current),
            AnthropicTranslator.fromBody(body),
        );
        return record(OpenAIChatTranslator.toBody(core), "OpenAI request body");
    } catch (error) {
        throw clientError(formatError("request conversion failed", error));
    }
}

function openAIResponseToAnthropic(
    body: Record<string, unknown>,
    requestedModel: string,
): ConvertedAnthropicResponse {
    const core = responseStages(requestedModel).reduce(
        (current, stage) => stage(current),
        OpenAIChatTranslator.fromResponse(body),
    );
    const anthropicBody = record(
        AnthropicTranslator.toResponse(core),
        "Anthropic response body",
    );
    return { body: anthropicBody, core };
}

function requestStages(): Stage[] {
    return [
        (program) =>
            program.map((op) => {
                if (op.op === "llm.model") {
                    return { ...op, model: backendModel };
                }
                if (op.op === "request.stream") {
                    return { ...op, value: false };
                }
                return op;
            }),
    ];
}

function responseStages(requestedModel: string): Stage[] {
    return [
        (program) =>
            program.map((op) =>
                op.op === "llm.model" ? { ...op, model: requestedModel } : op,
            ),
    ];
}

async function callOpenAI(
    body: Record<string, unknown>,
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

async function readAnthropicRequest(
    request: Request,
): Promise<AnthropicRequest> {
    try {
        const body = record(await readJson(request), "Anthropic request body");
        return {
            body,
            requestedModel: string(body.model, "Anthropic request model"),
            wantsStream: body.stream === true,
        };
    } catch (error) {
        if (error instanceof ClientError) throw error;
        throw clientError(formatError("invalid Anthropic request", error));
    }
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

interface ConvertedAnthropicResponse {
    body: Record<string, unknown>;
    core: Program;
}

interface AnthropicRequest {
    body: Record<string, unknown>;
    requestedModel: string;
    wantsStream: boolean;
}
