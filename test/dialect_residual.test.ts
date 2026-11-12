// Guards the rule Alex set after PR #11: data that several providers have
// must be raised to a core op, not left in a dialect-specific op. The test
// raises ordinary request bodies, complete response bodies, and single stream
// events of every dialect through the dialect's public translators, splits
// every op outside the core namespaces into units (see "A unit" below), and
// checks each unit against test/dialect_residual_allowlist.ts. A providerOnly
// row names the public API references that show no other provider has the
// data. A baseline row is a residual that main has today: backlog to raise to
// a core op or to move to providerOnly with a reason. A raise that throws is
// recorded as a skip, not a failure; the skips that main has are listed in
// expectedSkips, so a raise that starts or stops throwing fails the test too.

import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    isCoreOp,
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
const testFile = "test/dialect_residual.test.ts";

type TranslatorFn = "fromBody" | "fromResponse" | "fromStreamResponse";

interface Case {
    // Names the input in a failure message, e.g. "openai_chat stream chunk".
    label: string;
    fn: TranslatorFn;
    input: unknown;
}

// Ordinary inputs whose raise throws on main. The test cannot check what
// such a raise would leave, so each row is backlog for a fix under src.
const expectedSkips = [
    "anthropic_messages stream message_start",
    "anthropic_messages stream content_block_start text",
    "anthropic_messages stream content_block_start thinking",
    "anthropic_messages stream thinking_delta",
    "anthropic_messages stream signature_delta",
    "anthropic_messages stream content_block_stop",
    "anthropic_messages stream ping",
    "anthropic_messages stream error",
    "openai_responses stream response.created",
    "openai_responses stream response.in_progress",
    "openai_responses stream response.content_part.added",
    "openai_responses stream response.content_part.done",
    "openai_responses stream response.output_text.done",
    "openai_responses stream response.function_call_arguments.done",
    "openai_responses stream response.reasoning_summary_text.delta",
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

    {
        label: "anthropic_messages request diagnostics previous_message_id",
        fn: "fromBody",
        input: {
            model: "claude-sonnet-4-6",
            max_tokens: 100,
            diagnostics: { previous_message_id: "msg_0" },
            messages: [{ role: "user", content: "hi" }],
        },
    },
    {
        label: "anthropic_messages response thinking block",
        fn: "fromResponse",
        input: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
                { type: "thinking", thinking: "hmm", signature: "EqQBCg==" },
                { type: "text", text: "hi" },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
        },
    },
    {
        label: "anthropic_messages stream content_block_start thinking",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
        },
    },
    {
        label: "anthropic_messages stream thinking_delta",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "hmm" },
        },
    },
    {
        label: "anthropic_messages stream signature_delta",
        fn: "fromStreamResponse",
        input: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "EqQBCg==" },
        },
    },
    {
        label: "anthropic_messages stream error",
        fn: "fromStreamResponse",
        input: {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
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

    {
        label: "openai_chat request store and metadata",
        fn: "fromBody",
        input: {
            model: "gpt-4o",
            store: true,
            metadata: { trace: "abc" },
            messages: [{ role: "user", content: "hi" }],
        },
    },
    {
        label: "openai_chat response metadata",
        fn: "fromResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 123,
            model: "gpt-4o",
            metadata: { trace: "abc" },
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "hi" },
                    finish_reason: "stop",
                },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
    },
    {
        label: "openai_chat stream chunk with service_tier, system_fingerprint, logprobs, obfuscation",
        fn: "fromStreamResponse",
        input: {
            id: "chatcmpl-1",
            object: "chat.completion.chunk",
            created: 123,
            model: "gpt-4o",
            service_tier: "default",
            system_fingerprint: "fp_1",
            choices: [
                {
                    index: 0,
                    delta: { content: "hi" },
                    logprobs: null,
                    finish_reason: null,
                },
            ],
            obfuscation: "abc",
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

    {
        label: "openai_responses request previous_response_id and metadata",
        fn: "fromBody",
        input: {
            model: "gpt-5",
            input: "hi",
            previous_response_id: "resp_0",
            metadata: { trace: "abc" },
        },
    },
    {
        label: "openai_responses response metadata, conversation, moderation",
        fn: "fromResponse",
        input: {
            id: "resp_1",
            object: "response",
            created_at: 1741386163,
            status: "completed",
            model: "gpt-5",
            previous_response_id: "resp_0",
            conversation: { id: "conv_1" },
            metadata: { trace: "abc" },
            moderation: {
                input: {
                    type: "moderation_result",
                    model: "omni-moderation-latest",
                    flagged: false,
                    categories: { hate: false },
                    category_scores: { hate: 0.01 },
                    category_applied_input_types: { hate: ["text"] },
                },
                output: {
                    type: "moderation_result",
                    model: "omni-moderation-latest",
                    flagged: false,
                    categories: { hate: false },
                    category_scores: { hate: 0.02 },
                    category_applied_input_types: { hate: ["text"] },
                },
            },
            output: [
                {
                    type: "message",
                    id: "msg_1",
                    status: "completed",
                    role: "assistant",
                    content: [
                        { type: "output_text", text: "hi", annotations: [] },
                    ],
                },
            ],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        },
    },
    {
        label: "openai_responses response reasoning item",
        fn: "fromResponse",
        input: {
            id: "resp_1",
            object: "response",
            created_at: 1741386163,
            status: "completed",
            model: "o3",
            output: [
                {
                    type: "reasoning",
                    id: "rs_1",
                    summary: [{ type: "summary_text", text: "hmm" }],
                    encrypted_content: "enc",
                },
                {
                    type: "message",
                    id: "msg_1",
                    status: "completed",
                    role: "assistant",
                    content: [
                        { type: "output_text", text: "hi", annotations: [] },
                    ],
                },
            ],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        },
    },
    {
        label: "openai_responses stream output item added, function call",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_item.added",
            sequence_number: 3,
            output_index: 1,
            item: {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: "",
                status: "in_progress",
            },
        },
    },
    {
        label: "openai_responses stream output item done, message",
        fn: "fromStreamResponse",
        input: {
            type: "response.output_item.done",
            sequence_number: 9,
            output_index: 0,
            item: {
                type: "message",
                id: "msg_1",
                status: "completed",
                role: "assistant",
                content: [
                    { type: "output_text", text: "hi there", annotations: [] },
                ],
            },
        },
    },
    {
        label: "openai_responses stream response.reasoning_summary_text.delta",
        fn: "fromStreamResponse",
        input: {
            type: "response.reasoning_summary_text.delta",
            sequence_number: 4,
            item_id: "rs_1",
            output_index: 0,
            summary_index: 0,
            delta: "hmm",
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

    {
        label: "gemini response prompt feedback and safety ratings",
        fn: "fromResponse",
        input: {
            promptFeedback: {
                safetyRatings: [
                    {
                        category: "HARM_CATEGORY_HARASSMENT",
                        probability: "NEGLIGIBLE",
                    },
                ],
            },
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "hi" }] },
                    finishReason: "STOP",
                    index: 0,
                    safetyRatings: [
                        {
                            category: "HARM_CATEGORY_HARASSMENT",
                            probability: "NEGLIGIBLE",
                            blocked: false,
                        },
                    ],
                },
            ],
            usageMetadata: {
                promptTokenCount: 3,
                candidatesTokenCount: 1,
                totalTokenCount: 4,
            },
        },
    },
    {
        label: "gemini response tool call without id",
        fn: "fromResponse",
        input: {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { city: "Paris" },
                                },
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
        label: "gemini response thought part",
        fn: "fromResponse",
        input: {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            { text: "thinking...", thought: true },
                            { text: "hi" },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 3,
                candidatesTokenCount: 1,
                totalTokenCount: 4,
            },
        },
    },
    {
        label: "gemini stream thought part with safety ratings",
        fn: "fromStreamResponse",
        input: {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [{ text: "thinking...", thought: true }],
                    },
                    index: 0,
                    safetyRatings: [
                        {
                            category: "HARM_CATEGORY_HARASSMENT",
                            probability: "NEGLIGIBLE",
                        },
                    ],
                },
            ],
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
    {
        label: "openai_realtime request response.create metadata",
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
                        content: [{ type: "input_text", text: "hi" }],
                    },
                },
                {
                    event_id: "evt_2",
                    type: "response.create",
                    response: { metadata: { trace: "abc" } },
                },
            ],
        },
    },
    {
        label: "openai_realtime response metadata and conversation_id",
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
                        status: "completed",
                        status_details: null,
                        conversation_id: "conv_1",
                        metadata: { trace: "abc" },
                        output: [
                            {
                                id: "msg_1",
                                object: "realtime.item",
                                type: "message",
                                status: "completed",
                                role: "assistant",
                                content: [
                                    { type: "output_text", text: "hi there" },
                                ],
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
        label: "openai_realtime stream output item added, function call",
        fn: "fromStreamResponse",
        input: {
            event_id: "e3",
            type: "response.output_item.added",
            response_id: "resp_1",
            output_index: 1,
            item: {
                id: "fc_1",
                object: "realtime.item",
                type: "function_call",
                status: "in_progress",
                call_id: "call_1",
                name: "get_weather",
                arguments: "",
            },
        },
    },
    {
        label: "openai_realtime stream output item done, message",
        fn: "fromStreamResponse",
        input: {
            event_id: "e9",
            type: "response.output_item.done",
            response_id: "resp_1",
            output_index: 0,
            item: {
                id: "msg_1",
                object: "realtime.item",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: "hi there" }],
            },
        },
    },
    {
        label: "openai_realtime stream done with output and conversation_id",
        fn: "fromStreamResponse",
        input: {
            event_id: "e10",
            type: "response.done",
            response: {
                id: "resp_1",
                object: "realtime.response",
                status: "completed",
                status_details: null,
                conversation_id: "conv_1",
                output: [
                    {
                        id: "msg_1",
                        object: "realtime.item",
                        type: "message",
                        status: "completed",
                        role: "assistant",
                        content: [{ type: "output_text", text: "hi there" }],
                    },
                ],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    total_tokens: 15,
                },
            },
        },
    },
];

