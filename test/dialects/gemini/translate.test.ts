import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
} from "../../../src/index";
import {
    geminiPlannerProgram,
    mixedHistoryProgram,
    refundWorkflowProgram,
} from "../../fixtures/request_stress";

describe("gemini translation", () => {
    test("an openai chat request can lower to gemini contents", () => {
        const body = GeminiTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "models/gemini-3.5-flash",
                max_tokens: 80,
                temperature: 0.2,
                messages: [
                    { role: "system", content: "Reply tersely." },
                    { role: "user", content: "hi" },
                ],
            }),
        );

        expect(body).toEqual({
            model: "models/gemini-3.5-flash",
            generationConfig: { maxOutputTokens: 80, temperature: 0.2 },
            systemInstruction: { parts: [{ text: "Reply tersely." }] },
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
        });
    });

    describe("mixed-vendor history request target", () => {
        test("lowers to Gemini", () => {
            expect(GeminiTranslator.toBody(mixedHistoryProgram)).toEqual({
                model: "gpt-4o-mini",
                generationConfig: { maxOutputTokens: 256 },
                toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: "check invoice INV-7 and the refund policy for pro annual",
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "i am checking the invoice and the policy now.",
                            },
                            {
                                functionCall: {
                                    name: "lookup_invoice",
                                    args: { invoice_id: "INV-7" },
                                    id: "call_invoice",
                                },
                                thoughtSignature: "hist_sig_invoice",
                            },
                            {
                                functionCall: {
                                    name: "lookup_policy",
                                    args: { plan: "pro_annual" },
                                    id: "call_policy",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_invoice",
                                    response: {
                                        status: "paid",
                                        refundable: true,
                                    },
                                    id: "call_invoice",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_policy",
                                    response: { window_days: 30 },
                                    id: "call_policy",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "the invoice is paid and refundable within 30 days.",
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [{ text: "answer in one line" }],
                    },
                ],
                systemInstruction: {
                    parts: [
                        {
                            text: "use the invoice and policy tools, then answer tersely.",
                        },
                    ],
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "lookup_invoice",
                                description:
                                    "Fetch invoice status by invoice id.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        invoice_id: { type: "string" },
                                    },
                                    required: ["invoice_id"],
                                },
                            },
                            {
                                name: "lookup_policy",
                                description: "Fetch refund policy by plan.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        plan: { type: "string" },
                                    },
                                    required: ["plan"],
                                },
                            },
                        ],
                    },
                ],
            });
        });
    });

    describe("refund workflow request target", () => {
        test("lowers to Gemini", () => {
            expect(GeminiTranslator.toBody(refundWorkflowProgram)).toEqual({
                model: "gpt-4o-mini",
                generationConfig: { maxOutputTokens: 512 },
                toolConfig: { functionCallingConfig: { mode: "AUTO" } },
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: "refund invoice inv_1001 if it was paid twice.",
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                functionCall: {
                                    name: "lookup_invoice",
                                    args: { invoice_id: "inv_1001" },
                                    id: "call_lookup_1|item_lookup_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_invoice",
                                    response: {
                                        invoice_id: "inv_1001",
                                        duplicate_payment: true,
                                        amount_cents: 1250,
                                    },
                                    id: "call_lookup_1|item_lookup_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "invoice inv_1001 was paid twice. i will issue the refund.",
                            },
                            {
                                functionCall: {
                                    name: "issue_refund",
                                    args: {
                                        invoice_id: "inv_1001",
                                        amount_cents: 1250,
                                    },
                                    id: "call_refund_1|item_refund_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "issue_refund",
                                    response: {
                                        refund_id: "rf_900",
                                        status: "submitted",
                                    },
                                    id: "call_refund_1|item_refund_1",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [{ text: "refund rf_900 is submitted." }],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                text: "summarize the outcome in one sentence.",
                            },
                        ],
                    },
                ],
                systemInstruction: {
                    parts: [
                        {
                            text: "use the billing policy. after any tool use, answer in one sentence.",
                        },
                    ],
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "lookup_invoice",
                                description: "fetch invoice state",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        invoice_id: { type: "string" },
                                    },
                                    required: ["invoice_id"],
                                },
                            },
                            {
                                name: "issue_refund",
                                description: "submit a refund",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        invoice_id: { type: "string" },
                                        amount_cents: { type: "number" },
                                    },
                                    required: ["invoice_id", "amount_cents"],
                                },
                            },
                        ],
                    },
                ],
            });
        });
    });

    describe("gemini-shaped planner request target", () => {
        test("lowers to Gemini", () => {
            expect(GeminiTranslator.toBody(geminiPlannerProgram)).toEqual({
                model: "models/gemini-3.5-flash",
                generationConfig: { maxOutputTokens: 384 },
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: "find the paris office and then check its weather",
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "i am resolving the office first.",
                            },
                            {
                                functionCall: {
                                    name: "lookup_office",
                                    args: { city: "Paris" },
                                    id: "call_office",
                                },
                                thoughtSignature: "sig_lookup",
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "lookup_office",
                                    response: { office: "Paris HQ" },
                                    id: "call_office",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [
                            {
                                text: "office found. now checking the weather.",
                            },
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { office: "Paris HQ" },
                                    id: "call_weather",
                                },
                                thoughtSignature: "sig_weather",
                            },
                        ],
                    },
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "get_weather",
                                    response: {
                                        temp_c: 21,
                                        condition: "sunny",
                                    },
                                    id: "call_weather",
                                },
                            },
                        ],
                    },
                    {
                        role: "model",
                        parts: [{ text: "paris hq is sunny and 21c." }],
                    },
                    {
                        role: "user",
                        parts: [{ text: "reply in one sentence" }],
                    },
                ],
                systemInstruction: {
                    parts: [
                        {
                            text: "plan carefully, keep tool context, and answer briefly.",
                        },
                    ],
                },
                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: "lookup_office",
                                description:
                                    "Resolve an office name from a city.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        city: { type: "string" },
                                    },
                                    required: ["city"],
                                },
                            },
                            {
                                name: "get_weather",
                                description: "Fetch the weather for an office.",
                                parameters: {
                                    type: "object",
                                    properties: {
                                        office: { type: "string" },
                                    },
                                    required: ["office"],
                                },
                            },
                        ],
                    },
                ],
            });
        });
    });

    test("a tool result whose content is text lowers to gemini as a string under the output key", () => {
        const body = GeminiTranslator.toBody(
            OpenAIChatTranslator.fromBody({
                model: "gpt-4o-mini",
                messages: [
                    { role: "user", content: "what is 19 * 19?" },
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: "call_math",
                                type: "function",
                                function: {
                                    name: "calc",
                                    arguments: '{"expression":"19 * 19"}',
                                },
                            },
                        ],
                    },
                    { role: "tool", tool_call_id: "call_math", content: "361" },
                ],
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "calc",
                            parameters: { type: "object" },
                        },
                    },
                ],
            }),
        );

        expect(body).toEqual({
            model: "gpt-4o-mini",
            contents: [
                { role: "user", parts: [{ text: "what is 19 * 19?" }] },
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "calc",
                                args: { expression: "19 * 19" },
                                id: "call_math",
                            },
                            thoughtSignature:
                                "skip_thought_signature_validator",
                        },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "calc",
                                // Lowering writes text content as the string
                                // under the output key; "361" does not
                                // become the number 361.
                                response: { output: "361" },
                                id: "call_math",
                            },
                        },
                    ],
                },
            ],
            tools: [
                {
                    functionDeclarations: [
                        { name: "calc", parameters: { type: "object" } },
                    ],
                },
            ],
        });
    });

    test("a gemini body with a string tool result raises back to the same content", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                { role: "user", parts: [{ text: "what is 19 * 19?" }] },
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "calc",
                                args: { expression: "19 * 19" },
                                id: "call_math",
                            },
                        },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "calc",
                                response: { output: "361" },
                                id: "call_math",
                            },
                        },
                    ],
                },
            ],
        };

        const program = GeminiTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.tool_result",
            id: "call_math",
            content: "361",
        });
        const lowered = GeminiTranslator.toBody(program) as {
            contents: { role: string; parts: unknown[] }[];
        };
        // The string under the output key is the tool result's text, so the
        // round trip returns the same body. The thoughtSignature Gemini
        // lowering injects on the functionCall part is pre-existing behavior
        // for core tool history without a Gemini response.
        expect(lowered.contents[2]!.parts).toEqual([
            {
                functionResponse: {
                    name: "calc",
                    response: { output: "361" },
                    id: "call_math",
                },
            },
        ]);
    });

    test("a transform that edits llm.tool_result.content changes the gemini body", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "calc",
                                response: { output: 378 },
                                id: "call_math",
                            },
                        },
                    ],
                },
            ],
        };

        const edited = GeminiTranslator.fromBody(body).map((op) =>
            op.op === "llm.tool_result" ? { ...op, content: "999" } : op,
        );

        expect(GeminiTranslator.toBody(edited)).toEqual({
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "calc",
                                // The edit reaches the body as the string
                                // "999" under the output key.
                                response: { output: "999" },
                                id: "call_math",
                            },
                        },
                    ],
                },
            ],
        });
    });

    test("a functionResponse body raised and lowered back to gemini", () => {
        const roundTrip = (
            response: Record<string, unknown> | undefined,
        ): Record<string, unknown> => {
            const body = {
                model: "models/gemini-3.5-flash",
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                functionResponse: {
                                    name: "calc",
                                    ...(response == null ? {} : { response }),
                                    id: "call_math",
                                },
                            },
                        ],
                    },
                ],
            };
            const lowered = GeminiTranslator.toBody(
                GeminiTranslator.fromBody(body),
            ) as typeof body;
            return lowered.contents[0]!.parts[0]!.functionResponse;
        };

        // A string under the output key is the tool result's text, so it
        // returns unchanged.
        expect(roundTrip({ output: "378" })).toEqual({
            name: "calc",
            response: { output: "378" },
            id: "call_math",
        });
        // An object under the output key raises to JSON text, and lowering
        // parses that text back into the object, which becomes the response
        // without the wrapper key.
        expect(roundTrip({ output: { a: 1 } })).toEqual({
            name: "calc",
            response: { a: 1 },
            id: "call_math",
        });
        // A functionResponse with no response comes back with response: {},
        // the same empty struct the tool result content "{}" lowers to.
        expect(roundTrip(undefined)).toEqual({
            name: "calc",
            response: {},
            id: "call_math",
        });
        // A number under the output key raises to the text "378", and
        // lowering writes text back as a string, so the type changes. This
        // is the accepted cost of keeping every other kind of text intact.
        expect(roundTrip({ output: 378 })).toEqual({
            name: "calc",
            response: { output: "378" },
            id: "call_math",
        });
    });

    test("tool result text that is not a JSON object keeps its exact characters", () => {
        const results = [
            "361",
            "12345678901234567890",
            "1.10",
            "true",
            "null",
            "[1,2]",
            '"a"',
        ];
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                { role: "user", parts: [{ text: "what is 19 * 19?" }] },
                {
                    role: "model",
                    parts: results.map((_, i) => ({
                        functionCall: {
                            name: "calc",
                            args: {},
                            id: `call_${i}`,
                        },
                    })),
                },
                {
                    role: "user",
                    parts: results.map((content, i) => ({
                        functionResponse: {
                            name: "calc",
                            response: { output: content },
                            id: `call_${i}`,
                        },
                    })),
                },
            ],
        };

        const program = GeminiTranslator.fromBody(body);
        for (const [i, content] of results.entries()) {
            expect(program).toContainEqual({
                op: "llm.tool_result",
                id: `call_${i}`,
                content,
            });
        }
        const lowered = GeminiTranslator.toBody(program) as typeof body;
        expect(lowered.contents[2]!.parts).toEqual(
            results.map((content, i) => ({
                functionResponse: {
                    name: "calc",
                    response: { output: content },
                    id: `call_${i}`,
                },
            })),
        );
    });

    test("an anthropic response id lowers into the gemini responseId", () => {
        const response = GeminiTranslator.toResponse(
            AnthropicTranslator.fromResponse({
                id: "msg_01ABC",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4-6",
                content: [{ type: "text", text: "It is correct." }],
                stop_reason: "end_turn",
                usage: { input_tokens: 20, output_tokens: 9 },
            }),
        ) as Record<string, unknown>;

        expect(response.responseId).toBe("msg_01ABC");
    });

    test("a gemini responseId raises to response.id and lowers into the anthropic id", () => {
        const program = GeminiTranslator.fromResponse({
            responseId: "resp_123",
            model: "models/gemini-3.5-flash",
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [{ text: "It is correct." }],
                    },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 9 },
        });

        expect(program).toContainEqual({
            op: "response.id",
            id: "resp_123",
        });
        const response = AnthropicTranslator.toResponse(program) as Record<
            string,
            unknown
        >;
        expect(response.id).toBe("resp_123");
    });
});
