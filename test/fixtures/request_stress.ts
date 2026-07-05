import type { Program } from "../../src/index";

export const mixedHistoryProgram: Program = [
    { op: "llm.model", model: "gpt-4o-mini" },
    { op: "llm.max_output_tokens", value: 256 },
    {
        op: "llm.text",
        role: "system",
        content: "use the invoice and policy tools, then answer tersely.",
    },
    {
        op: "openai_chat.message_meta",
        message: { role: "developer" },
        appliesTo: "request",
        required: false,
    },
    { op: "openai_realtime.response_input_mode", required: false },
    {
        op: "llm.tool",
        name: "lookup_invoice",
        description: "Fetch invoice status by invoice id.",
        inputSchema: {
            type: "object",
            properties: { invoice_id: { type: "string" } },
            required: ["invoice_id"],
        },
    },
    {
        op: "openai_responses.tool_meta",
        name: "lookup_invoice",
        fields: { strict: true },
        appliesTo: "request",
        required: false,
    },
    {
        op: "llm.tool",
        name: "lookup_policy",
        description: "Fetch refund policy by plan.",
        inputSchema: {
            type: "object",
            properties: { plan: { type: "string" } },
            required: ["plan"],
        },
    },
    { op: "llm.tool_choice", value: "auto" },
    {
        op: "llm.text",
        role: "user",
        content: "check invoice INV-7 and the refund policy for pro annual",
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "i am checking the invoice and the policy now.",
    },
    {
        op: "llm.tool_call",
        id: "call_invoice",
        name: "lookup_invoice",
        arguments: { invoice_id: "INV-7" },
    },
    {
        op: "gemini.part_meta",
        part: {
            kind: "functionCall",
            index: 0,
            id: "call_invoice",
            meta: { thoughtSignature: "hist_sig_invoice" },
        },
        required: false,
    },
    {
        op: "llm.tool_call",
        id: "call_policy",
        name: "lookup_policy",
        arguments: { plan: "pro_annual" },
    },
    {
        op: "llm.tool_result",
        id: "call_invoice",
        content: '{"status":"paid","refundable":true}',
    },
    {
        op: "anthropic_messages.tool_result_meta",
        fields: { cache_control: { type: "ephemeral" } },
        required: false,
    },
    {
        op: "llm.tool_result",
        id: "call_policy",
        content: '{"window_days":30}',
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "the invoice is paid and refundable within 30 days.",
    },
    { op: "llm.text", role: "user", content: "answer in one line" },
];

export const refundWorkflowProgram: Program = [
    { op: "llm.model", model: "gpt-4o-mini" },
    { op: "llm.max_output_tokens", value: 512 },
    {
        op: "llm.text",
        role: "system",
        content:
            "use the billing policy. after any tool use, answer in one sentence.",
    },
    {
        op: "openai_chat.message_meta",
        message: { role: "developer" },
        appliesTo: "request",
        required: false,
    },
    {
        op: "llm.tool",
        name: "lookup_invoice",
        description: "fetch invoice state",
        inputSchema: {
            type: "object",
            properties: { invoice_id: { type: "string" } },
            required: ["invoice_id"],
        },
    },
    {
        op: "openai_responses.tool_meta",
        name: "lookup_invoice",
        fields: { strict: true },
        appliesTo: "request",
        required: false,
    },
    {
        op: "llm.tool",
        name: "issue_refund",
        description: "submit a refund",
        inputSchema: {
            type: "object",
            properties: {
                invoice_id: { type: "string" },
                amount_cents: { type: "number" },
            },
            required: ["invoice_id", "amount_cents"],
        },
    },
    { op: "llm.tool_choice", value: "auto" },
    {
        op: "llm.text",
        role: "user",
        content: "refund invoice inv_1001 if it was paid twice.",
    },
    {
        op: "anthropic_messages.text_meta",
        fields: { cache_control: { type: "ephemeral" } },
        required: false,
    },
    {
        op: "llm.tool_call",
        id: "call_lookup_1|item_lookup_1",
        name: "lookup_invoice",
        arguments: { invoice_id: "inv_1001" },
    },
    {
        op: "llm.tool_result",
        id: "call_lookup_1|item_lookup_1",
        content:
            '{"invoice_id":"inv_1001","duplicate_payment":true,"amount_cents":1250}',
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "invoice inv_1001 was paid twice. i will issue the refund.",
    },
    {
        op: "llm.tool_call",
        id: "call_refund_1|item_refund_1",
        name: "issue_refund",
        arguments: { invoice_id: "inv_1001", amount_cents: 1250 },
    },
    {
        op: "llm.tool_result",
        id: "call_refund_1|item_refund_1",
        content: '{"refund_id":"rf_900","status":"submitted"}',
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "refund rf_900 is submitted.",
    },
    {
        op: "llm.text",
        role: "user",
        content: "summarize the outcome in one sentence.",
    },
];

export const geminiPlannerProgram: Program = [
    { op: "llm.model", model: "models/gemini-3.5-flash" },
    { op: "llm.max_output_tokens", value: 384 },
    {
        op: "llm.text",
        role: "system",
        content: "plan carefully, keep tool context, and answer briefly.",
    },
    {
        op: "llm.tool",
        name: "lookup_office",
        description: "Resolve an office name from a city.",
        inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
        },
    },
    {
        op: "llm.tool",
        name: "get_weather",
        description: "Fetch the weather for an office.",
        inputSchema: {
            type: "object",
            properties: { office: { type: "string" } },
            required: ["office"],
        },
    },
    {
        op: "llm.text",
        role: "user",
        content: "find the paris office and then check its weather",
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "i am resolving the office first.",
    },
    {
        op: "llm.tool_call",
        id: "call_office",
        name: "lookup_office",
        arguments: { city: "Paris" },
    },
    {
        op: "gemini.part_meta",
        part: {
            kind: "functionCall",
            index: 0,
            id: "call_office",
            meta: { thoughtSignature: "sig_lookup" },
        },
        required: false,
    },
    {
        op: "llm.tool_result",
        id: "call_office",
        content: '{"office":"Paris HQ"}',
    },
    {
        op: "anthropic_messages.tool_result_meta",
        fields: { cache_control: { type: "ephemeral" } },
        required: false,
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "office found. now checking the weather.",
    },
    {
        op: "llm.tool_call",
        id: "call_weather",
        name: "get_weather",
        arguments: { office: "Paris HQ" },
    },
    {
        op: "gemini.part_meta",
        part: {
            kind: "functionCall",
            index: 0,
            id: "call_weather",
            meta: { thoughtSignature: "sig_weather" },
        },
        required: false,
    },
    {
        op: "llm.tool_result",
        id: "call_weather",
        content: '{"temp_c":21,"condition":"sunny"}',
    },
    {
        op: "llm.text",
        role: "assistant",
        content: "paris hq is sunny and 21c.",
    },
    { op: "llm.text", role: "user", content: "reply in one sentence" },
];
