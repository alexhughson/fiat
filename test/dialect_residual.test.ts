// Guards the rule Alex set after PR #11: a concept that several providers
// share must live in a core op, not survive a raise as a dialect op. The test
// raises ordinary requests, complete responses, and single stream events from
// every dialect through the dialect's public translators, collects every
// dialect-op unit the raise leaves behind, and checks each unit against
// test/dialect_residual_allowlist.ts, whose rows say why only that provider
// has the data. A raise that throws is recorded as a skip, not a failure;
// the skips seeded from main live in expectedSkips, so a raiser that starts
// or stops throwing shows up here too.

import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    type Op,
    type Program,
    type Translator,
} from "../src/index";
import { dialectResidualAllowlist } from "./dialect_residual_allowlist";

const translators: Record<string, Translator> = {
    anthropic_messages: AnthropicTranslator,
    openai_chat: OpenAIChatTranslator,
    openai_responses: OpenAIResponsesTranslator,
    gemini: GeminiTranslator,
    openai_realtime: OpenAIRealtimeTranslator,
};

const allowlistFile = "test/dialect_residual_allowlist.ts";

type TranslatorFn = "fromBody" | "fromResponse" | "fromStreamResponse";

interface Case {
    // Names the input in a failure message, e.g. "openai_chat stream chunk".
    label: string;
    fn: TranslatorFn;
    input: unknown;
}

// Raises on main that throw; these are ordinary inputs a fix must cover.
const expectedSkips = [
    "anthropic_messages stream message_start",
    "anthropic_messages stream content_block_start text",
    "anthropic_messages stream content_block_stop",
];

