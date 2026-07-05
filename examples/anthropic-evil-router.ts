import {
    AnthropicTranslator,
    GeminiTranslator,
    type Program,
} from "../src/index";

const port = Number(Bun.env.PORT ?? 3000);
const anthropicKey = Bun.env.ANTHROPIC_API_KEY;
const geminiKey = Bun.env.GEMINI_API_KEY;
const anthropicBaseUrl =
    Bun.env.ANTHROPIC_UPSTREAM_BASE_URL ?? "https://api.anthropic.com";
const geminiModel = Bun.env.GEMINI_BACKEND_MODEL ?? "models/gemini-2.5-pro";

if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is required");
if (!geminiKey) throw new Error("GEMINI_API_KEY is required");

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
            return json({ ok: true, geminiModel });
        }
        if (request.method !== "POST" || url.pathname !== "/v1/messages") {
            return anthropicError(
                404,
                "not_found_error",
                `${request.method} ${url.pathname}`,
            );
        }

        try {
            const body = record(await request.json(), "anthropic request");
            const core = AnthropicTranslator.fromBody(body);
            const requestedModel = string(
                body.model,
                "anthropic request.model",
            );
            const route = hasEvilPromptText(core) ? "gemini" : "anthropic";

            console.log(
                JSON.stringify({ event: "route", route, requestedModel }),
            );

            if (route === "anthropic") return callAnthropic(body);
            if (body.stream === true) {
                return anthropicError(
                    400,
                    "invalid_request_error",
                    "gemini-routed requests do not support stream: true in this example",
                );
            }

            const geminiResponse = await callGemini(
                record(
                    GeminiTranslator.toBody(
                        setModel(geminiModel)(
                            AnthropicTranslator.fromBody(body),
                        ),
                    ),
                    "gemini request",
                ),
            );

            return json(
                AnthropicTranslator.toResponse(
                    setModel(requestedModel)(
                        GeminiTranslator.fromResponse({
                            model: geminiModel,
                            ...geminiResponse,
                        }),
                    ),
                ),
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({ event: "error", message }));
            return anthropicError(502, "api_error", message);
        }
    },
});

console.log(
    `anthropic evil router: http://localhost:${server.port}/v1/messages`,
);

function hasEvilPromptText(program: Program): boolean {
    return program.some(
        (op) =>
            op.op === "llm.text" &&
            typeof op.content === "string" &&
            /\bevil\b/i.test(op.content),
    );
}

function setModel(model: string) {
    return (program: Program): Program =>
        program.map((op) => (op.op === "llm.model" ? { ...op, model } : op));
}

async function callAnthropic(body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(`${anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": anthropicKey!,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });
    return new Response(response.body, {
        status: response.status,
        headers: response.headers,
    });
}

async function callGemini(
    body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const model = string(body.model, "gemini request.model");
    const { model: _model, ...generateContentBody } = body;
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-goog-api-key": geminiKey!,
            },
            body: JSON.stringify(generateContentBody),
        },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${text}`);
    return record(JSON.parse(text), "gemini response");
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
