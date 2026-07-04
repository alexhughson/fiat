// Live end-to-end proof against real provider APIs. Bun loads .env
// automatically; suites skip when the relevant key is absent so `bun test`
// stays green in keyless environments. These are the tests that make
// "verified" mean something — the unit suites only prove shape mapping.

import { describe, expect, test } from "bun:test";
import {
    append,
    firstOp,
    opsOf,
    translateRequest,
    translateResponse,
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    type Program,
} from "../src/index";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const OPENAI_MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const GEMINI_MODEL = "models/gemini-3.5-flash";

async function callOpenAI(body: unknown): Promise<unknown> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    return res.json();
}

async function callAnthropic(body: unknown): Promise<unknown> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": ANTHROPIC_KEY!,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    return res.json();
}

async function callGemini(body: unknown): Promise<unknown> {
    const request = body as { model?: unknown; [key: string]: unknown };
    const model = String(request.model);
    const { model: _model, ...generateContentBody } = request;
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${GEMINI_KEY}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(generateContentBody),
        },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
    return { model, ...(await res.json()) };
}

const weatherTool = {
    op: "llm.tool",
    name: "get_weather",
    description: "Get the current weather for a city.",
    inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
    },
} as const;

describe.skipIf(!OPENAI_KEY)("live: openai_chat", () => {
    test("core program -> wire -> real completion -> core program", async () => {
        const request: Program = [
            { op: "llm.model", model: OPENAI_MODEL },
            { op: "llm.max_output_tokens", value: 50 },
            {
                op: "llm.text",
                role: "user",
                content: "Reply with exactly the word: pong",
            },
        ];

        const response = OpenAIChatTranslator.fromResponse(
            await callOpenAI(OpenAIChatTranslator.toBody(request)),
        );

        const text = firstOp(response, "llm.text");
        expect(text?.role).toBe("assistant");
        expect(text?.content.toLowerCase()).toContain("pong");
        expect(
            firstOp(response, "response.usage")?.outputTokens,
        ).toBeGreaterThan(0);
        expect(firstOp(response, "response.stop")?.reason).toBe("end_turn");
    }, 30_000);

    test("a forced tool choice raises to llm.tool_call with parsed arguments", async () => {
        const request: Program = [
            { op: "llm.model", model: OPENAI_MODEL },
            weatherTool,
            { op: "llm.tool_choice", value: { name: "get_weather" } },
            {
                op: "llm.text",
                role: "user",
                content: "What's the weather in Paris?",
            },
        ];

        const response = OpenAIChatTranslator.fromResponse(
            await callOpenAI(OpenAIChatTranslator.toBody(request)),
        );

        const call = firstOp(response, "llm.tool_call");
        expect(call?.name).toBe("get_weather");
        expect(String((call?.arguments as { city?: string }).city)).toMatch(
            /paris/i,
        );
        // Observed API behavior: a *forced* tool choice finishes with "stop",
        // not "tool_calls" — openai only reports tool_calls when the model
        // chose to call. So this raises to end_turn, and code deciding "did it
        // call a tool" must look for llm.tool_call ops, not the stop reason.
        expect(firstOp(response, "response.stop")?.reason).toBe("end_turn");
    }, 30_000);
});

describe.skipIf(!OPENAI_KEY)("live: multi-turn chaining", () => {
    test("appending a real response program onto the request drives the next turn", async () => {
        // The agent-loop use case: turn 1 returns a tool call; the client
        // appends the raised response ops plus a tool result and sends the
        // grown program back. response.* ops and response-only residuals from
        // the appended turn must strip cleanly out of the second request.
        const turn1: Program = [
            { op: "llm.model", model: OPENAI_MODEL },
            weatherTool,
            { op: "llm.tool_choice", value: { name: "get_weather" } },
            {
                op: "llm.text",
                role: "user",
                content: "What's the weather in Paris?",
            },
        ];
        const response1 = OpenAIChatTranslator.fromResponse(
            await callOpenAI(OpenAIChatTranslator.toBody(turn1)),
        );
        const call = firstOp(response1, "llm.tool_call");
        expect(call?.name).toBe("get_weather");

        const turn2 = append(
            [
                ...turn1.filter((op) => op.op !== "llm.tool_choice"),
                ...response1,
            ],
            {
                op: "llm.tool_result",
                id: call!.id,
                content: '{"temp_c": 21, "sky": "clear"}',
            },
        );
        const response2 = OpenAIChatTranslator.fromResponse(
            await callOpenAI(OpenAIChatTranslator.toBody(turn2)),
        );

        const text = firstOp(response2, "llm.text");
        expect(text?.role).toBe("assistant");
        expect(text?.content).toMatch(/21|clear/i);
    }, 60_000);
});

