import { describe, expect, test } from "bun:test";
import {
    createAssistantAccumulator,
    OpenAIChatTranslator,
    stopReasonFromFiat,
    type AccumulatorEvent,
    type AssistantMessage,
    type Program,
} from "../src/index";

function fold(programs: Program[], model?: string): AssistantMessage {
    const accumulator = createAssistantAccumulator({ model });
    for (const program of programs) {
        accumulator.push(program);
    }
    return accumulator.finish();
}

function foldWithEvents(programs: Program[], model?: string) {
    const events: AccumulatorEvent[] = [];
    const accumulator = createAssistantAccumulator({
        model,
        onEvent: (event) => events.push(event),
    });
    for (const program of programs) {
        accumulator.push(program);
    }
    const message = accumulator.finish();
    return { events, message };
}

describe("assistant accumulator", () => {
    test("text deltas open, append, and close on finish", () => {
        const { events, message } = foldWithEvents([
            [
                { op: "response.text_delta", content: "hel" },
                { op: "response.text_delta", content: "lo" },
            ],
        ]);

        expect(message.content).toEqual([{ type: "text", text: "hello" }]);
        expect(events.map((event) => event.type)).toEqual([
            "text_start",
            "text_delta",
            "text_delta",
            "text_end",
            "done",
        ]);
        expect(events[0]).toMatchObject({ type: "text_start", contentIndex: 0 });
        expect(events[1]).toMatchObject({
            type: "text_delta",
            contentIndex: 0,
            delta: "hel",
        });
        expect(events[2]).toMatchObject({
            type: "text_delta",
            contentIndex: 0,
            delta: "lo",
        });
        expect(events[3]).toMatchObject({
            type: "text_end",
            contentIndex: 0,
            content: "hello",
        });
    });

    test("llm.text assistant ops append without lifecycle deltas", () => {
        const message = fold([
            [
                { op: "llm.text", role: "assistant", content: "hi " },
                { op: "llm.text", role: "assistant", content: "there" },
            ],
        ]);

        expect(message.content).toEqual([{ type: "text", text: "hi there" }]);
    });

    test("tool call closes an open text block and later text opens a new block", () => {
        const { events, message } = foldWithEvents([
            [
                { op: "response.text_delta", content: "before" },
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "call_1",
                    name: "lookup",
                    arguments: "{}",
                },
                { op: "response.text_delta", content: "after" },
            ],
        ]);

        expect(message.content).toEqual([
            { type: "text", text: "before" },
            {
                type: "tool_call",
                id: "call_1",
                name: "lookup",
                arguments: {},
            },
            { type: "text", text: "after" },
        ]);
        expect(events.map((event) => event.type)).toEqual([
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_start",
            "toolcall_delta",
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_end",
            "done",
        ]);
    });

    test("rekeys tool call id when provider changes id at same index", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "aaa",
                    name: "lookup",
                    arguments: '{"a":',
                },
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "bbb",
                    arguments: "1}",
                },
            ],
        ]);

        expect(message.content).toHaveLength(1);
        expect(message.content[0]).toEqual({
            type: "tool_call",
            id: "bbb",
            name: "lookup",
            arguments: { a: 1 },
        });
    });

    test("merges complete llm.tool_call with streaming deltas on the same index", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "call_1",
                    name: "lookup",
                    arguments: '{"q":',
                },
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "lookup",
                    arguments: { q: "fiat" },
                },
            ],
        ]);

        expect(message.content).toHaveLength(1);
        expect(message.content[0]).toEqual({
            type: "tool_call",
            id: "call_1",
            name: "lookup",
            arguments: { q: "fiat" },
        });
    });

    test("merges tool calls when id arrives after index-keyed placeholder", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    name: "lookup",
                },
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "provider_call_1",
                    arguments: '{"x":1}',
                },
            ],
        ]);

        expect(message.content).toEqual([
            {
                type: "tool_call",
                id: "provider_call_1",
                name: "lookup",
                arguments: { x: 1 },
            },
        ]);
    });

    test("merges tool calls when id arrives before index", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "provider_call_1",
                    name: "lookup",
                },
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    arguments: '{"y":2}',
                },
            ],
        ]);

        expect(message.content).toEqual([
            {
                type: "tool_call",
                id: "provider_call_1",
                name: "lookup",
                arguments: { y: 2 },
            },
        ]);
    });

    test("synthesizes call_<index> when provider never sends an id", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 2,
                    name: "lookup",
                    arguments: "{}",
                },
            ],
        ]);

        expect(message.content).toEqual([
            {
                type: "tool_call",
                id: "call_2",
                name: "lookup",
                arguments: {},
            },
        ]);
    });

    test("accumulates partial tool-call json and parses once at finish", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "call_1",
                    name: "lookup",
                    arguments: '{"a":',
                },
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    arguments: "1}",
                },
            ],
        ]);

        expect(message.content).toEqual([
            {
                type: "tool_call",
                id: "call_1",
                name: "lookup",
                arguments: { a: 1 },
            },
        ]);
    });

    test("empty tool-call argument string becomes {}", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "call_1",
                    name: "lookup",
                },
            ],
        ]);

        expect(message.content[0]).toMatchObject({ arguments: {} });
    });

    test("invalid tool-call json at finish throws", () => {
        expect(() =>
            fold([
                [
                    {
                        op: "response.tool_call_delta",
                        index: 0,
                        id: "call_1",
                        name: "lookup",
                        arguments: "{oops",
                    },
                ],
            ]),
        ).toThrow("not valid JSON");
    });

    test("non-object parsed tool-call json throws", () => {
        expect(() =>
            fold([
                [
                    {
                        op: "response.tool_call_delta",
                        index: 0,
                        id: "call_1",
                        name: "lookup",
                        arguments: "[]",
                    },
                ],
            ]),
        ).toThrow("must be a JSON object");
    });

    test("complete llm.tool_call ops set name and arguments directly", () => {
        const message = fold([
            [
                {
                    op: "llm.tool_call",
                    id: "call_1",
                    name: "lookup",
                    arguments: { q: "fiat" },
                },
            ],
        ]);

        expect(message.content).toEqual([
            {
                type: "tool_call",
                id: "call_1",
                name: "lookup",
                arguments: { q: "fiat" },
            },
        ]);
    });

    test("maps fiat stop reasons to the normalized vocabulary", () => {
        expect(stopReasonFromFiat("end_turn")).toBe("stop");
        expect(stopReasonFromFiat("max_tokens")).toBe("length");
        expect(stopReasonFromFiat("tool_use")).toBe("tool_use");
        expect(stopReasonFromFiat("content_filter")).toBe("error");
    });

    test("infers tool_use when stop reason is stop and tool calls are present", () => {
        const message = fold([
            [
                {
                    op: "response.tool_call_delta",
                    index: 0,
                    id: "call_1",
                    name: "lookup",
                    arguments: "{}",
                },
                { op: "response.stop", reason: "end_turn" },
            ],
        ]);

        expect(message.stopReason).toBe("tool_use");
    });

    test("folds usage with last-wins per field while preserving omitted fields", () => {
        const message = fold([
            [
                {
                    op: "response.usage",
                    inputTokens: 10,
                    outputTokens: 5,
                    cacheReadTokens: 3,
                },
                { op: "response.usage", outputTokens: 7 },
            ],
        ]);

        expect(message.usage).toEqual({
            inputTokens: 10,
            outputTokens: 7,
            cacheReadTokens: 3,
        });
    });

    test("response id is first-wins", () => {
        const message = fold([
            [
                { op: "response.id", id: "resp_first" },
                { op: "response.id", id: "resp_second" },
            ],
        ]);

        expect(message.responseId).toBe("resp_first");
    });

    test("carries cache write tokens and response metadata ops", () => {
        const message = fold(
            [
                [
                    { op: "response.id", id: "resp_123" },
                    { op: "llm.model", model: "gpt-4o-rerouted" },
                    {
                        op: "response.usage",
                        inputTokens: 100,
                        outputTokens: 20,
                        cacheReadTokens: 80,
                        cacheWriteTokens: 4,
                    },
                ],
            ],
            "gpt-4o",
        );

        expect(message.responseId).toBe("resp_123");
        expect(message.responseModel).toBe("gpt-4o-rerouted");
        expect(message.usage).toEqual({
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 80,
            cacheWriteTokens: 4,
        });
    });

    test("ignores dialect residual ops", () => {
        const message = fold([
            [
                { op: "response.text_delta", content: "ok" },
                {
                    op: "openai_chat.body_field",
                    key: "object",
                    value: "chat.completion.chunk",
                    appliesTo: "response",
                },
            ],
        ]);

        expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    });

    test("streaming and non-streaming paths produce the same final message", () => {
        const wireResponse = {
            id: "chatcmpl-sym",
            object: "chat.completion",
            created: 1700000000,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "I'll check.",
                        tool_calls: [
                            {
                                id: "call_sym",
                                type: "function",
                                function: {
                                    name: "lookup",
                                    arguments: '{"id":7}',
                                },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                    logprobs: null,
                },
            ],
            usage: {
                prompt_tokens: 50,
                completion_tokens: 12,
                total_tokens: 62,
                prompt_tokens_details: { cached_tokens: 40 },
            },
        };

        const streamChunks = [
            {
                id: "chatcmpl-sym",
                object: "chat.completion.chunk",
                created: 1700000000,
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: "I'll check." },
                        finish_reason: null,
                        logprobs: null,
                    },
                ],
            },
            {
                id: "chatcmpl-sym",
                object: "chat.completion.chunk",
                created: 1700000000,
                choices: [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_sym",
                                    type: "function",
                                    function: { name: "lookup", arguments: "" },
                                },
                            ],
                        },
                        finish_reason: null,
                        logprobs: null,
                    },
                ],
            },
            {
                id: "chatcmpl-sym",
                object: "chat.completion.chunk",
                created: 1700000000,
                choices: [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    function: { arguments: '{"id":7}' },
                                },
                            ],
                        },
                        finish_reason: null,
                        logprobs: null,
                    },
                ],
            },
            {
                id: "chatcmpl-sym",
                object: "chat.completion.chunk",
                created: 1700000000,
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: "tool_calls",
                        logprobs: null,
                    },
                ],
                usage: {
                    prompt_tokens: 50,
                    completion_tokens: 12,
                    total_tokens: 62,
                    prompt_tokens_details: { cached_tokens: 40 },
                },
            },
        ];

        const streamed = fold(
            streamChunks.map((chunk) =>
                OpenAIChatTranslator.fromStreamResponse(chunk),
            ),
            "gpt-4o",
        );
        const completed = fold(
            [OpenAIChatTranslator.fromResponse(wireResponse)],
            "gpt-4o",
        );

        expect(streamed).toEqual(completed);
        expect(streamed).toEqual({
            content: [
                { type: "text", text: "I'll check." },
                {
                    type: "tool_call",
                    id: "call_sym",
                    name: "lookup",
                    arguments: { id: 7 },
                },
            ],
            model: "gpt-4o",
            responseId: "chatcmpl-sym",
            stopReason: "tool_use",
            usage: {
                inputTokens: 50,
                outputTokens: 12,
                cacheReadTokens: 40,
            },
        });
    });

    test("openai chat sse chunks fold to the expected assistant message", () => {
        const chunks = [
            {
                id: "chatcmpl-stream",
                object: "chat.completion.chunk",
                created: 1700000000,
                model: "gpt-4o",
                choices: [
                    {
                        index: 0,
                        delta: { role: "assistant", content: "Hello" },
                        finish_reason: null,
                        logprobs: null,
                    },
                ],
            },
            {
                id: "chatcmpl-stream",
                object: "chat.completion.chunk",
                created: 1700000000,
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: "stop",
                        logprobs: null,
                    },
                ],
                usage: {
                    prompt_tokens: 12,
                    completion_tokens: 2,
                    total_tokens: 14,
                },
            },
        ];

        const message = fold(
            chunks.map((chunk) =>
                OpenAIChatTranslator.fromStreamResponse(chunk),
            ),
            "gpt-4o",
        );

        expect(message).toEqual({
            content: [{ type: "text", text: "Hello" }],
            model: "gpt-4o",
            responseId: "chatcmpl-stream",
            stopReason: "stop",
            usage: { inputTokens: 12, outputTokens: 2 },
        });
    });
});
