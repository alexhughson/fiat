// llm.reasoning across dialects: wire bodies in, wire bodies out.

import { describe, expect, spyOn, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
} from "../src/index";

// Runs `run` and returns its result with every console.warn message.
function withWarnings<T>(run: () => T): { result: T; warnings: string[] } {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
        const result = run();
        return { result, warnings: warn.mock.calls.map((call) => call[0]) };
    } finally {
        warn.mockRestore();
    }
}

const reasoningWarnings = (warnings: string[]) =>
    warnings.filter((warning) => warning.includes("llm.reasoning"));

function anthropicRequest(toolResult = "4 C") {
    return {
        model: "claude-sonnet-4-5",
        max_tokens: 2000,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "Weather in Halifax?" }],
            },
            {
                role: "assistant",
                content: [
                    {
                        type: "thinking",
                        thinking: "I need the weather tool.",
                        signature: "EqQB",
                    },
                    {
                        type: "tool_use",
                        id: "toolu_1",
                        name: "get_weather",
                        input: { city: "Halifax" },
                    },
                ],
            },
            {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "toolu_1",
                        content: toolResult,
                    },
                ],
            },
        ],
    };
}

const responsesRequest = {
    model: "gpt-5",
    input: [
        {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Weather in Halifax?" }],
        },
        {
            type: "reasoning",
            id: "rs_1",
            summary: [
                { type: "summary_text", text: "I need the weather tool." },
            ],
            encrypted_content: "gAAA",
        },
        {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"Halifax"}',
        },
        {
            type: "function_call_output",
            call_id: "call_1",
            output: '{"temp":"4 C"}',
        },
    ],
};

const geminiRequest = {
    model: "gemini-2.5-pro",
    contents: [
        { role: "user", parts: [{ text: "Weather in Halifax?" }] },
        {
            role: "model",
            parts: [
                {
                    text: "I need the weather tool.",
                    thought: true,
                    thoughtSignature: "sig_thought",
                },
                {
                    functionCall: {
                        name: "get_weather",
                        args: { city: "Halifax" },
                        id: "call_1",
                    },
                    thoughtSignature: "sig_call",
                },
            ],
        },
        {
            role: "user",
            parts: [
                {
                    functionResponse: {
                        name: "get_weather",
                        id: "call_1",
                        response: { temp: "4 C" },
                    },
                },
            ],
        },
    ],
};