describe.skipIf(!ANTHROPIC_KEY)("live: anthropic_messages", () => {
    test("core program -> wire -> real completion -> core program", async () => {
        const request: Program = [
            { op: "llm.model", model: ANTHROPIC_MODEL },
            { op: "llm.max_output_tokens", value: 50 },
            {
                op: "llm.text",
                role: "system",
                content: "You answer with a single word.",
            },
            {
                op: "llm.text",
                role: "user",
                content: "Reply with exactly the word: pong",
            },
        ];

        const response = AnthropicTranslator.fromResponse(
            await callAnthropic(AnthropicTranslator.toBody(request)),
        );

        const text = firstOp(response, "llm.text");
        expect(text?.role).toBe("assistant");
        expect(text?.content.toLowerCase()).toContain("pong");
        expect(
            firstOp(response, "response.usage")?.outputTokens,
        ).toBeGreaterThan(0);
    }, 30_000);
});

describe.skipIf(!GEMINI_KEY)("live: gemini", () => {
    test("core program -> wire -> real completion -> core program", async () => {
        const request: Program = [
            { op: "llm.model", model: GEMINI_MODEL },
            { op: "llm.max_output_tokens", value: 50 },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingBudget: 0 } },
            },
            {
                op: "llm.text",
                role: "system",
                content: "You answer with a single word.",
            },
            {
                op: "llm.text",
                role: "user",
                content: "Reply with exactly the word: pong",
            },
        ];

        const response = GeminiTranslator.fromResponse(
            await callGemini(GeminiTranslator.toBody(request)),
        );

        const text = firstOp(response, "llm.text");
        expect(text?.role).toBe("assistant");
        expect(text?.content.toLowerCase()).toContain("pong");
        expect(
            firstOp(response, "response.usage")?.outputTokens,
        ).toBeGreaterThan(0);
        expect(firstOp(response, "response.stop")?.reason).toBe("end_turn");
    }, 30_000);

    test("a forced tool choice raises to llm.tool_call with parsed arguments", async () => {
        const request: Program = [
            { op: "llm.model", model: GEMINI_MODEL },
            {
                op: "gemini.generation_config",
                value: { thinkingConfig: { thinkingBudget: 0 } },
            },
            weatherTool,
            { op: "llm.tool_choice", value: { name: "get_weather" } },
            {
                op: "llm.text",
                role: "user",
                content: "What's the weather in Paris?",
            },
        ];

        const response = GeminiTranslator.fromResponse(
            await callGemini(GeminiTranslator.toBody(request)),
        );

        const call = firstOp(response, "llm.tool_call");
        expect(call?.name).toBe("get_weather");
        expect(String((call?.arguments as { city?: string }).city)).toMatch(
            /paris/i,
        );
    }, 30_000);
});

describe.skipIf(!OPENAI_KEY || !ANTHROPIC_KEY)(
    "live: cross-provider proxy flow",
    () => {
        test("an openai-shaped conversation with a tool round runs on anthropic, and the response converts back", async () => {
            // The proxy use case end to end: the client speaks openai_chat the
            // whole time; the backend is anthropic.
            const openaiShapedBody = {
                model: ANTHROPIC_MODEL,
                max_tokens: 100,
                messages: [
                    {
                        role: "user",
                        content: "What's the weather in Paris? Use the tool.",
                    },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_1",
                                type: "function",
                                function: {
                                    name: "get_weather",
                                    arguments: '{"city":"Paris"}',
                                },
                            },
                        ],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call_1",
                        content: '{"temp_c": 21, "sky": "clear"}',
                    },
                ],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "get_weather",
                            description: weatherTool.description,
                            parameters: weatherTool.inputSchema,
                        },
                    },
                ],
            };

            const anthropicBody = translateRequest(openaiShapedBody, {
                from: OpenAIChatTranslator,
                to: AnthropicTranslator,
            });
            const anthropicResponse = await callAnthropic(anthropicBody);
            const openaiShapedResponse = translateResponse(anthropicResponse, {
                from: AnthropicTranslator,
                to: OpenAIChatTranslator,
            }) as {
                choices: {
                    message: { role: string; content: string };
                    finish_reason: string;
                }[];
                usage: { prompt_tokens: number; completion_tokens: number };
            };

            expect(openaiShapedResponse.choices[0]!.message.role).toBe(
                "assistant",
            );
            expect(openaiShapedResponse.choices[0]!.message.content).toMatch(
                /21|clear/i,
            );
            expect(openaiShapedResponse.usage.prompt_tokens).toBeGreaterThan(0);

            // And the converted response raises cleanly in the openai dialect,
            // proving the whole loop stays in one op vocabulary.
            const raised =
                OpenAIChatTranslator.fromResponse(openaiShapedResponse);
            expect(opsOf(raised, "llm.text")).not.toHaveLength(0);
        }, 60_000);
    },
);
