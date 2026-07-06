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
    routes: {
        "/health": {
            GET: () => Response.json({ ok: true, model: realtimeModel }),
        },
        "/v1/models": {
            GET: () =>
                Response.json({
                    object: "list",
                    data: [
                        {
                            id: realtimeModel,
                            object: "model",
                            created: 0,
                            owned_by: "openai",
                        },
                    ],
                }),
        },
        "/v1/chat/completions": {
            POST: handleChatCompletions,
        },
    },
    fetch(request) {
        const url = new URL(request.url);
        return Response.json(
            {
                error: {
                    message: `${request.method} ${url.pathname}`,
                    type: "not_found",
                    param: null,
                    code: null,
                },
            },
            { status: 404 },
        );
    },
});

console.log(
    `openai-compatible realtime proxy listening on http://localhost:${server.port}`,
);

async function handleChatCompletions(request: Request): Promise<Response> {
    try {
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            throw new ClientError("request body must be valid JSON");
        }

        const realtimeRequest = chatRequestToRealtimeBody(body);
        const realtimeResponse = await callRealtime(realtimeRequest);
        const responseProgram =
            OpenAIRealtimeTranslator.fromResponse(realtimeResponse);
        const chatResponse = OpenAIChatTranslator.toResponse(responseProgram);

        return Response.json(chatResponse);
    } catch (error) {
        if (error instanceof ClientError) {
            return Response.json(
                {
                    error: {
                        message: error.message,
                        type: "invalid_request_error",
                        param: null,
                        code: null,
                    },
                },
                { status: 400 },
            );
        }

        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        return Response.json(
            {
                error: {
                    message,
                    type: "realtime_backend_error",
                    param: null,
                    code: null,
                },
            },
            { status: 502 },
        );
    }
}

function chatRequestToRealtimeBody(body: unknown): Record<string, unknown> {
    try {
        const requestProgram = OpenAIChatTranslator.fromBody(body);
        const realtimeProgram = prepareForRealtime(requestProgram);
        const realtimeBody = OpenAIRealtimeTranslator.toBody(realtimeProgram);
        if (
            typeof realtimeBody !== "object" ||
            realtimeBody === null ||
            Array.isArray(realtimeBody)
        ) {
            throw new Error("translated realtime request: expected object");
        }
        return realtimeBody as Record<string, unknown>;
    } catch (error) {
        const message =
            error instanceof Error ? error.message : JSON.stringify(error);
        throw new ClientError(message);
    }
}

function prepareForRealtime(program: Program): Program {
    return program.flatMap((op): Op[] => {
        if (op.op === "llm.model") {
            return [{ ...op, model: realtimeModel }];
        }
        if (op.op === "request.stream") {
            if (op.value === false) return [];
            throw new ClientError(
                "streaming is not implemented by this example",
            );
        }
        if (op.op === "openai_chat.choice_count") {
            if (op.value === 1) return [];
            throw new ClientError("only n=1 is implemented by this example");
        }
        return [op];
    });
}

async function callRealtime(
    requestBody: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const model = requestBody.model;
    if (typeof model !== "string") {
        throw new Error("realtime request model: expected string");
    }

    const inputEvents = requestBody.events;
    if (!Array.isArray(inputEvents)) {
        throw new Error("realtime request events: expected array");
    }
    const events = inputEvents.map((event) => {
        if (
            typeof event !== "object" ||
            event === null ||
            Array.isArray(event)
        ) {
            throw new Error("realtime request event: expected object");
        }
        return event as Record<string, unknown>;
    });

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
        const ws = new BunWebSocket(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
        });
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
            const receivedTypes =
                received.map((item) => String(item.type)).join(", ") || "none";
            reject(
                new Error(
                    `realtime websocket closed ${event.code} ${event.reason}; received events: ${receivedTypes}`,
                ),
            );
        };
        ws.onmessage = (message) => {
            try {
                const event = JSON.parse(String(message.data));
                if (
                    typeof event !== "object" ||
                    event === null ||
                    Array.isArray(event)
                ) {
                    throw new Error("realtime event: expected object");
                }
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

class ClientError extends Error {}