describe("llm.reasoning returns to the provider it came from", () => {
    test("an Anthropic request keeps its thinking block and signature", () => {
        const body = anthropicRequest();
        const core = AnthropicTranslator.fromBody(body);

        expect(core).toContainEqual({
            op: "llm.reasoning",
            id: "reasoning_1",
            content: "I need the weather tool.",
        });
        expect(AnthropicTranslator.toBody(core)).toEqual(body);
    });

    test("an Anthropic response keeps thinking and redacted_thinking blocks in order", () => {
        const response = {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [
                { type: "thinking", thinking: "Add them.", signature: "EqQB" },
                { type: "redacted_thinking", data: "EmwK" },
                { type: "text", text: "378" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        };
        const core = AnthropicTranslator.fromResponse(response);

        expect(core.filter((op) => op.op === "llm.reasoning")).toEqual([
            { op: "llm.reasoning", id: "reasoning_1", content: "Add them." },
            { op: "llm.reasoning", id: "reasoning_2", content: "" },
        ]);
        expect(AnthropicTranslator.toResponse(core)).toEqual(response);
    });

    test("a Responses request keeps its reasoning item", () => {
        const core = OpenAIResponsesTranslator.fromBody(responsesRequest);

        expect(core).toContainEqual({
            op: "llm.reasoning",
            id: "reasoning_1",
            content: "I need the weather tool.",
        });
        expect(OpenAIResponsesTranslator.toBody(core)).toEqual(
            responsesRequest,
        );
    });

    test("a Responses response keeps a reasoning item that has no summary", () => {
        const response = {
            id: "resp_1",
            object: "response",
            created_at: 1,
            model: "gpt-5",
            status: "completed",
            output: [
                {
                    type: "reasoning",
                    id: "rs_1",
                    summary: [],
                    encrypted_content: "gAAA",
                },
                {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [
                        { type: "output_text", text: "378", annotations: [] },
                    ],
                },
            ],
        };
        const core = OpenAIResponsesTranslator.fromResponse(response);

        expect(core).toContainEqual({
            op: "llm.reasoning",
            id: "reasoning_1",
            content: "",
        });
        expect(OpenAIResponsesTranslator.toResponse(core)).toEqual(response);
    });

    test("a Gemini request keeps its thought part and both signatures", () => {
        const core = GeminiTranslator.fromBody(geminiRequest);

        expect(core).toContainEqual({
            op: "llm.reasoning",
            id: "reasoning_1",
            content: "I need the weather tool.",
        });
        expect(GeminiTranslator.toBody(core)).toEqual(geminiRequest);
    });

    test("a Gemini response keeps the signature of the part after the thought part", () => {
        const response = {
            modelVersion: "gemini-2.5-pro",
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            { text: "Add them.", thought: true },
                            { text: "378", thoughtSignature: "sig_answer" },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
        };
        const core = GeminiTranslator.fromResponse(response);

        expect(GeminiTranslator.toResponse(core)).toEqual(response);
    });
});

describe("llm.reasoning lowered to another provider", () => {
    test("Gemini writes Anthropic reasoning text as a thought part", () => {
        const core = AnthropicTranslator.fromBody(
            anthropicRequest('{"temp":"4 C"}'),
        );
        const { result } = withWarnings(() => GeminiTranslator.toBody(core));
        const contents = (result as { contents: unknown[] }).contents;

        expect(contents[1]).toEqual({
            role: "model",
            parts: [{ text: "I need the weather tool.", thought: true }],
        });
    });

    test("Gemini drops reasoning that has no text, with a warning", () => {
        const core = AnthropicTranslator.fromResponse({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [
                { type: "redacted_thinking", data: "EmwK" },
                { type: "text", text: "378" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        });
        const { result, warnings } = withWarnings(() =>
            GeminiTranslator.toResponse(core),
        );

        expect(
            (result as { candidates: { content: unknown }[] }).candidates[0]!
                .content,
        ).toEqual({ role: "model", parts: [{ text: "378" }] });
        expect(reasoningWarnings(warnings)).toEqual([
            'metamodel: dropped llm.reasoning "reasoning_1": gemini has nothing to write for reasoning without text or a thoughtSignature',
        ]);
    });

    test("Anthropic drops Responses reasoning, with a warning", () => {
        const core = OpenAIResponsesTranslator.fromBody({
            ...responsesRequest,
            max_output_tokens: 100,
        });
        const { result, warnings } = withWarnings(() =>
            AnthropicTranslator.toBody(core),
        );

        expect(
            (result as ReturnType<typeof anthropicRequest>).messages[1],
        ).toEqual({
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: "call_1",
                    name: "get_weather",
                    input: { city: "Halifax" },
                },
            ],
        });
        expect(reasoningWarnings(warnings)).toEqual([
            'metamodel: dropped llm.reasoning "reasoning_1": anthropic_messages accepts a thinking block only with the signature Anthropic issued for it',
        ]);
    });

    test("Responses drops Anthropic reasoning, with a warning", () => {
        const core = AnthropicTranslator.fromBody(anthropicRequest());
        const { result, warnings } = withWarnings(() =>
            OpenAIResponsesTranslator.toBody(core),
        );

        expect(
            (result as typeof responsesRequest).input.map((item) => item.type),
        ).toEqual(["message", "function_call", "function_call_output"]);
        expect(reasoningWarnings(warnings)).toEqual([
            'metamodel: dropped llm.reasoning "reasoning_1": openai_responses accepts a reasoning item only with the id or encrypted_content OpenAI issued for it',
        ]);
    });

    test("Chat drops reasoning, with a warning, and keeps it out of the answer", () => {
        const core = GeminiTranslator.fromResponse({
            modelVersion: "gemini-2.5-pro",
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            { text: "Add them.", thought: true },
                            { text: "378" },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
        });
        const { result, warnings } = withWarnings(() =>
            OpenAIChatTranslator.toResponse(core),
        );

        expect(
            (result as { choices: { message: unknown }[] }).choices[0]!.message,
        ).toEqual({ role: "assistant", content: "378" });
        expect(reasoningWarnings(warnings)).toEqual([
            'metamodel: dropped llm.reasoning "reasoning_1": openai_chat has no field for reasoning',
        ]);
    });

    test("Realtime drops reasoning, with a warning", () => {
        const core = AnthropicTranslator.fromBody(anthropicRequest());
        const { result, warnings } = withWarnings(() =>
            OpenAIRealtimeTranslator.toBody(core),
        );

        expect(JSON.stringify(result)).not.toContain(
            "I need the weather tool.",
        );
        expect(reasoningWarnings(warnings)).toEqual([
            'metamodel: dropped llm.reasoning "reasoning_1": openai_realtime has no field for reasoning',
        ]);
    });

    test("strict lowering throws where default lowering drops", () => {
        const core = AnthropicTranslator.fromBody(anthropicRequest());

        expect(() =>
            withWarnings(() =>
                OpenAIChatTranslator.toBody(core, { strict: true }),
            ),
        ).toThrow(LintError);
    });
});

describe("llm.reasoning ids", () => {
    // Each raise call numbers its reasoning ops from 1, so a response program
    // appended to a request program repeats "reasoning_1".
    test("two raised bodies with the same reasoning id keep their own signatures", () => {
        const request = AnthropicTranslator.fromBody(anthropicRequest());
        const response = AnthropicTranslator.fromResponse({
            id: "msg_2",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [
                {
                    type: "thinking",
                    thinking: "It is cold.",
                    signature: "second_signature",
                },
                { type: "text", text: "4 C in Halifax." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
        });
        const { result } = withWarnings(() =>
            AnthropicTranslator.toBody([...request, ...response]),
        );
        const messages = (result as ReturnType<typeof anthropicRequest>)
            .messages;

        expect(messages[1]!.content[0]).toEqual({
            type: "thinking",
            thinking: "I need the weather tool.",
            signature: "EqQB",
        });
        expect(messages[3]!.content[0]).toEqual({
            type: "thinking",
            thinking: "It is cold.",
            signature: "second_signature",
        });
    });
});