// A unit names one leaf of provider data that a raise leaves outside the core
// ops, and says which input left it. A bare op name, a unit that stops at the
// first nesting level, or one unit string shared by several inputs lets a new
// field hide behind an existing row, so the walk goes to full depth through
// every object and array the op holds, and each unit starts with the input
// that produced it: `request` for a request body, `response` for a response
// body, and `stream` for a stream event, followed by the event's wire `type`
// when the event has one. The op name comes next, then the path to the leaf,
// with every array level written `[]`:
// - an op with `key` and `value` (body_field, event_param, response_param,
//   stream_choice_param, sampling) continues with the key;
// - an op whose one other field is a whole wire object (output_meta,
//   item_meta, part_meta, stream_event, ...) continues with the object's
//   `type` or `kind`, when it has one;
// - an op whose one other field is a record of wire fields (usage,
//   generation_config, candidate_meta) continues with the leaf path;
// - an op whose one other field is a scalar continues with the field name;
// - an op with no field besides its name and its bookkeeping is one unit:
//   the input and the op name;
// - a field beyond that one payload is written `@field`: on an op with
//   `key` and `value`, every other field continues `op:key@field`; on any
//   other op with several fields, every field continues `op@field`. No
//   corpus case produces such a field on main, so every `@` unit is new.
// Example: `stream:response.done:openai_realtime.event_param:type`.
// openai_chat and gemini stream chunks have no wire `type`, so their units
// start with `stream` alone. The walk goes by the shape of the op, not by its
// name, and it covers every op whose namespace is not a core namespace, so an
// op the test has never seen, in a namespace the test has never seen, is
// split into units the same way. A new key at any depth is a new unit; new
// array elements reuse the same unit.
//
// Limits of the walk:
// - The lists hold one row per unit, not one row per corpus case. When two
//   cases produce the same unit and a change removes the unit from one of
//   them, the row does not go stale, and the same data can return to that
//   case later without a failure. openai_chat and gemini stream chunks share
//   units this way, because their units carry no event type.
// - The walk reads keys, not values. A changed value under a listed key is
//   the same unit.

