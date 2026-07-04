import {
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    type Op,
    type Program,
} from "../src/index";

// Run:
//   OPENAI_API_KEY=... bun examples/openai-realtime-chat-server.ts
// Then point an OpenAI Chat Completions client at:
//   http://localhost:3000/v1/chat/completions

const port = Number(Bun.env.PORT ?? 3000);
const realtimeModel = Bun.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2";
const apiKey = Bun.env.OPENAI_API_KEY;
const BunWebSocket = WebSocket as unknown as {
    new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket;
};

if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const server = Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/health") {
            return json({ ok: true, model: realtimeModel });
        }
        if (request.method === "GET" && url.pathname === "/v1/models") {
            return json({
                object: "list",
                data: [
                    {
                        id: realtimeModel,
                        object: "model",
                        created: 0,
                        owned_by: "openai",
                    },
                ],
            });
        }
        if (
            request.method === "POST" &&
            url.pathname === "/v1/chat/completions"
        ) {
            return handleChatCompletions(request);
        }
        return jsonError(404, "not_found", `${request.method} ${url.pathname}`);
    },
});

console.log(
    `openai-compatible realtime proxy listening on http://localhost:${server.port}`,
);

async function handleChatCompletions(request: Request): Promise<Response> {
    try {
        const body = await readJson(request);
        const realtimeRequest = chatRequestToRealtimeBody(body);
        const realtimeResponse = await callRealtime(realtimeRequest);
        const responseProgram =
            OpenAIRealtimeTranslator.fromResponse(realtimeResponse);
        const chatResponse = OpenAIChatTranslator.toResponse(responseProgram);

        return json(chatResponse);
    } catch (error) {
        if (error instanceof ClientError) {
            return jsonError(400, "invalid_request_error", error.message);
        }
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        return jsonError(502, "realtime_backend_error", message);
    }
}

function chatRequestToRealtimeBody(body: unknown): Record<string, unknown> {
    try {
        const requestProgram = OpenAIChatTranslator.fromBody(body);
        const realtimeProgram = prepareForRealtime(requestProgram);
        return record(
            OpenAIRealtimeTranslator.toBody(realtimeProgram),
            "translated realtime request",
        );
    } catch (error) {
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        throw clientError(message);
    }
}

function prepareForRealtime(program: Program): Program {
    return program.flatMap((op): Op[] => {
        if (op.op === "llm.model") {
            return [{ ...op, model: realtimeModel }];
        }
        if (op.op === "request.stream") {
            if (op.value === false) return [];
            throw clientError("streaming is not implemented by this example");
        }
        if (op.op === "openai_chat.choice_count") {
            if (op.value === 1) return [];
            throw clientError("only n=1 is implemented by this example");
        }
        return [op];
    });
}

async function callRealtime(
    requestBody: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const model = string(requestBody.model, "realtime request model");
    const events = array(requestBody.events, "realtime request events").map(
        (event) => record(event, "realtime request event"),
    );
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const responseEvents = await collectRealtimeEvents(url, events);
    const done = responseEvents.find((event) => event.type === "response.done");
    if (!done) throw new Error("realtime response.done not received");
    return { events: [done] };
}

function collectRealtimeEvents(
    url: string,
    events: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
        const received: Record<string, unknown>[] = [];
        const ws = new BunWebSocket(url, websocketOptions());
        let sentRequest = false;
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("realtime websocket timed out"));
        }, 60_000);

        const sendRequest = () => {
            if (sentRequest) return;
            sentRequest = true;
            for (const event of events) ws.send(JSON.stringify(event));
        };
        ws.onerror = (event) => {
            console.error("realtime websocket error", event);
        };
        ws.onclose = (event) => {
            if (received.some((item) => item.type === "response.done")) return;
            clearTimeout(timeout);
            reject(
                new Error(
                    `realtime websocket closed ${event.code} ${event.reason}; received events: ${eventTypes(received)}`,
                ),
            );
        };
        ws.onmessage = (message) => {
            try {
                const event = record(
                    JSON.parse(String(message.data)),
                    "realtime event",
                );
                received.push(event);
                if (event.type === "session.created") sendRequest();
                if (event.type === "error") {
                    clearTimeout(timeout);
                    ws.close();
                    reject(new Error(JSON.stringify(event)));
                    return;
                }
                if (event.type === "response.done") {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(received);
                }
            } catch (error) {
                clearTimeout(timeout);
                ws.close();
                reject(error);
            }
        };
    });
}

async function readJson(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        throw clientError("request body must be valid JSON");
    }
}

function websocketOptions(): Bun.WebSocketOptions {
    return {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    };
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function jsonError(status: number, type: string, message: string): Response {
    return json(
        {
            error: {
                message,
                type,
                param: null,
                code: null,
            },
        },
        status,
    );
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${what}: expected object`);
    }
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

function eventTypes(events: Record<string, unknown>[]): string {
    return events.map((event) => String(event.type)).join(", ") || "none";
}

function clientError(message: string): ClientError {
    return new ClientError(message);
}

class ClientError extends Error {}