const cases: Case[] = [
    // anthropic_messages
    {
        label: "anthropic_messages request text, image, system prompt",
        fn: "fromBody",
        input: {
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            system: "be brief",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "hi" },
                        {
                            type: "image",
                            source: {
                                type: "url",
                                url: "https://example.com/cat.png",
                            },
                        },
                    ],
                },
            ],
        },
    },
    {
        label: "anthropic_messages request sampling, tool call, tool result",
        fn: "fromBody",
        input: {
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            temperature: 0.5,
            top_p: 0.9,
            top_k: 40,
            system: "be brief",
            tools: [
                {
                    name: "get_weather",
                    description: "w",
                    input_schema: { type: "object" },
                },
            ],
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            id: "t1",
                            name: "get_weather",
                            input: { city: "Paris" },
                        },
                    ],
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "tool_result",
                            tool_use_id: "t1",
                            content: "18C",
                        },
                    ],
                },
            ],
        },
    },
    {
        label: "anthropic_messages response text answer, usage, stop reason",
        fn: "fromResponse",
        input: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "hi there" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
        },
    },
    {
        label: "anthropic_messages response tool call",
        fn: "fromResponse",
        input: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
                { type: "text", text: "let me check" },
                {
                    type: "tool_use",
                    id: "t1",
                    name: "get_weather",
                    input: { city: "Paris" },
                },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
        },
    },
    {
        label: "anthropic_messages stream message_start",
        fn: "fromStreamResponse",
        input: {
            type: "message_start",
            message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 10, output_tokens: 1 },
            },
        },
    },
    {
        label: "anthropic_messages stream content_block_start text",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        },
    },
    {
        label: "anthropic_messages stream text delta",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hello" },
        },
    },
    {
        label: "anthropic_messages stream content_block_stop",
        fn: "fromStreamResponse",
        input: { type: "content_block_stop", index: 0 },
    },
    {
        label: "anthropic_messages stream usage and stop reason",
        fn: "fromStreamResponse",
        input: {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
        },
    },
    {
        label: "anthropic_messages stream message_stop",
        fn: "fromStreamResponse",
        input: { type: "message_stop" },
    },
    {
        label: "anthropic_messages stream tool call start",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_start",
            index: 1,
            content_block: {
                type: "tool_use",
                id: "t1",
                name: "get_weather",
                input: {},
            },
        },
    },
    {
        label: "anthropic_messages stream tool call argument delta",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"ci' },
        },
    },

    // openai_chat
    {
        label: "openai_chat request text, image, system prompt",
        fn: "fromBody",
        input: {
            model: "gpt-4o",
            max_tokens: 100,
            messages: [
                { role: "system", content: "be brief" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "hi" },
                        {
                            type: "image_url",
                            image_url: {
                                url: "https://example.com/cat.png",
                            },
                        },
                    ],
                },
            ],
        },
    },
    {
        label: "openai_chat request sampling, tool call, tool result",
        fn: "fromBody",
        input: {
            model: "gpt-4o",
            max_tokens: 100,
            temperature: 0.5,
            top_p: 0.9,
            tools: [
                {
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "w",
                        parameters: { type: "object" },
                    },
                },
            ],
            messages: [
                {
                    role: "assistant",
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
                { role: "user", content: "18C" },
            ],
        },
    },
    {
        label: "openai_chat response text answer, tool call, usage",
        fn: "fromResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 123,
            model: "gpt-4o",
            system_fingerprint: "fp_1",
            service_tier: "default",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "hi there",
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
                    finish_reason: "tool_calls",
                },
            ],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
            },
        },
    },
    {
        label: "openai_chat stream role chunk",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            choices: [
                { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
        },
    },
    {
        label: "openai_chat stream text delta",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    delta: { content: "hello" },
                    finish_reason: null,
                },
            ],
        },
    },
    {
        label: "openai_chat stream tool call chunk",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                type: "function",
                                function: {
                                    name: "get_weather",
                                    arguments: "",
                                },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
    },
    {
        label: "openai_chat stream stop reason and usage",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
            },
        },
    },

    // openai_responses
    {
        label: "openai_responses request text, image, system prompt",
        fn: "fromBody",
        input: {
            model: "gpt-5",
            max_output_tokens: 100,
            instructions: "be brief",
            input: [
                {
                    type: "message",
                    role: "user",
                    content: [
                        { type: "input_text", text: "hi" },
                        {
                            type: "input_image",
                            image_url: "https://example.com/cat.png",
                        },
                    ],
                },
            ],
        },
    },
    {
        label: "openai_responses request sampling, tool call, tool result",
        fn: "fromBody",
        input: {
            model: "gpt-5",
            max_output_tokens: 100,
            temperature: 0.5,
            top_p: 0.9,
            tools: [
                {
                    type: "function",
                    name: "get_weather",
                    description: "w",
                    parameters: { type: "object" },
                },
            ],
            input: [
                {
                    type: "function_call",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
                {
                    type: "function_call_output",
                    call_id: "call_1",
                    output: "18C",
                },
            ],
        },
    },
    {
        label: "openai_responses response text answer, tool call, usage",
        fn: "fromResponse",
        input: {
            id: "resp_1",
            object: "response",
            created_at: 123,
            status: "completed",
            model: "gpt-5",
            service_tier: "default",
            output: [
                {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [
                        {
                            type: "output_text",
                            text: "hi there",
                            annotations: [],
                        },
                    ],
                },
                {
                    type: "function_call",
                    id: "fc_1",
                    call_id: "call_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
    },
    {
        label: "openai_responses stream text delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_text.delta",
            response_id: "resp_1",
            output_index: 0,
            content_index: 0,
            delta: "hello",
        },
    },
    {
        label: "openai_responses stream output item added",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_item.added",
            response_id: "resp_1",
            output_index: 0,
            item: {
                type: "message",
                role: "assistant",
                id: "msg_1",
                status: "in_progress",
                content: [],
            },
        },
    },
    {
        label: "openai_responses stream tool call argument delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.function_call_arguments.delta",
            response_id: "resp_1",
            output_index: 1,
            item_id: "fc_1",
            delta: '{"ci',
        },
    },
    {
        label: "openai_responses stream completed with usage",
        fn: "fromStreamResponse",
        input: {
            type: "response.completed",
            response_id: "resp_1",
            response: {
                id: "resp_1",
                object: "response",
                status: "completed",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                output: [],
            },
        },
    },

    // gemini
    {
        label: "gemini request text, image, system prompt",
        fn: "fromBody",
        input: {
            model: "models/gemini-3.5-flash",
            systemInstruction: { parts: [{ text: "be brief" }] },
            generationConfig: { maxOutputTokens: 100, temperature: 0.5 },
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "hi" },
                        {
                            inline_data: {
                                mime_type: "image/png",
                                data: "aGk=",
                            },
                        },
                    ],
                },
            ],
        },
    },
    {
        label: "gemini request tool call and tool result",
        fn: "fromBody",
        input: {
            model: "models/gemini-3.5-flash",
            tools: [
                {
                    functionDeclarations: [
                        {
                            name: "get_weather",
                            description: "w",
                            parameters: { type: "object" },
                        },
                    ],
                },
            ],
            contents: [
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                id: "call_1",
                                name: "get_weather",
                                args: { city: "Paris" },
                            },
                        },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                id: "call_1",
                                name: "get_weather",
                                response: { temp: "18C" },
                            },
                        },
                    ],
                },
            ],
        },
    },
    {
        label: "gemini request sampling and stop sequences",
        fn: "fromBody",
        input: {
            model: "models/gemini-3.5-flash",
            generationConfig: {
                maxOutputTokens: 100,
                topP: 0.9,
                topK: 40,
                stopSequences: ["\n\n"],
            },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        },
    },
    {
        label: "gemini response text answer, usage, stop reason",
        fn: "fromResponse",
        input: {
            model: "models/gemini-3.5-flash",
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            { text: "pong", thoughtSignature: "thought_sig_1" },
                        ],
                    },
                    finishReason: "STOP",
                    safetyRatings: [
                        {
                            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                            probability: "NEGLIGIBLE",
                        },
                    ],
                },
            ],
            usageMetadata: {
                promptTokenCount: 12,
                candidatesTokenCount: 2,
                totalTokenCount: 14,
                thoughtsTokenCount: 1,
                serviceTier: "default",
            },
            responseId: "resp_123",
        },
    },
    {
        label: "gemini response tool call",
        fn: "fromResponse",
        input: {
            model: "models/gemini-3.5-flash",
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    id: "call_1",
                                    name: "get_weather",
                                    args: { city: "Paris" },
                                },
                                thoughtSignature: "sig",
                            },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                totalTokenCount: 14,
            },
        },
    },
    {
        label: "gemini stream text delta",
        fn: "fromStreamResponse",
        input: {
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "hello" }] },
                    index: 0,
                },
            ],
        },
    },
    {
        label: "gemini stream tool call",
        fn: "fromStreamResponse",
        input: {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    id: "call_1",
                                    name: "get_weather",
                                    args: { city: "Paris" },
                                },
                            },
                        ],
                    },
                    index: 0,
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15,
            },
        },
    },
    {
        label: "gemini stream stop reason and usage",
        fn: "fromStreamResponse",
        input: {
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "!" }] },
                    index: 0,
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15,
            },
            responseId: "resp_123",
            modelVersion: "gemini-3.5-flash",
        },
    },

    // openai_realtime
    {
        label: "openai_realtime request text, image, system prompt, tool",
        fn: "fromBody",
        input: {
            model: "gpt-realtime",
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [
                            { type: "input_text", text: "hi" },
                            {
                                type: "input_image",
                                image_url: "https://example.com/cat.png",
                            },
                        ],
                    },
                },
                {
                    type: "response.create",
                    response: {
                        instructions: "be brief",
                        max_output_tokens: 100,
                        temperature: 0.5,
                        tools: [
                            {
                                type: "function",
                                name: "get_weather",
                                description: "w",
                                parameters: { type: "object" },
                            },
                        ],
                    },
                },
            ],
        },
    },
    {
        label: "openai_realtime request tool call, tool result, modalities",
        fn: "fromBody",
        input: {
            model: "gpt-realtime",
            events: [
                {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                },
                {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: "18C",
                    },
                },
                {
                    type: "response.create",
                    response: {
                        modalities: ["text"],
                        max_output_tokens: 100,
                    },
                },
            ],
        },
    },
    {
        label: "openai_realtime response text answer, tool call, usage",
        fn: "fromResponse",
        input: {
            events: [
                {
                    type: "response.done",
                    response: {
                        id: "resp_1",
                        status: "completed",
                        output: [
                            {
                                type: "message",
                                id: "msg_1",
                                role: "assistant",
                                status: "completed",
                                content: [
                                    {
                                        type: "text",
                                        text: "hi there",
                                        transcript: "hi there",
                                    },
                                ],
                            },
                            {
                                type: "function_call",
                                id: "fc_1",
                                call_id: "call_1",
                                name: "get_weather",
                                arguments: '{"city":"Paris"}',
                            },
                        ],
                        usage: {
                            input_tokens: 10,
                            output_tokens: 5,
                            total_tokens: 15,
                        },
                    },
                },
            ],
        },
    },
    {
        label: "openai_realtime response error",
        fn: "fromResponse",
        input: {
            events: [
                {
                    type: "response.done",
                    response: {
                        id: "resp_1",
                        status: "failed",
                        output: [],
                        error: { type: "server_error", code: "x" },
                    },
                },
            ],
        },
    },
    {
        label: "openai_realtime stream text delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_text.delta",
            response_id: "resp_1",
            output_index: 0,
            content_index: 0,
            delta: "hello",
        },
    },
    {
        label: "openai_realtime stream output item added",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_item.added",
            response_id: "resp_1",
            output_index: 0,
            item: {
                type: "message",
                role: "assistant",
                id: "msg_1",
                status: "in_progress",
                content: [],
            },
        },
    },
    {
        label: "openai_realtime stream tool call argument delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.function_call_arguments.delta",
            response_id: "resp_1",
            output_index: 1,
            item_id: "fc_1",
            delta: '{"ci',
        },
    },
    {
        label: "openai_realtime stream done with usage",
        fn: "fromStreamResponse",
        input: {
            type: "response.done",
            response_id: "resp_1",
            response: {
                id: "resp_1",
                status: "completed",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                output: [],
            },
        },
    },
];