// The walk stops at an object that holds JSON the provider does not define:
// the keys inside are chosen by whoever built the request, so they are not
// wire data and do not open units. A stop is one exact unit, written without
// its input, so it covers one field of one op of one dialect and nothing
// deeper or elsewhere. The stop still emits the unit of the field itself, so
// the field's presence stays checked. Every stop needs a corpus case in which
// the object holds at least one key; the test fails on a stop that hid no
// key. Main's raises lift tool arguments and tool schemas to core ops, so no
// stop exists for them.
//
// The four `metadata` stops are the free-form key-value map of the OpenAI
// APIs: set on a request body, and returned on the response body. The
// anthropic_messages request `metadata` is an object the provider defines
// (`user_id`), and the `metadata` inside the response object of an
// openai_responses or openai_realtime stream event has no stop: the walk
// opens both.
const stopPaths: Record<string, string> = {
    "openai_chat.body_field:metadata": "free-form metadata map",
    "openai_responses.body_field:metadata": "free-form metadata map",
    "openai_realtime.response_param:metadata": "free-form metadata map",
    "openai_realtime.body_field:metadata": "free-form metadata map",
    // The gemini functionResponse payload, kept raw for round-trip.
    "gemini.part_meta:functionResponse:response": "tool result payload",
};

// Stops that hid at least one key during the run.
const reachedStops = new Set<string>();

function isStop(unit: string, input: string, value: unknown): boolean {
    const path = unit.slice(input.length + 1);
    if (!Object.hasOwn(stopPaths, path)) return false;
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    if (Object.keys(value).length > 0) reachedStops.add(path);
    return true;
}

// Fields that are fiat's bookkeeping on one op, not provider data: they open
// no unit. A field is listed under the op that carries it, so the same field
// name on any other op opens a unit. Every entry needs a corpus case that
// raises the op with the field; the test fails on an entry no case reached.
// - `preservesContent` marks a gemini.content op that lowering must keep.
// - `eventType` names the event an openai_realtime.event_param belongs to;
//   the event's wire `type` is a unit of its own.
// - `of` holds the id of the llm.reasoning op that an
//   openai_responses.reasoning_item decorates.
// An entry hides a string or a boolean only, so a listed name cannot hide a
// wire object. The value of a hidden string is not checked.
const opMechanics: Record<string, string[]> = {
    "gemini.content": ["preservesContent"],
    "openai_realtime.event_param": ["eventType"],
    "openai_responses.reasoning_item": ["of"],
};

