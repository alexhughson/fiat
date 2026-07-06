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
    routes: {
        "/health": health,
        "/v1/messages": messages,
    },
    fetch: notFound,
});

console.log(
    `anthropic evil router: http://localhost:${server.port}/v1/messages`,
);

function health(request: Request): Response {
    if (request.method !== "GET") return notFound(request);
    return Response.json({ ok: true, geminiModel });
}

async function messages(request: Request): Promise<Response> {
    try {
        if (request.method !== "POST") return notFound(request);

        const body = (await request.json()) as Record<string, unknown>;
        const core = AnthropicTranslator.fromBody(body);
        const requestedModel = body.model as string;
        const route = hasEvilPromptText(core) ? "gemini" : "anthropic";

        console.log(JSON.stringify({ event: "route", route, requestedModel }));

        if (route === "anthropic") return callAnthropic(body);
        if (body.stream === true) {
            return Response.json(
                {
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message:
                            "gemini-routed requests do not support stream: true in this example",
                    },
                },
                { status: 400 },
            );
        }

        const geminiRequest = GeminiTranslator.toBody(
            setModel(geminiModel)(core),
        ) as Record<string, unknown>;
        const geminiResponse = await callGemini(geminiRequest);
        const anthropicResponse = AnthropicTranslator.toResponse(
            setModel(requestedModel)(
                GeminiTranslator.fromResponse({
                    model: geminiModel,
                    ...geminiResponse,
                }),
            ),
        );

        return Response.json(anthropicResponse);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: "error", message }));
        return Response.json(
            {
                type: "error",
                error: { type: "api_error", message },
            },
            { status: 502 },
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
    const model = body.model as string;
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
    return JSON.parse(text) as Record<string, unknown>;
}
