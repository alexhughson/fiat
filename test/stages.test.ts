// Executable documentation for the extension mechanism: raise/lower are
// pipelines over exported Stage arrays, and stagePipeline reads its array on
// every call — so pushing (or unshifting) a stage after import extends a
// dialect without touching its source.

import { describe, expect, test } from "bun:test";
import {
    stagePipeline,
    AnthropicTranslator,
    type Op,
    type Program,
    type Stage,
} from "../src/index";
import { lowerRequestStages } from "../src/dialects/anthropic_messages";

describe("stagePipeline", () => {
    test("stages compose left to right and unmatched ops pass through", () => {
        const double: Stage = (program) =>
            program.flatMap((op) =>
                op.op === "test.n"
                    ? [{ ...op, value: (op.value as number) * 2 }]
                    : [op],
            );
        const toText: Stage = (program) =>
            program.flatMap((op) =>
                op.op === "test.n"
                    ? [
                          {
                              op: "llm.text",
                              role: "user",
                              content: String(op.value),
                          } as Op,
                      ]
                    : [op],
            );

        const pipeline = stagePipeline([double, toText]);
        expect(
            pipeline([
                { op: "test.n", value: 21 },
                { op: "llm.model", model: "m" },
            ]),
        ).toEqual([
            { op: "llm.text", role: "user", content: "42" },
            { op: "llm.model", model: "m" },
        ]);
    });

    test("the stage array is read per call, so appending after construction takes effect", () => {
        const stages: Stage[] = [];
        const pipeline = stagePipeline(stages);
        const program: Program = [{ op: "test.x" }];

        expect(pipeline(program)).toEqual([{ op: "test.x" }]);
        stages.push((p) => p.filter((op) => op.op !== "test.x"));
        expect(pipeline(program)).toEqual([]);
    });
});

describe("extending a dialect by adding a stage", () => {
    // anthropic_messages has a native structured-output field. A proxy that
    // wants the classic workaround — rewrite llm.output into a forced tool —
    // hooks in one stage. It must run before the native lowering stage, so it
    // goes on the front of the array.
    const outputAsForcedTool: Stage = (program) =>
        program.flatMap((op) => {
            if (op.op !== "llm.output") return [op];
            return [
                {
                    op: "llm.tool",
                    name: op.name as string,
                    inputSchema: op.schema as Record<string, unknown>,
                },
                { op: "llm.tool_choice", value: { name: op.name as string } },
            ] as Op[];
        });

    const request: Program = [
        { op: "llm.model", model: "claude-haiku-4-5" },
        { op: "llm.max_output_tokens", value: 100 },
        {
            op: "llm.output",
            format: "json_schema",
            name: "verdict",
            schema: { type: "object" },
        },
        { op: "llm.text", role: "user", content: "Is water wet?" },
    ];

    test("without the stage, llm.output lowers to native output_config.format", () => {
        expect(AnthropicTranslator.toBody(request)).toMatchObject({
            output_config: {
                format: {
                    type: "json_schema",
                    schema: { type: "object" },
                },
            },
        });
    });

    test("with the stage installed, llm.output lowers as a forced tool", () => {
        lowerRequestStages.unshift(outputAsForcedTool);
        try {
            const body = AnthropicTranslator.toBody(request) as Record<
                string,
                unknown
            >;
            expect(body.tools).toEqual([
                { name: "verdict", input_schema: { type: "object" } },
            ]);
            expect(body.tool_choice).toEqual({ type: "tool", name: "verdict" });
        } finally {
            lowerRequestStages.shift();
        }
    });
});
