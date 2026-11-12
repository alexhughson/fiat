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
        // The string under the output key holds text that is not a JSON
        // object, so the round trip returns the same body. The
        // thoughtSignature Gemini lowering injects on the functionCall
        // part is pre-existing behavior for core tool history without a
        // Gemini response.
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

        // A string under the output key whose text is not a JSON object
        // returns unchanged; one whose text is a JSON object returns as
        // that object, like the last case below.
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
        // is the accepted cost of keeping every other kind of text intact;
        // a boolean, array, or null under output changes the same way.
        expect(roundTrip({ output: 378 })).toEqual({
            name: "calc",
            response: { output: "378" },
            id: "call_math",
        });
        // A string under the output key whose text is a JSON object also
        // raises to that text, and lowering parses the text as the response
        // object, so the wrapper is removed here too.
        expect(roundTrip({ output: '{"a":1}' })).toEqual({
            name: "calc",
            response: { a: 1 },
            id: "call_math",
        });
        // Whitespace around an object does not change this: JSON.parse reads
        // the object the same way, and main wrote the same response.
        expect(roundTrip({ output: ' {"a":1} ' })).toEqual({
            name: "calc",
            response: { a: 1 },
            id: "call_math",
        });
    });

    test("tool result text that is not a JSON object keeps its exact characters", () => {
        const results = [
            "361",
            "12345678901234567890",
            "1.10",
            "-0",
            "1e400",
            "",
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

    test("a functionResponse part_meta lowers to the same part when another op sits between it and its tool result", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
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

        // The part_meta names its llm.tool_result by id under `of`, so a
        // transform that moves an op between the two, or reorders them,
        // does not change the lowered part.
        const program = GeminiTranslator.fromBody(body);
        const modelOp = program.find((op) => op.op === "llm.model")!;
        const resultOp = program.find((op) => op.op === "llm.tool_result")!;
        const metaOp = program.find((op) => op.op === "gemini.part_meta")!;
        const textOp = {
            op: "llm.text",
            role: "user",
            content: "thanks",
        };
        const withTextBetween = [modelOp, resultOp, textOp, metaOp];
        const loweredBetween = GeminiTranslator.toBody(withTextBetween) as {
            contents: { role: string; parts: unknown[] }[];
        };
        expect(loweredBetween.contents).toEqual([
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
                    { text: "thanks" },
                ],
            },
        ]);

        const metaBeforeResult = [modelOp, metaOp, resultOp];
        const loweredBefore = GeminiTranslator.toBody(metaBeforeResult) as {
            contents: { role: string; parts: unknown[] }[];
        };
        expect(loweredBefore.contents).toEqual([
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
        ]);
    });

    test("two calls that reuse one id each keep their own functionResponse name and response", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                { role: "user", parts: [{ text: "run both" }] },
                {
                    role: "model",
                    parts: [
                        { functionCall: { name: "f", args: {}, id: "c1" } },
                        { functionCall: { name: "g", args: {}, id: "c1" } },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "f",
                                response: { a: 1 },
                                id: "c1",
                            },
                        },
                        {
                            functionResponse: {
                                name: "g",
                                response: { b: 2 },
                                id: "c1",
                            },
                        },
                    ],
                },
            ],
        };

        // Each functionResponse part_meta names the nearest earlier result
        // with its id, so one shared id cannot make the last call's name
        // serve both parts.
        const program = GeminiTranslator.fromBody(body);
        const lowered = GeminiTranslator.toBody(program) as typeof body;
        const expected = [
            {
                functionResponse: { name: "f", response: { a: 1 }, id: "c1" },
            },
            {
                functionResponse: { name: "g", response: { b: 2 }, id: "c1" },
            },
        ];
        expect(lowered.contents[2]!.parts).toEqual(expected);

        // The first part_meta moved before the first result binds to the
        // nearest later result of its id, so both parts keep their own
        // names.
        const modelOp = program.find((op) => op.op === "llm.model")!;
        const metas = program.filter((op) => op.op === "gemini.part_meta");
        const results = program.filter((op) => op.op === "llm.tool_result");
        const textOp = program.find((op) => op.op === "llm.text")!;
        const callOps = program.filter((op) => op.op === "llm.tool_call");
        const moved = GeminiTranslator.toBody([
            modelOp,
            textOp,
            ...callOps,
            metas[0]!,
            results[0]!,
            results[1]!,
            metas[1]!,
        ]) as typeof body;
        expect(moved.contents[2]!.parts).toEqual(expected);
    });

    test("a functionResponse part_meta whose `of` names no tool result is removed, and the body still lowers", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "cut history" },
                        {
                            thoughtSignature: "sig",
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

        // A transform that cuts old turns out of a history leaves the op
        // with no result; it holds only the name of a part that no longer
        // exists, so lowering removes it instead of throwing.
        const program = GeminiTranslator.fromBody(body);
        const kept = program.filter((op) => op.op !== "llm.tool_result");
        const lowered = GeminiTranslator.toBody(kept) as typeof body;
        expect(lowered.contents).toEqual([
            { role: "user", parts: [{ text: "cut history" }] },
        ]);
    });

    test("two functionResponse parts with different ids keep their own names", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "get_population",
                                response: { output: "378" },
                                id: "call_pop",
                            },
                        },
                        {
                            functionResponse: {
                                name: "get_weather",
                                response: { temp: 9 },
                                id: "call_weather",
                            },
                        },
                    ],
                },
            ],
        };

        // Each part_meta names its own result under `of`, so lowering cannot
        // take one part's name for the other.
        const program = GeminiTranslator.fromBody(body);
        const lowered = GeminiTranslator.toBody(program) as typeof body;
        const expected = [
            {
                functionResponse: {
                    name: "get_population",
                    response: { output: "378" },
                    id: "call_pop",
                },
            },
            {
                functionResponse: {
                    name: "get_weather",
                    response: { temp: 9 },
                    id: "call_weather",
                },
            },
        ];
        expect(lowered.contents[0]!.parts).toEqual(expected);

        // Both part_metas moved to the end of the program, in reverse order,
        // still lower to the same parts, because each one reads its own
        // `of`.
        const metas = program.filter((op) => op.op === "gemini.part_meta");
        const rest = program.filter((op) => op.op !== "gemini.part_meta");
        const moved = GeminiTranslator.toBody([
            ...rest,
            metas[1]!,
            metas[0]!,
        ]) as {
            contents: { role: string; parts: unknown[] }[];
        };
        expect(moved.contents[0]!.parts).toEqual(expected);
    });

    test("a functionResponse part_meta name wins over the llm.tool_call name", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "model",
                    parts: [
                        {
                            functionCall: {
                                name: "get_weather",
                                args: {},
                                id: "c1",
                            },
                        },
                    ],
                },
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "get_population",
                                response: { output: "378" },
                                id: "c1",
                            },
                        },
                    ],
                },
            ],
        };

        // A transform may rewrite the call's name after the answer was
        // recorded; the part_meta's name is the one the part carries, so it
        // wins over the llm.tool_call name for the same id.
        const program = GeminiTranslator.fromBody(body);
        const lowered = GeminiTranslator.toBody(program) as typeof body;
        expect(lowered.contents[1]!.parts).toEqual([
            {
                functionResponse: {
                    name: "get_population",
                    response: { output: "378" },
                    id: "c1",
                },
            },
        ]);
    });

    test("the later of two functionResponse part_metas bound to one result wins", () => {
        const body = {
            model: "models/gemini-3.5-flash",
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            functionResponse: {
                                name: "get_population",
                                response: { output: "378" },
                                id: "call_pop",
                            },
                        },
                    ],
                },
            ],
        };

        // A transform that duplicates the op can leave two part_metas on one
        // result; lowering takes the later one's name instead of throwing.
        const program = GeminiTranslator.fromBody(body);
        const metaOp = program.find((op) => op.op === "gemini.part_meta")!;
        const dup = JSON.parse(JSON.stringify(metaOp));
        dup.part.name = "get_weather";
        const withDup = [...program.filter((op) => op !== metaOp), metaOp, dup];
        const lowered = GeminiTranslator.toBody(withDup) as typeof body;
        expect(lowered.contents[0]!.parts).toEqual([
            {
                functionResponse: {
                    name: "get_weather",
                    response: { output: "378" },
                    id: "call_pop",
                },
            },
        ]);
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
