import { describe, expect, test } from "bun:test";
import {
    AnthropicTranslator,
    GeminiTranslator,
    LintError,
    OpenAIChatTranslator,
    OpenAIRealtimeTranslator,
    OpenAIResponsesTranslator,
    type Program,
    type Translator,
} from "../src/index";

const requestBody = {
    model: "gpt-4o-mini",
    previous_response_id: "resp_earlier",
    input: [
        {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "and tomorrow?" }],
        },
    ],
};

const responseBody = {
    id: "resp_new",
    object: "response",
    created_at: 1783049000,
    status: "completed",
    model: "gpt-4o-mini",
    previous_response_id: "resp_earlier",
    output: [
        {
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "pong", annotations: [] }],
        },
    ],
};

const unsupportedTargets: Translator[] = [
    AnthropicTranslator,
    OpenAIChatTranslator,
    GeminiTranslator,
    OpenAIRealtimeTranslator,
];

describe("previous response requests", () => {
    test("openai_responses raises and writes request.previous_response", () => {
        const program = OpenAIResponsesTranslator.fromBody(requestBody);

        expect(program).toEqual([
            { op: "llm.model", model: "gpt-4o-mini" },
            {
                op: "request.previous_response",
                responseId: "resp_earlier",
            },
            { op: "llm.text", role: "user", content: "and tomorrow?" },
        ]);
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(requestBody);
    });

    test("a null request previous_response_id raises no op and writes no request key", () => {
        const program = OpenAIResponsesTranslator.fromBody({
            ...requestBody,
            previous_response_id: null,
        });

        expect(
            program.some((op) => op.op === "request.previous_response"),
        ).toBe(false);
        expect(
            program.some(
                (op) =>
                    op.op === "openai_responses.body_field" &&
                    op.key === "previous_response_id",
            ),
        ).toBe(false);
        const { previous_response_id: _previous, ...withoutPrevious } =
            requestBody;
        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(
            withoutPrevious,
        );
    });

    for (const target of unsupportedTargets) {
        test(`${target.name} rejects a stored response it cannot retrieve`, () => {
            const program = OpenAIResponsesTranslator.fromBody(requestBody);

            expect(() => target.toBody(program)).toThrow(LintError);
            expect(() => target.toBody(program)).toThrow(
                "request.previous_response",
            );
        });
    }

    test("request lowering drops the response echo instead of continuing from it", () => {
        const program: Program = [
            ...OpenAIResponsesTranslator.fromBody(requestBody),
            { op: "response.previous_response", responseId: "resp_wrong" },
        ];

        expect(OpenAIResponsesTranslator.toBody(program)).toEqual(requestBody);
    });
});

describe("previous response bodies", () => {
    test("openai_responses raises and writes response.previous_response", () => {
        const program = OpenAIResponsesTranslator.fromResponse(responseBody);

        expect(program).toContainEqual({
            op: "response.previous_response",
            responseId: "resp_earlier",
        });
        expect(
            program.some(
                (op) =>
                    op.op === "openai_responses.body_field" &&
                    op.key === "previous_response_id",
            ),
        ).toBe(false);
        expect(OpenAIResponsesTranslator.toResponse(program)).toEqual(
            responseBody,
        );
    });

    test.each(["null", "absent"] as const)(
        "a %s response previous_response_id raises no op and lowers as null",
        (presence) => {
            const body: Record<string, unknown> = { ...responseBody };
            if (presence === "null") body.previous_response_id = null;
            else delete body.previous_response_id;
            const program = OpenAIResponsesTranslator.fromResponse(body);

            expect(
                program.some((op) => op.op === "response.previous_response"),
            ).toBe(false);
            expect(OpenAIResponsesTranslator.toResponse(program)).toEqual({
                ...body,
                previous_response_id: null,
            });
        },
    );

    test("response lowering drops the request op instead of naming its response", () => {
        const program: Program = [
            ...OpenAIResponsesTranslator.fromResponse(responseBody),
            { op: "request.previous_response", responseId: "resp_wrong" },
        ];

        expect(OpenAIResponsesTranslator.toResponse(program)).toEqual(
            responseBody,
        );
    });

    for (const target of unsupportedTargets) {
        test(`${target.name} drops the response echo without dropping the answer`, () => {
            const program =
                OpenAIResponsesTranslator.fromResponse(responseBody);
            const body = target.toResponse(program);

            expect(JSON.stringify(body)).toContain("pong");
            expect(JSON.stringify(body)).not.toContain("resp_earlier");
        });

        test(`${target.name} drops the response echo from a stream event`, () => {
            const events = target.toStreamResponses([
                {
                    op: "response.text_delta",
                    index: 0,
                    role: "assistant",
                    content: "pong",
                },
                {
                    op: "response.previous_response",
                    responseId: "resp_earlier",
                },
            ]);

            expect(events).toHaveLength(1);
            expect(JSON.stringify(events)).toContain("pong");
            expect(JSON.stringify(events)).not.toContain("resp_earlier");
        });
    }
});

describe("previous response terminal stream events", () => {
    for (const type of [
        "response.completed",
        "response.incomplete",
        "response.failed",
    ] as const) {
        test(`${type} raises and writes the nested response echo`, () => {
            const status =
                type === "response.completed"
                    ? "completed"
                    : type === "response.incomplete"
                      ? "incomplete"
                      : "failed";
            const event = {
                type,
                response: {
                    status,
                    ...(status === "incomplete"
                        ? {
                              incomplete_details: {
                                  reason: "max_output_tokens",
                              },
                          }
                        : {}),
                    previous_response_id: "resp_earlier",
                },
            };
            const program = OpenAIResponsesTranslator.fromStreamResponse(event);

            expect(program).toContainEqual({
                op: "response.previous_response",
                responseId: "resp_earlier",
            });
            const residual = program.find(
                (op) =>
                    op.op === "openai_responses.body_field" &&
                    op.key === "response",
            );
            expect(residual).toBeDefined();
            expect(JSON.stringify(residual)).not.toContain(
                "previous_response_id",
            );
            expect(OpenAIResponsesTranslator.toStreamResponse(program)).toEqual(
                event,
            );

            const nullProgram = OpenAIResponsesTranslator.fromStreamResponse({
                ...event,
                response: {
                    ...event.response,
                    previous_response_id: null,
                },
            });
            expect(
                nullProgram.some(
                    (op) => op.op === "response.previous_response",
                ),
            ).toBe(false);
            expect(
                OpenAIResponsesTranslator.toStreamResponse(nullProgram),
            ).toEqual({
                ...event,
                response: {
                    ...event.response,
                    previous_response_id: null,
                },
            });

            const { previous_response_id: _previous, ...withoutPrevious } =
                event.response;
            const absentProgram = OpenAIResponsesTranslator.fromStreamResponse({
                ...event,
                response: withoutPrevious,
            });
            expect(
                OpenAIResponsesTranslator.toStreamResponse(absentProgram),
            ).toEqual({
                ...event,
                response: {
                    ...withoutPrevious,
                    previous_response_id: null,
                },
            });
        });
    }

    test("a delta and response echo lower to separate delta and terminal events", () => {
        const events = OpenAIResponsesTranslator.toStreamResponses([
            {
                op: "response.text_delta",
                index: 0,
                role: "assistant",
                content: "pong",
            },
            {
                op: "response.previous_response",
                responseId: "resp_earlier",
            },
        ]);

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            type: "response.output_text.delta",
            delta: "pong",
        });
        expect(events[1]).toEqual({
            type: "response.completed",
            response: {
                status: "completed",
                previous_response_id: "resp_earlier",
            },
        });
    });
});
