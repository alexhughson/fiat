// Guards the rule Alex set after PR #11: a concept that several providers
// share must live in a core op, not survive a raise as a dialect op. The test
// raises ordinary requests, complete responses, and single stream events from
// every dialect through the dialect's public translators, collects every
// dialect-op unit the raise leaves behind, and checks each unit against
// test/dialect_residual_allowlist.ts: providerOnly rows say why only that
// provider has the data; baseline rows are main's unclassified residuals,
// which a pull request may delete and may not extend. A raise that throws is
// recorded as a skip, not a failure; the skips seeded from main live in
// expectedSkips, so a raiser that starts or stops throwing shows up here too.

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
import { baseline, providerOnly } from "./dialect_residual_allowlist";

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
    "anthropic_messages stream ping",
    "openai_responses stream response.created",
    "openai_responses stream response.in_progress",
    "openai_responses stream response.content_part.added",
    "openai_responses stream response.content_part.done",
    "openai_responses stream response.output_text.done",
    "openai_responses stream response.function_call_arguments.done",
    "openai_realtime stream response.created",
    "openai_realtime stream response.content_part.added",
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
        label: "anthropic_messages request metadata user_id",
        fn: "fromBody",
        input: {
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            metadata: { user_id: "user_123" },
            messages: [{ role: "user", content: "hi" }],
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
            stop_sequence: null,
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
            stop_sequence: null,
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
                stop_sequence: null,
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
            delta: { stop_reason: "end_turn", stop_sequence: null },
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
    {
        label: "anthropic_messages stream ping",
        fn: "fromStreamResponse",
        input: { type: "ping" },
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
                { role: "system", content: "be brief" },
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
                { role: "tool", tool_call_id: "call_1", content: "18C" },
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
        label: "openai_chat stream tool call start chunk",
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
        label: "openai_chat stream tool call argument continuation chunk",
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
                                function: { arguments: 'ty":"Paris"}' },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
    },
    {
        label: "openai_chat stream finish chunk",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: null,
        },
    },
    {
        label: "openai_chat stream usage-only final chunk",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            choices: [],
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
            model: "gpt-4o",
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
            created_at: 1741386163,
            status: "completed",
            error: null,
            incomplete_details: null,
            instructions: "be brief",
            max_output_tokens: null,
            model: "gpt-5",
            output: [
                {
                    type: "message",
                    id: "msg_1",
                    status: "completed",
                    role: "assistant",
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
                    status: "completed",
                },
            ],
            parallel_tool_calls: true,
            previous_response_id: null,
            reasoning: { effort: null, summary: null },
            store: true,
            temperature: 1.0,
            text: { format: { type: "text" } },
            tool_choice: "auto",
            tools: [],
            top_p: 1.0,
            truncation: "disabled",
            usage: { input_tokens: 32, output_tokens: 5, total_tokens: 37 },
            metadata: {},
            service_tier: "default",
        },
    },
    {
        label: "openai_responses stream output item added",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_item.added",
            sequence_number: 5,
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
        label: "openai_responses stream text delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_text.delta",
            sequence_number: 6,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "hello",
        },
    },
    {
        label: "openai_responses stream tool call argument delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.function_call_arguments.delta",
            sequence_number: 9,
            item_id: "fc_1",
            output_index: 1,
            delta: '{"ci',
        },
    },
    {
        label: "openai_responses stream output item done, function call",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_item.done",
            sequence_number: 11,
            output_index: 1,
            item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Paris"}',
                status: "completed",
            },
        },
    },
    {
        label: "openai_responses stream completed with usage",
        fn: "fromStreamResponse",
        input: {
            type: "response.completed",
            sequence_number: 12,
            response: {
                id: "resp_1",
                object: "response",
                created_at: 1741386163,
                status: "completed",
                error: null,
                incomplete_details: null,
                instructions: "be brief",
                max_output_tokens: null,
                model: "gpt-4o",
                output: [
                    {
                        type: "message",
                        id: "msg_1",
                        status: "completed",
                        role: "assistant",
                        content: [
                            {
                                type: "output_text",
                                text: "hi there",
                                annotations: [],
                            },
                        ],
                    },
                ],
                parallel_tool_calls: true,
                previous_response_id: null,
                reasoning: { effort: null, summary: null },
                store: true,
                temperature: 0.5,
                text: { format: { type: "text" } },
                tool_choice: "auto",
                tools: [],
                top_p: 0.9,
                truncation: "disabled",
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
                metadata: {},
                service_tier: "default",
            },
        },
    },
    {
        label: "openai_responses stream incomplete",
        fn: "fromStreamResponse",
        input: {
            type: "response.incomplete",
            sequence_number: 12,
            response: {
                id: "resp_1",
                object: "response",
                created_at: 1741386163,
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                error: null,
                instructions: null,
                max_output_tokens: 100,
                model: "gpt-5",
                output: [],
                parallel_tool_calls: true,
                previous_response_id: null,
                reasoning: { effort: null, summary: null },
                store: true,
                temperature: 1.0,
                text: { format: { type: "text" } },
                tool_choice: "auto",
                tools: [],
                top_p: 1.0,
                truncation: "disabled",
                usage: {
                    input_tokens: 10,
                    output_tokens: 100,
                    total_tokens: 110,
                },
                metadata: {},
                service_tier: "default",
            },
        },
    },
    {
        label: "openai_responses stream failed",
        fn: "fromStreamResponse",
        input: {
            type: "response.failed",
            sequence_number: 12,
            response: {
                id: "resp_1",
                object: "response",
                created_at: 1741386163,
                status: "failed",
                error: { code: "server_error", message: "oops" },
                incomplete_details: null,
                instructions: null,
                max_output_tokens: null,
                model: "gpt-5",
                output: [],
                parallel_tool_calls: true,
                previous_response_id: null,
                reasoning: { effort: null, summary: null },
                store: true,
                temperature: 1.0,
                text: { format: { type: "text" } },
                tool_choice: "auto",
                tools: [],
                top_p: 1.0,
                truncation: "disabled",
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                metadata: {},
                service_tier: "default",
            },
        },
    },
    {
        label: "openai_responses stream response.created",
        fn: "fromStreamResponse",
        input: {
            type: "response.created",
            sequence_number: 1,
            response: {
                id: "resp_1",
                object: "response",
                created_at: 1741386163,
                status: "in_progress",
                error: null,
                incomplete_details: null,
                instructions: "be brief",
                max_output_tokens: null,
                model: "gpt-4o",
                output: [],
                parallel_tool_calls: true,
                previous_response_id: null,
                reasoning: { effort: null, summary: null },
                store: true,
                temperature: 0.5,
                text: { format: { type: "text" } },
                tool_choice: "auto",
                tools: [],
                top_p: 0.9,
                truncation: "disabled",
                usage: null,
                metadata: {},
                service_tier: "default",
            },
        },
    },
    {
        label: "openai_responses stream response.in_progress",
        fn: "fromStreamResponse",
        input: {
            type: "response.in_progress",
            sequence_number: 2,
            response: {
                id: "resp_1",
                object: "response",
                created_at: 1741386163,
                status: "in_progress",
                error: null,
                incomplete_details: null,
                instructions: "be brief",
                max_output_tokens: null,
                model: "gpt-4o",
                output: [],
                parallel_tool_calls: true,
                previous_response_id: null,
                reasoning: { effort: null, summary: null },
                store: true,
                temperature: 0.5,
                text: { format: { type: "text" } },
                tool_choice: "auto",
                tools: [],
                top_p: 0.9,
                truncation: "disabled",
                usage: null,
                metadata: {},
                service_tier: "default",
            },
        },
    },
    {
        label: "openai_responses stream response.content_part.added",
        fn: "fromStreamResponse",
        input: {
            type: "response.content_part.added",
            sequence_number: 4,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        },
    },
    {
        label: "openai_responses stream response.content_part.done",
        fn: "fromStreamResponse",
        input: {
            type: "response.content_part.done",
            sequence_number: 10,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "hi", annotations: [] },
        },
    },
    {
        label: "openai_responses stream response.output_text.done",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_text.done",
            sequence_number: 8,
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            text: "hi there",
        },
    },
    {
        label: "openai_responses stream response.function_call_arguments.done",
        fn: "fromStreamResponse",
        input: {
            type: "response.function_call_arguments.done",
            sequence_number: 10,
            item_id: "fc_1",
            output_index: 1,
            arguments: '{"city":"Paris"}',
        },
    },

    // gemini
    // fiat's fromBody takes the endpoint's `model` path parameter as a
    // "model" key in the body; the REST endpoint itself puts model in the
    // URL path, not the JSON body. Every other key below is literal wire.
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
                            inlineData: {
                                mimeType: "image/png",
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
                serviceTier: "standard",
            },
            responseId: "resp_123",
            modelVersion: "gemini-3.5-flash",
        },
    },
    {
        label: "gemini response tool call",
        fn: "fromResponse",
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
                serviceTier: "standard",
            },
            responseId: "resp_123",
            modelVersion: "gemini-3.5-flash",
        },
    },
    {
        label: "gemini stream usage-only final chunk",
        fn: "fromStreamResponse",
        input: {
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15,
                serviceTier: "standard",
            },
        },
    },

    // openai_realtime
    // fiat's fromBody and fromResponse take a `{model, events}` aggregate:
    // one body object holding the model and the list of client or server
    // events to raise. That aggregate is fiat's input shape, not a single
    // provider body or event; every event inside it is literal wire.
    {
        label: "openai_realtime request text, image, system prompt, tool",
        fn: "fromBody",
        input: {
            model: "gpt-realtime",
            events: [
                {
                    event_id: "evt_1",
                    type: "conversation.item.create",
                    item: {
                        type: "message",
                        role: "user",
                        content: [
                            { type: "input_text", text: "hi" },
                            {
                                type: "input_image",
                                image_url: "data:image/png;base64,aGk=",
                            },
                        ],
                    },
                },
                {
                    event_id: "evt_2",
                    type: "response.create",
                    response: {
                        instructions: "be brief",
                        max_output_tokens: 100,
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
                    event_id: "evt_a",
                    type: "conversation.item.create",
                    item: {
                        type: "function_call",
                        call_id: "call_1",
                        name: "get_weather",
                        arguments: '{"city":"Paris"}',
                    },
                },
                {
                    event_id: "evt_b",
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: "call_1",
                        output: "18C",
                    },
                },
                {
                    event_id: "evt_c",
                    type: "response.create",
                    response: {
                        output_modalities: ["text"],
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
            model: "gpt-realtime",
            events: [
                {
                    event_id: "evt_1",
                    type: "response.done",
                    response: {
                        id: "resp_1",
                        object: "realtime.response",
                        created_at: 123,
                        status: "completed",
                        status_details: null,
                        model: "gpt-realtime",
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
        label: "openai_realtime response failed",
        fn: "fromResponse",
        input: {
            events: [
                {
                    event_id: "evt_2",
                    type: "response.done",
                    response: {
                        id: "resp_1",
                        object: "realtime.response",
                        created_at: 123,
                        status: "failed",
                        status_details: {
                            type: "failed",
                            error: { code: "server_error", message: "oops" },
                        },
                        usage: {
                            input_tokens: 1,
                            output_tokens: 0,
                            total_tokens: 1,
                        },
                    },
                },
            ],
        },
    },
    {
        label: "openai_realtime stream output item added",
        fn: "fromStreamResponse",
        input: {
            event_id: "e4",
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
        label: "openai_realtime stream text delta",
        fn: "fromStreamResponse",
        input: {
            event_id: "e5",
            type: "response.output_text.delta",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "hello",
        },
    },
    {
        label: "openai_realtime stream output text done",
        fn: "fromStreamResponse",
        input: {
            event_id: "e6",
            type: "response.output_text.done",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            text: "hi there",
        },
    },
    {
        label: "openai_realtime stream content part done",
        fn: "fromStreamResponse",
        input: {
            event_id: "e7",
            type: "response.content_part.done",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "hi there" },
        },
    },
    {
        label: "openai_realtime stream tool call argument delta",
        fn: "fromStreamResponse",
        input: {
            event_id: "e8",
            type: "response.function_call_arguments.delta",
            response_id: "resp_1",
            item_id: "fc_1",
            output_index: 1,
            delta: '{"ci',
        },
    },
    {
        label: "openai_realtime stream output item done, function call",
        fn: "fromStreamResponse",
        input: {
            event_id: "e9",
            type: "response.output_item.done",
            response_id: "resp_1",
            output_index: 1,
            item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Paris"}',
            },
        },
    },
    {
        label: "openai_realtime stream done with usage",
        fn: "fromStreamResponse",
        input: {
            event_id: "e10",
            type: "response.done",
            response: {
                id: "resp_1",
                object: "realtime.response",
                created_at: 123,
                status: "completed",
                status_details: null,
                model: "gpt-realtime",
                output: [],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            },
        },
    },
    {
        label: "openai_realtime stream response.created",
        fn: "fromStreamResponse",
        input: {
            event_id: "e1",
            type: "response.created",
            response: { id: "resp_1", status: "in_progress" },
        },
    },
    {
        label: "openai_realtime stream response.content_part.added",
        fn: "fromStreamResponse",
        input: {
            event_id: "e2",
            type: "response.content_part.added",
            response_id: "resp_1",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
        },
    },
];

// A unit names one leaf of wire data a dialect op still carries, and says
// which input left it. A bare op name, a unit that stops at the first
// nesting level, or one unit string shared by several inputs lets a new
// provider-only field hide behind an existing row, so the walk goes to full
// depth through every object and array the op holds, and each unit is
// prefixed by the kind of input that produced it. A unit string is the input
// kind — `request`, `response`, or `stream` plus, for a stream event that has
// one, the event's wire `type` — then the op name, the wire slot, the
// object's tag where it has one, and the path to the leaf, with every array
// level written `[]`:
// - a keyed op (body_field, event_param, response_param,
//   stream_choice_param, sampling) starts from `op:key`;
// - an op holding a whole wire object (output_meta, item_meta, part_meta,
//   stream_event, ...) starts from the object's tag — its `type` or `kind`;
// - an op holding a record of wire fields (usage, generation_config,
//   candidate_meta) starts from `op`;
// - the path then names each leaf, e.g.
//   `stream:response.done:openai_realtime.event_param:type`.
// openai_chat and gemini chunks have no wire `type`, so their stream units
// start with `stream` alone. The walk is by shape, not op name: an op the
// test has never seen is walked the same way, so a new dialect op cannot
// slip through unsplit. A new key at any depth is a new unit; new array
// elements reuse the same unit. The input prefix splits units by input, so
// cleaning one event or one body kind stales its own row.
//
// The walk stops at values that hold caller-defined JSON. Those values are
// the caller's data, not the provider's wire shape, so the keys inside them
// are not wire data and do not open units. A stop below names either a
// field (stops in the dialects listed, when the value is an object) or one
// exact unit (a field name other ops carry as wire, stopped only where it
// holds caller data). The stop still emits the unit for the field itself,
// so its presence on the wire stays checked. Every stop must be reached by
// some corpus case; the test fails on an unreached stop, so a stop cannot
// silently protect data nothing exercises. Main's raises lift tool
// arguments and tool schemas to core ops before any dialect op can hold
// them, so no stop exists for them: if a future raise leaves such JSON in
// a dialect op, each caller key opens a unit and must be classified or
// given a justified stop with a corpus case.
const stopPaths: Record<string, string | string[]> = {
    // A free-form key-value map the caller set on the request, echoed back
    // by the provider. The anthropic_messages request `metadata` is a
    // provider-defined object (`user_id`), so it is walked there.
    metadata: [
        "openai_chat",
        "openai_responses",
        "openai_realtime",
        "caller's free-form metadata",
    ],
    // The gemini functionResponse payload, kept raw for round-trip. Every
    // other `response` field (openai_realtime event_param, openai_responses
    // body_field) holds a provider response object and is walked.
    "gemini.part_meta:functionResponse:response":
        "caller's tool result payload",
};

function stopApplies(name: string, dialect: string): boolean {
    if (!Object.hasOwn(stopPaths, name)) return false;
    const stop = stopPaths[name]!;
    // A list names the dialects the stop applies to; its last element is
    // the comment.
    return Array.isArray(stop) ? stop.includes(dialect) : true;
}

function stopComment(name: string): string {
    const stop = stopPaths[name]!;
    return Array.isArray(stop) ? stop[stop.length - 1]! : stop;
}

// Stop paths the corpus actually exercised. The walk records a stop when
// it stops there; the test fails when a listed stop path is never reached,
// because a stop nothing exercises protects nothing.
const reachedStops = new Set<string>();

function isStopField(name: string, value: unknown, dialect: string): boolean {
    const applies =
        !name.includes(":") &&
        stopApplies(name, dialect) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value);
    if (applies) reachedStops.add(name);
    return applies;
}

function isStopUnit(unit: string, input: string): boolean {
    // The walk builds units with the input prefix in front; strip it to
    // compare against the exact-unit stop paths.
    const unprefixed = unit.startsWith(input)
        ? unit.slice(input.length + 1)
        : unit;
    const applies = Object.hasOwn(stopPaths, unprefixed);
    if (applies) reachedStops.add(unprefixed);
    return applies;
}

// Op mechanics, not wire data: they never open a unit. `of` names the op a
// side op decorates; `idSource` marks a gemini id the raise synthesized.
const opMechanics = new Set([
    "op",
    "appliesTo",
    "eventType",
    "preservesContent",
    "idSource",
    "of",
]);

// The input prefix names the kind of input that produced the ops, so a unit
// raised from a request, a complete response, and one stream event is three
// rows, not one. For a stream event with a wire `type` the prefix carries
// that type too, so every stream row names one event kind.
function inputPrefixOf(c: Case): string {
    if (c.fn === "fromBody") return "request";
    if (c.fn === "fromResponse") return "response";
    const type = (c.input as Record<string, unknown>).type;
    if (typeof type === "string") return `stream:${type}`;
    // openai_chat and gemini chunks carry no `type`.
    return "stream";
}

function unitsOf(op: Op, input: string, dialect: string): string[] {
    const data = op as unknown as Record<string, unknown>;
    const units: string[] = [];
    const root = `${input}:${op.op}`;
    if (typeof data.key === "string" && "value" in data) {
        // Keyed op: the key names the wire slot.
        const prefix = `${root}:${data.key}`;
        if (isStopField(data.key, data.value, dialect)) units.push(prefix);
        else walk(prefix, data.value, "");
        return units;
    }
    // Any other op: an object or array field is the op's wire payload, so
    // the walk starts inside it; a scalar field names a wire slot of its
    // own and keeps its name in the path.
    for (const field of Object.keys(data)) {
        if (opMechanics.has(field)) continue;
        const value = data[field];
        if (
            (typeof value === "object" && value !== null) ||
            Array.isArray(value)
        ) {
            walk(root, value, "");
        } else {
            walk(root, value, field);
        }
    }
    return units;

    function walk(prefix: string, value: unknown, path: string): void {
        if (Array.isArray(value)) {
            if (value.length === 0) {
                // An empty array is still a wire slot; a row for it goes
                // stale when a change drops it.
                units.push(`${prefix}:${path === "" ? "" : path}[]`);
                return;
            }
            const child = path === "" ? "[]" : `${path}[]`;
            for (const element of value) walk(prefix, element, child);
            return;
        }
        if (typeof value === "object" && value !== null) {
            let ownPrefix = prefix;
            if (path === "") {
                // A whole wire object tags its units with its `type` or
                // `kind`, so rows for different item kinds do not collide.
                const tag =
                    (value as Record<string, unknown>).type ??
                    (value as Record<string, unknown>).kind;
                if (typeof tag === "string") ownPrefix = `${prefix}:${tag}`;
            }
            const entries = Object.entries(value as Record<string, unknown>);
            if (entries.length === 0) {
                units.push(path === "" ? ownPrefix : `${ownPrefix}:${path}`);
                return;
            }
            for (const [key, childValue] of entries) {
                const child = path === "" ? key : `${path}.${key}`;
                const unit = `${ownPrefix}:${child}`;
                if (
                    isStopField(key, childValue, dialect) ||
                    isStopUnit(unit, input)
                ) {
                    units.push(unit);
                    continue;
                }
                walk(ownPrefix, childValue, child);
            }
            return;
        }
        units.push(path === "" ? prefix : `${prefix}:${path}`);
    }
}

describe("dialect residual allowlist", () => {
    test("raising ordinary bodies leaves only allowlisted dialect ops", () => {
        const seen = new Set<string>();
        const violations: string[] = [];
        const skipped: string[] = [];
        reachedStops.clear();

        for (const unit of Object.keys(providerOnly)) {
            if (baseline.includes(unit)) {
                violations.push(
                    `"${unit}" is in both providerOnly and baseline ` +
                        `(${allowlistFile}) — keep it in providerOnly only`,
                );
            }
        }

        for (const c of cases) {
            const dialect = c.label.split(" ")[0]!;
            const translator = translators[dialect]!;
            const input = inputPrefixOf(c);
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
                for (const unit of unitsOf(op, input, dialect)) {
                    seen.add(unit);
                    if (
                        !Object.hasOwn(providerOnly, unit) &&
                        !baseline.includes(unit)
                    ) {
                        violations.push(
                            `dialect op unit "${unit}" is not in the allowlist ` +
                                `(${allowlistFile}) — produced by ` +
                                `"${c.label}". Add a providerOnly row with a ` +
                                `reason it is provider-only, or raise the ` +
                                `concept to a core op.`,
                        );
                    }
                }
            }
        }

        for (const name of Object.keys(stopPaths)) {
            if (!reachedStops.has(name)) {
                violations.push(
                    `stop path "${name}" (${allowlistFile}) was reached by ` +
                        `no corpus case — extend the corpus or remove the ` +
                        `stop path`,
                );
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

        for (const unit of Object.keys(providerOnly)) {
            if (!seen.has(unit)) {
                violations.push(
                    `providerOnly row "${unit}" (${allowlistFile}) was never ` +
                        `produced by the corpus — extend the corpus or ` +
                        `remove the row`,
                );
            }
        }
        for (const unit of baseline) {
            if (!seen.has(unit)) {
                violations.push(
                    `baseline row "${unit}" (${allowlistFile}) was never ` +
                        `produced by the corpus — extend the corpus or ` +
                        `remove the row`,
                );
            }
        }

        expect(violations.join("\n\n")).toBe("");
    });
});