// A unit names the wire data a dialect op still carries: `op:key` for an op
// holding one keyed wire field or one record key, `op:tag` for an op holding
// a whole wire object, tagged by its type or kind. A bare op name would let
// a new provider-only field hide behind an existing row.
function unitsOf(op: Op): string[] {
    const data = op as unknown as Record<string, unknown>;
    if (typeof data.key === "string") return [`${op.op}:${data.key}`];
    switch (op.op) {
        case "anthropic_messages.usage":
        case "openai_chat.usage":
        case "openai_responses.usage":
        case "openai_realtime.usage":
        case "gemini.usage":
            return Object.keys(data.usage as Record<string, unknown>).map(
                (key) => `${op.op}:${key}`,
            );
        case "gemini.generation_config":
            return Object.keys(data.value as Record<string, unknown>).map(
                (key) => `${op.op}:${key}`,
            );
        case "gemini.candidate_meta":
            return Object.keys(data.candidate as Record<string, unknown>).map(
                (key) => `${op.op}:${key}`,
            );
        case "gemini.part_meta":
            return [
                `${op.op}:${(data.part as { kind: string }).kind ?? "untagged"}`,
            ];
        case "openai_responses.output_meta":
        case "openai_realtime.output_meta":
            return [
                `${op.op}:${(data.item as { type?: string }).type ?? "untagged"}`,
            ];
        case "openai_realtime.item_meta":
            return [
                `${op.op}:${
                    (data.event as { item?: { type?: string } }).item?.type ??
                    "untagged"
                }`,
            ];
        case "anthropic_messages.stream_event":
            return [`${op.op}:${(data.event as { type: string }).type}`];
        default:
            return [op.op];
    }
}

