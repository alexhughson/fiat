import { describe, expect, test } from "bun:test";
import {
    GeminiTranslator,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
} from "../src/index";
import { geminiThoughtStreamChunk20261119 } from "./fixtures/gemini-stream-thinking";

const signedThoughtChunk = {
    candidates: [
        {
            content: {
                role: "model",
                parts: [
                    {
                        text: "Check the alternatives first.",
                        thought: true,
                        thoughtSignature: "sig_stream_1",
                    },
                ],
            },
        },
    ],
};

describe("Gemini stream thought parts", () => {
    test("a recorded thought chunk raises to reasoning and round-trips", () => {
        const program = GeminiTranslator.fromStreamResponse(
            geminiThoughtStreamChunk20261119,
        );

        expect(program).toContainEqual({
            op: "response.reasoning_delta",
            index: 0,
            content:
                geminiThoughtStreamChunk20261119.candidates[0]!.content
                    .parts[0]!.text,
        });
        expect(program.some((op) => op.op === "response.text_delta")).toBe(
            false,
        );
        expect(program.some((op) => op.op === "gemini.part_meta")).toBe(false);
        expect(GeminiTranslator.toStreamResponse(program)).toEqual(
            geminiThoughtStreamChunk20261119,
        );
    });

    test("a thought signature raises and lowers on the reasoning delta", () => {
        const program = GeminiTranslator.fromStreamResponse(signedThoughtChunk);

        expect(program).toEqual([
            {
                op: "response.reasoning_delta",
                index: 0,
                content: "Check the alternatives first.",
                signature: { dialect: "gemini", value: "sig_stream_1" },
            },
        ]);
        expect(GeminiTranslator.toStreamResponse(program)).toEqual(
            signedThoughtChunk,
        );
    });

    test("Responses lowering writes reasoning, never answer text", () => {
        const program = GeminiTranslator.fromStreamResponse(signedThoughtChunk);
        const event = OpenAIResponsesTranslator.toStreamResponse(
            program,
        ) as Record<string, unknown>;

        expect(event).toEqual({
            type: "response.reasoning_text.delta",
            item_id: expect.any(String),
            output_index: 0,
            content_index: 0,
            delta: "Check the alternatives first.",
        });
        expect(event.item_id).toStartWith("rs_");
    });

    test("Responses signature dropping becomes an error in strict mode", () => {
        const program = GeminiTranslator.fromStreamResponse(signedThoughtChunk);

        expect(() =>
            OpenAIResponsesTranslator.toStreamResponse(program, {
                strict: true,
            }),
        ).toThrow("response.reasoning_delta.signature");
    });

    test("a thought after an answer keeps output and content indexes distinct", () => {
        const chunk = {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            { text: "Use the second option." },
                            {
                                text: "Check the alternatives first.",
                                thought: true,
                            },
                        ],
                    },
                },
            ],
        };
        const program = GeminiTranslator.fromStreamResponse(chunk);
        const events = OpenAIResponsesTranslator.toStreamResponses(
            program,
        ) as Record<string, unknown>[];
        const reasoning = events.find(
            (event) => event.type === "response.reasoning_text.delta",
        );

        expect(reasoning).toMatchObject({
            output_index: 1,
            content_index: 0,
            delta: "Check the alternatives first.",
        });
    });

    test("Responses lowering rejects a missing output index instead of assuming zero", () => {
        const program = [
            {
                op: "response.reasoning_delta",
                content: "Check the alternatives first.",
            },
        ];

        expect(() =>
            OpenAIResponsesTranslator.toStreamResponse(program),
        ).toThrow("output_index");
    });

    test("a mixed chunk lowers to reasoning, answer, then one terminal event", () => {
        const chunk = {
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            ...signedThoughtChunk.candidates[0]!.content.parts,
                            { text: "Use the second option." },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
        };
        const program = GeminiTranslator.fromStreamResponse(chunk);
        const events = OpenAIResponsesTranslator.toStreamResponses(
            program,
        ) as Record<string, unknown>[];

        expect(events.map((event) => event.type)).toEqual([
            "response.reasoning_text.delta",
            "response.output_text.delta",
            "response.completed",
        ]);
        expect(events[0]!.delta).toBe("Check the alternatives first.");
        expect(events[1]!.delta).toBe("Use the second option.");
        expect(() =>
            OpenAIResponsesTranslator.toStreamResponse(program),
        ).toThrow("toStreamResponses");
    });

    test("targets without reasoning fields warn and omit the delta", () => {
        const program = GeminiTranslator.fromStreamResponse(signedThoughtChunk);

        expect(OpenAIChatTranslator.toStreamResponses(program)).toEqual([]);
        expect(OpenAIRealtimeTranslator.toStreamResponses(program)).toEqual([]);
    });
});
