import { describe, expect, test } from "bun:test";
import {
    createAssistantAccumulator,
    OpenAIChatTranslator,
    OpenAIResponsesTranslator,
    type Program,
} from "../../src/index";
import {
    completeResponse,
    ERROR_BODY_EXCERPT_MAX,
    ProviderRequestError,
    streamResponse,
} from "../../src/client";

const requestProgram: Program = [
    { op: "llm.model", model: "gpt-4o" },
    {
        op: "openai_chat.message",
        message: { role: "user", content: "hello" },
    },
];

const responsesProgram: Program = [
    { op: "llm.model", model: "gpt-5.4" },
    { op: "llm.text", role: "user", content: "hi" },
];

const responsesProgramWithStoreFalse: Program = [
    ...responsesProgram,
    { op: "request.store", value: false },
];

const responsesWireResponse = {
    id: "resp_test",
    object: "response",
    created_at: 1783049000,
    status: "completed",
    model: "gpt-5.4",
    output: [
        {
            id: "msg_test",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
                {
                    type: "output_text",
                    text: "pong",
                    annotations: [],
                    logprobs: [],
                },
            ],
        },
    ],
    usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 14,
    },
    incomplete_details: null,
};

function chunk(content: string, finishReason: string | null = null) {
    return {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o",
        choices: [
            {
                index: 0,
                delta: { role: "assistant", content },
                finish_reason: finishReason,
                logprobs: null,
            },
        ],
    };
}

function sseBody(events: string[]): string {
    return events.join("");
}