describe("dialect residual allowlist", () => {
    test("raising ordinary bodies leaves only allowlisted dialect ops", () => {
        const seen = new Set<string>();
        const violations: string[] = [];
        const skipped: string[] = [];

        for (const c of cases) {
            const dialect = c.label.split(" ")[0]!;
            const translator = translators[dialect]!;
            let program: Program;
            try {
                program = translator[c.fn](c.input);
            } catch (error) {
                skipped.push(c.label);
                if (!expectedSkips.includes(c.label)) {
                    violations.push(
                        `raise threw on "${c.label}": ` +
                            `${(error as Error).message.split("\n")[0]} — ` +
                            `a new throw needs a row in expectedSkips in ` +
                            `test/dialect_residual.test.ts`,
                    );
                }
                continue;
            }

            for (const op of program) {
                const namespace = op.op.split(".")[0]!;
                if (!Object.hasOwn(translators, namespace)) continue;
                for (const unit of unitsOf(op)) {
                    seen.add(unit);
                    if (!Object.hasOwn(dialectResidualAllowlist, unit)) {
                        violations.push(
                            `dialect op unit "${unit}" is not in the allowlist ` +
                                `(${allowlistFile}) — produced by ` +
                                `"${c.label}". Add a row with a reason it is ` +
                                `provider-only, or raise the concept to a core op.`,
                        );
                    }
                }
            }
        }

        for (const label of expectedSkips) {
            if (!skipped.includes(label)) {
                violations.push(
                    `"${label}" no longer throws, but expectedSkips in ` +
                        `test/dialect_residual.test.ts still lists it — ` +
                        `remove the row so its residuals are checked`,
                );
            }
        }

        for (const unit of Object.keys(dialectResidualAllowlist)) {
            if (!seen.has(unit)) {
                violations.push(
                    `allowlist row "${unit}" (${allowlistFile}) was never ` +
                        `produced by the corpus — extend the corpus or remove ` +
                        `the row`,
                );
            }
        }

        expect(violations.join("\n\n")).toBe("");
    });
});