// `op:field` pairs of opMechanics that hid a field during the run.
const reachedMechanics = new Set<string>();

function isMechanics(op: Op, field: string, value: unknown): boolean {
    if (field === "op") return true;
    // `appliesTo` is declared on every dialect op in src/core/ops.ts and
    // holds one of two values; any other value opens a unit.
    if (field === "appliesTo")
        return value === "request" || value === "response";
    if (!opMechanics[op.op]?.includes(field)) return false;
    if (typeof value !== "string" && typeof value !== "boolean") return false;
    reachedMechanics.add(`${op.op}:${field}`);
    return true;
}

// The start of every unit a case produces: which input the ops came from.
// A stream event with a wire `type` puts the type in the unit, so a row
// names one event.
function inputPrefixOf(c: Case): string {
    if (c.fn === "fromBody") return "request";
    if (c.fn === "fromResponse") return "response";
    const type = (c.input as Record<string, unknown>).type;
    if (typeof type === "string") return `stream:${type}`;
    // openai_chat and gemini chunks carry no `type`.
    return "stream";
}

function unitsOf(op: Op, input: string): string[] {
    const data = op as unknown as Record<string, unknown>;
    const units: string[] = [];
    const root = `${input}:${op.op}`;
    const fields = Object.keys(data).filter(
        (field) => !isMechanics(op, field, data[field]),
    );
    if (fields.length === 0) return [root];
    if (typeof data.key === "string" && "value" in data) {
        // The key names the wire slot, and the value is walked under it.
        const slot = `${root}:${data.key}`;
        walk(slot, data.value, "");
        for (const field of fields) {
            if (field === "key" || field === "value") continue;
            walk(`${slot}@${field}`, data[field], "");
        }
        return units;
    }
    if (fields.length === 1) {
        // The op's one payload: an object or array is walked from the op
        // name, and a scalar keeps its field name in the path.
        const field = fields[0]!;
        const value = data[field];
        if (typeof value === "object" && value !== null) walk(root, value, "");
        else walk(root, value, field);
        return units;
    }
    for (const field of fields) walk(`${root}@${field}`, data[field], "");
    return units;

    function walk(prefix: string, value: unknown, path: string): void {
        const unit = path === "" ? prefix : `${prefix}:${path}`;
        if (isStop(unit, input, value)) {
            units.push(unit);
            return;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                // An empty array is still a wire slot; a row for it goes
                // stale when a change drops it.
                units.push(`${prefix}:${path}[]`);
                return;
            }
            const child = `${path}[]`;
            for (const element of value) walk(prefix, element, child);
            return;
        }
        if (typeof value === "object" && value !== null) {
            let ownPrefix = prefix;
            if (path === "") {
                // A whole wire object puts its `type` or `kind` in its
                // units, so rows for different items do not collide.
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
                walk(
                    ownPrefix,
                    childValue,
                    path === "" ? key : `${path}.${key}`,
                );
            }
            return;
        }
        units.push(unit);
    }
}

describe("dialect residual allowlist", () => {
    test("raising ordinary bodies leaves only allowlisted dialect ops", () => {
        // One set for all cases; see "Limits of the walk" above.
        const seen = new Set<string>();
        const violations: string[] = [];
        const skipped: string[] = [];
        reachedStops.clear();
        reachedMechanics.clear();

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
                            `${testFile}`,
                    );
                }
                continue;
            }

            for (const op of program) {
                if (isCoreOp(op)) continue;
                for (const unit of unitsOf(op, input)) {
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

        for (const path of Object.keys(stopPaths)) {
            if (!reachedStops.has(path)) {
                violations.push(
                    `stop path "${path}" (stopPaths in ${testFile}) hid no ` +
                        `key in any corpus case — add a case whose object ` +
                        `at that path holds a key, or remove the stop path`,
                );
            }
        }

        for (const [opName, fields] of Object.entries(opMechanics)) {
            for (const field of fields) {
                if (!reachedMechanics.has(`${opName}:${field}`)) {
                    violations.push(
                        `opMechanics lists "${field}" for "${opName}" ` +
                            `(${testFile}), but no corpus case raised that ` +
                            `op with that field — add a case or remove ` +
                            `the entry`,
                    );
                }
            }
        }

        for (const label of expectedSkips) {
            if (!skipped.includes(label)) {
                violations.push(
                    `"${label}" no longer throws, but expectedSkips in ` +
                        `${testFile} still lists it — ` +
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