describe("client transport", () => {
    test("streamResponse yields raised programs from fixture SSE chunks", async () => {
        const body = sseBody([
            `data: ${JSON.stringify(chunk("hel"))}\n\n`,
            `data: ${JSON.stringify(chunk("lo"))}\n\n`,
            "data: [DONE]\n\n",
        ]);
        const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
        const fetchFn: typeof fetch = async (url, init) => {
            fetchCalls.push({ url, init: init ?? {} });
            return new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        };

        const programs: Program[] = [];
        for await (const program of streamResponse(
            OpenAIChatTranslator,
            requestProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        )) {
            programs.push(program);
        }

        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]!.url).toBe(
            "https://api.openai.com/v1/chat/completions",
        );
        const sentBody = JSON.parse(fetchCalls[0]!.init.body as string) as {
            stream?: boolean;
            model?: string;
        };
        expect(sentBody.stream).toBe(true);
        expect(sentBody.model).toBe("gpt-4o");

        expect(programs).toHaveLength(2);
        expect(programs[0]).toEqual(
            expect.arrayContaining([
                { op: "response.text_delta", role: "assistant", content: "hel" },
            ]),
        );
        expect(programs[1]).toEqual(
            expect.arrayContaining([
                { op: "response.text_delta", role: "assistant", content: "lo" },
            ]),
        );
    });

    test("streamResponse parses SSE events split across ReadableStream reads", async () => {
        const encoder = new TextEncoder();
        const chunks = [
            `data: ${JSON.stringify(chunk("hel"))}`,
            `\n\ndata: ${JSON.stringify(chunk("lo"))}\n\n`,
            "data: [DONE]\n\n",
        ];
        let readIndex = 0;
        const fetchFn: typeof fetch = async () =>
            new Response(
                new ReadableStream({
                    pull(controller) {
                        if (readIndex >= chunks.length) {
                            controller.close();
                            return;
                        }
                        controller.enqueue(encoder.encode(chunks[readIndex]!));
                        readIndex += 1;
                    },
                }),
                {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                },
            );

        const programs: Program[] = [];
        for await (const program of streamResponse(
            OpenAIChatTranslator,
            requestProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        )) {
            programs.push(program);
        }

        expect(programs).toHaveLength(2);
        expect(programs[0]).toEqual(
            expect.arrayContaining([
                { op: "response.text_delta", role: "assistant", content: "hel" },
            ]),
        );
        expect(programs[1]).toEqual(
            expect.arrayContaining([
                { op: "response.text_delta", role: "assistant", content: "lo" },
            ]),
        );
    });

    test("openrouter variant legalizes reasoning through client transport", async () => {
        const openrouterProgram: Program = [
            { op: "llm.model", model: "openai/gpt-5.4-mini" },
            { op: "llm.thinking", effort: "off" },
            { op: "llm.text", role: "user", content: "hi" },
        ];
        const fetchCalls: Array<{ body: string }> = [];
        const fetchFn: typeof fetch = async (_url, init) => {
            fetchCalls.push({ body: init?.body as string });
            return new Response("data: [DONE]\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        };

        for await (const _program of streamResponse(
            OpenAIChatTranslator,
            openrouterProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://openrouter.ai/api/v1",
                variant: "openrouter",
                fetch: fetchFn,
            },
        )) {
            // drain
        }

        const sentBody = JSON.parse(fetchCalls[0]!.body) as {
            reasoning?: { effort: string; exclude: boolean };
        };
        expect(sentBody.reasoning).toEqual({ effort: "none", exclude: true });
    });

    test("non-2xx responses produce structured ProviderRequestError", async () => {
        const fetchFn: typeof fetch = async () =>
            new Response('{"error":"rate limited"}', {
                status: 429,
                headers: {
                    "content-type": "application/json",
                    "x-ratelimit-remaining": "0",
                },
            });

        let caught: ProviderRequestError | undefined;
        try {
            for await (const _program of streamResponse(
                OpenAIChatTranslator,
                requestProgram,
                {
                    apiKey: "sk-test",
                    baseUrl: "https://api.openai.com/v1",
                    fetch: fetchFn,
                },
            )) {
                // drain
            }
        } catch (error) {
            caught = error as ProviderRequestError;
        }

        expect(caught).toBeInstanceOf(ProviderRequestError);
        expect(caught?.status).toBe(429);
        expect(caught?.dialect).toBe("openai_chat");
        expect(caught?.bodyExcerpt).toContain("rate limited");
        expect(caught?.headers["x-ratelimit-remaining"]).toBe("0");
        expect(caught?.message).toContain("HTTP 429");
    });

    test("completeResponse non-2xx throws structured ProviderRequestError", async () => {
        const fetchFn: typeof fetch = async () =>
            new Response('{"error":"bad request"}', {
                status: 400,
                headers: { "content-type": "application/json" },
            });

        let caught: ProviderRequestError | undefined;
        try {
            await completeResponse(OpenAIChatTranslator, requestProgram, {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            });
        } catch (error) {
            caught = error as ProviderRequestError;
        }

        expect(caught).toBeInstanceOf(ProviderRequestError);
        expect(caught?.status).toBe(400);
        expect(caught?.dialect).toBe("openai_chat");
        expect(caught?.bodyExcerpt).toContain("bad request");
        expect(caught?.message).toContain("HTTP 400");
    });

    test("completeResponse truncates error body excerpts longer than 800 chars", async () => {
        const longBody = "x".repeat(1000);
        const fetchFn: typeof fetch = async () =>
            new Response(longBody, {
                status: 502,
                headers: { "content-type": "text/plain" },
            });

        let caught: ProviderRequestError | undefined;
        try {
            await completeResponse(OpenAIChatTranslator, requestProgram, {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            });
        } catch (error) {
            caught = error as ProviderRequestError;
        }

        expect(caught).toBeInstanceOf(ProviderRequestError);
        expect(caught?.bodyExcerpt).toHaveLength(ERROR_BODY_EXCERPT_MAX);
        expect(caught?.bodyExcerpt).toBe("x".repeat(ERROR_BODY_EXCERPT_MAX));
        expect(caught?.message).toContain("x".repeat(ERROR_BODY_EXCERPT_MAX));
    });

    test("onPayload can replace the outgoing body", async () => {
        const fetchCalls: Array<{ body: string }> = [];
        const fetchFn: typeof fetch = async (_url, init) => {
            fetchCalls.push({ body: init?.body as string });
            return new Response("data: [DONE]\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        };

        for await (const _program of streamResponse(
            OpenAIChatTranslator,
            requestProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
                onPayload: (body) => ({
                    ...(body as Record<string, unknown>),
                    user: "replaced",
                }),
            },
        )) {
            // drain
        }

        const sentBody = JSON.parse(fetchCalls[0]!.body) as { user?: string };
        expect(sentBody.user).toBe("replaced");
    });

    test("onResponse receives status and headers", async () => {
        let seen:
            | {
                  status: number;
                  headers: Record<string, string>;
                  dialect: string;
              }
            | undefined;
        const fetchFn: typeof fetch = async () =>
            new Response("data: [DONE]\n\n", {
                status: 200,
                headers: {
                    "content-type": "text/event-stream",
                    "x-ratelimit-remaining-requests": "4999",
                },
            });

        for await (const _program of streamResponse(
            OpenAIChatTranslator,
            requestProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
                onResponse: (response, meta) => {
                    seen = {
                        status: response.status,
                        headers: response.headers,
                        dialect: meta.dialect,
                    };
                },
            },
        )) {
            // drain
        }

        expect(seen).toEqual({
            status: 200,
            headers: expect.objectContaining({
                "x-ratelimit-remaining-requests": "4999",
            }),
            dialect: "openai_chat",
        });
    });

    test("abort signal propagates through stream parsing", async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const fetchFn: typeof fetch = async () =>
            new Response(
                new ReadableStream({
                    start(streamController) {
                        streamController.enqueue(
                            encoder.encode(
                                `data: ${JSON.stringify(chunk("partial"))}\n\n`,
                            ),
                        );
                        controller.abort();
                    },
                }),
                {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                },
            );

        const pending = (async () => {
            for await (const _program of streamResponse(
                OpenAIChatTranslator,
                requestProgram,
                {
                    apiKey: "sk-test",
                    baseUrl: "https://api.openai.com/v1",
                    fetch: fetchFn,
                    signal: controller.signal,
                },
            )) {
                // drain
            }
        })();

        await expect(pending).rejects.toThrow("Request was aborted");
    });

    test("completeResponse returns raised program from non-streaming body", async () => {
        const responseBody = {
            id: "chatcmpl-complete",
            object: "chat.completion",
            created: 1700000000,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "done" },
                    finish_reason: "stop",
                    logprobs: null,
                },
            ],
            usage: {
                prompt_tokens: 3,
                completion_tokens: 1,
                total_tokens: 4,
            },
        };
        const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
        const fetchFn: typeof fetch = async (url, init) => {
            fetchCalls.push({ url, init: init ?? {} });
            return new Response(JSON.stringify(responseBody), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        };

        const program = await completeResponse(
            OpenAIChatTranslator,
            requestProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        );

        expect(fetchCalls).toHaveLength(1);
        const sentBody = JSON.parse(fetchCalls[0]!.init.body as string) as {
            stream?: boolean;
        };
        expect(sentBody.stream).toBe(false);
        expect(program).toEqual(
            expect.arrayContaining([
                { op: "llm.text", role: "assistant", content: "done" },
                { op: "response.stop", reason: "end_turn" },
            ]),
        );
    });
});

