export const claudeCodeAnthropicRequest = {
    model: "claude-sonnet-5",
    messages: [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "<system-reminder>\nToday's date is 2026-07-03.\n</system-reminder>\n\n",
                },
                {
                    type: "text",
                    text: "using no tools, reply with exactly: claude-proxy-ok",
                    cache_control: { type: "ephemeral" },
                },
            ],
        },
    ],
    system: [
        {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.200.c39; cc_entrypoint=sdk-cli;",
        },
        {
            type: "text",
            text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
            cache_control: { type: "ephemeral" },
        },
    ],
    tools: [
        {
            name: "read_file",
            description: "Read a file.",
            input_schema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
            cache_control: { type: "ephemeral" },
        },
    ],
    metadata: {
        user_id:
            '{"device_id":"ebc5554bc54d76819658ac54d934ebeb08a0c50edc6196e60608cf903697a902","account_uuid":"","session_id":"a53e520c-f577-4ff8-ab3d-8be9d47a9c9c"}',
    },
    max_tokens: 64000,
    thinking: {
        type: "adaptive",
        display: "omitted",
    },
    context_management: {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    },
    output_config: {
        effort: "medium",
        format: {
            type: "json_schema",
            schema: {
                type: "object",
                properties: { result: { type: "string" } },
                required: ["result"],
                additionalProperties: false,
            },
        },
    },
    stop_sequences: ["</stop>"],
    stream: true,
} as const;