describe("openai_responses request.store via client", () => {
    test("completeResponse omits store when program has no request.store op", async () => {
        const fetchCalls: Array<{ body: string }> = [];
        const fetchFn: typeof fetch = async (_url, init) => {
            fetchCalls.push({ body: init?.body as string });
            return new Response(JSON.stringify(responsesWireResponse), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        };

        await completeResponse(OpenAIResponsesTranslator, responsesProgram, {
            apiKey: "sk-test",
            baseUrl: "https://api.openai.com/v1",
            fetch: fetchFn,
        });

        const sentBody = JSON.parse(fetchCalls[0]!.body) as { store?: boolean };
        expect(sentBody).not.toHaveProperty("store");
    });

    test("completeResponse sends store:false when program includes request.store", async () => {
        const fetchCalls: Array<{ body: string }> = [];
        const fetchFn: typeof fetch = async (_url, init) => {
            fetchCalls.push({ body: init?.body as string });
            return new Response(JSON.stringify(responsesWireResponse), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        };

        await completeResponse(
            OpenAIResponsesTranslator,
            responsesProgramWithStoreFalse,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        );

        const sentBody = JSON.parse(fetchCalls[0]!.body) as { store?: boolean };
        expect(sentBody.store).toBe(false);
    });

    test("streamResponse omits store when program has no request.store op", async () => {
        const fetchCalls: Array<{ body: string }> = [];
        const fetchFn: typeof fetch = async (_url, init) => {
            fetchCalls.push({ body: init?.body as string });
            return new Response("data: [DONE]\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        };

        for await (const _program of streamResponse(
            OpenAIResponsesTranslator,
            responsesProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        )) {
            // drain
        }

        const sentBody = JSON.parse(fetchCalls[0]!.body) as { store?: boolean };
        expect(sentBody).not.toHaveProperty("store");
    });

    test("streamResponse sends store:false when program includes request.store", async () => {
        const fetchCalls: Array<{ body: string }> = [];
        const fetchFn: typeof fetch = async (_url, init) => {
            fetchCalls.push({ body: init?.body as string });
            return new Response("data: [DONE]\n\n", {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });
        };

        for await (const _program of streamResponse(
            OpenAIResponsesTranslator,
            responsesProgramWithStoreFalse,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        )) {
            // drain
        }

        const sentBody = JSON.parse(fetchCalls[0]!.body) as { store?: boolean };
        expect(sentBody.store).toBe(false);
    });
});

describe("client + accumulator integration", () => {
    test("openai_chat SSE session folds to expected final message", async () => {
        const body = sseBody([
            `data: ${JSON.stringify(chunk("Hello"))}\n\n`,
            `data: ${JSON.stringify(chunk(", world!"))}\n\n`,
            `data: ${JSON.stringify({
                ...chunk("", "stop"),
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: "stop",
                        logprobs: null,
                    },
                ],
            })}\n\n`,
            "data: [DONE]\n\n",
        ]);
        const fetchFn: typeof fetch = async () =>
            new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            });

        const accumulator = createAssistantAccumulator({ model: "gpt-4o" });
        for await (const program of streamResponse(
            OpenAIChatTranslator,
            requestProgram,
            {
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
                fetch: fetchFn,
            },
        )) {
            accumulator.push(program);
        }
        const message = accumulator.finish();

        expect(message.model).toBe("gpt-4o");
        expect(message.content).toEqual([
            { type: "text", text: "Hello, world!" },
        ]);
        expect(message.stopReason).toBe("stop");
    });
});
