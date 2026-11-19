import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    AnthropicTranslator,
    dropForeignResiduals,
    GeminiTranslator,
    OpenAIChatTranslator,
    type Program,
    type Translator,
} from "../src/index";

// An example of four json blocks (In, Raised, Lower, Out) is one run: a
// request body or a response body goes through the source translator and then
// through the target translator.
type Run = {
    kind: "request" | "response";
    source: Translator;
    target: Translator;
};

// One entry per page under docs/ops: the runs of the page's examples of four
// json blocks, in page order.
const pages: Record<string, Run[]> = {
    "response.model.md": [
        {
            kind: "response",
            source: OpenAIChatTranslator,
            target: AnthropicTranslator,
        },
        {
            kind: "response",
            source: AnthropicTranslator,
            target: GeminiTranslator,
        },
    ],
};

// The two examples on docs/ops/llm.text.md, in page order.
const runs: { source: Translator; target: Translator }[] = [
    { source: OpenAIChatTranslator, target: AnthropicTranslator },
    { source: AnthropicTranslator, target: OpenAIChatTranslator },
];

const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");

// The docs print every body and program with JSON.stringify(_, null, 4).
const printed = (value: unknown) => JSON.stringify(value, null, 4);

type Example = {
    heading: string;
    blocks: string[];
};

function examplesOf(page: string): Example[] {
    const sections = read(`../docs/ops/${page}`).split(/^## (?=Example)/m);
    return sections.slice(1).map((section) => ({
        heading: section.slice(0, section.indexOf("\n")),
        // An example ends where the next heading of the page starts.
        blocks: [
            ...section.split(/^## /m)[0]!.matchAll(/```json\n(.*?)\n```/gs),
        ].map((block) => block[1]!),
    }));
}

for (const [page, runs] of Object.entries(pages)) {
    const examples = examplesOf(page);

    test(`docs/ops/${page} has one example of four json blocks per run`, () => {
        expect(
            examples.slice(0, runs.length).map(({ blocks }) => blocks.length),
        ).toEqual(runs.map(() => 4));
    });

    for (const [index, { kind, source, target }] of runs.entries()) {
        const { heading, blocks } = examples[index]!;
        test(`docs/ops/${page} ${heading}: every json block matches the run`, () => {
            const [body, raised, lower, out] = blocks;
            const raise = (wire: unknown) =>
                kind === "request"
                    ? source.fromBody(wire)
                    : source.fromResponse(wire);

            const raisedProgram = raise(JSON.parse(body!));
            expect(printed(raisedProgram)).toBe(raised!);

            // No function returns the In body, so its key order is held to
            // the order in which the source translator writes the same body
            // back.
            expect(
                printed(
                    kind === "request"
                        ? source.toBody(raisedProgram)
                        : source.toResponse(raisedProgram),
                ),
            ).toBe(body!);

            // afterLower receives the program that the lower step returns.
            let lowerProgram: Program | undefined;
            const opts = {
                afterLower: (program: Program) => {
                    lowerProgram = program;
                    return program;
                },
            };
            const outBody =
                kind === "request"
                    ? target.toBody(JSON.parse(raised!), opts)
                    : target.toResponse(JSON.parse(raised!), opts);
            expect(printed(lowerProgram)).toBe(lower!);
            expect(printed(outBody)).toBe(out!);

            // Out is also what toWire writes from the Lower block, once the
            // ops of another dialect are removed from it.
            expect(
                printed(
                    target.dialect[kind].toWire(
                        dropForeignResiduals(JSON.parse(lower!), target.name),
                    ),
                ),
            ).toBe(out!);
        });
    }
}

test("docs/ops/response.model.md Example 3: every json block matches the run", () => {
    const examples = examplesOf("response.model.md");
    const [raised, lower, out] = examples[2]!.blocks;
    expect(examples[2]!.blocks.length).toBe(3);

    // Raised: the ops raised from the first request, the Raised block of
    // Example 1, and one llm.text op.
    const requestOps = OpenAIChatTranslator.fromBody({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
    });
    const responseOps = JSON.parse(examples[0]!.blocks[1]!) as Program;
    expect(printed(JSON.parse(raised!).slice(0, -1))).toBe(
        printed([...requestOps, ...responseOps]),
    );
    expect(JSON.parse(raised!).at(-1).op).toBe("llm.text");

    let lowerProgram: Program | undefined;
    const outBody = OpenAIChatTranslator.toBody(JSON.parse(raised!), {
        afterLower: (program) => {
            lowerProgram = program;
            return program;
        },
    });
    expect(printed(lowerProgram)).toBe(lower!);
    expect(printed(outBody)).toBe(out!);
    // The page says the request asks for the model in llm.model.
    expect(JSON.parse(out!).model).toBe("gpt-4o");
});

test("docs/ops/response.model.md shows the type of response.model that src/core/ops.ts declares", () => {
    const declared = /^ {4}\| \{ (op: "response\.model"; .*) \}$/m.exec(
        read("../src/core/ops.ts"),
    )?.[1];
    expect(declared).toBeDefined();
    // The page puts each param on its own line.
    const shown = /```ts\n(.*?)\n```/s.exec(
        read("../docs/ops/response.model.md"),
    );
    expect(shown?.[1]).toBe(
        [
            "{",
            ...declared!.split("; ").map((param) => `    ${param};`),
            "}",
        ].join("\n"),
    );
});

const examples = examplesOf("llm.text.md");

test("docs/ops/llm.text.md has two examples of four json blocks", () => {
    expect(examples.map((example) => example.blocks.length)).toEqual([4, 4]);
});

for (const [index, { heading, blocks }] of examples.entries()) {
    test(`docs/ops/llm.text.md ${heading}: every json block matches the run`, () => {
        const { source, target } = runs[index]!;
        const [body, raised, lower, out] = blocks;

        const raisedProgram = source.fromBody(JSON.parse(body!));
        expect(printed(raisedProgram)).toBe(raised!);

        // No function returns the In body, so its key order is held to the
        // order in which the source translator writes the same body back.
        expect(printed(source.toBody(raisedProgram))).toBe(body!);

        // afterLower receives the program that the lower step of toBody returns.
        let lowerProgram: Program | undefined;
        const outBody = target.toBody(JSON.parse(raised!), {
            afterLower: (program) => {
                lowerProgram = program;
                return program;
            },
        });
        expect(printed(lowerProgram)).toBe(lower!);
        expect(printed(outBody)).toBe(out!);

        // Out is also what toWire writes from the Lower block, while no later
        // step of toBody changes the program.
        expect(printed(target.dialect.request.toWire(JSON.parse(lower!)))).toBe(
            out!,
        );
    });
}

test("docs/ops/llm.text.md shows the type of llm.text that src/core/ops.ts declares", () => {
    const source = read("../src/core/ops.ts");
    const role = /^export type Role = (.*);$/m.exec(source)?.[1];
    const declared = /^ {4}\| \{ (op: "llm\.text"; .*) \}$/m.exec(source)?.[1];
    expect(role).toBeDefined();
    expect(declared).toBeDefined();
    // The page writes the alias Role out, puts each param on its own line, and
    // writes an optional param with | null instead of ?.
    const params = declared!
        .replace("Role", role!)
        .split("; ")
        .map((param) => param.replace(/^(\w+)\?: (.*)$/, "$1: $2 | null"));
    const shown = /```ts\n(.*?)\n```/s.exec(read("../docs/ops/llm.text.md"));
    expect(shown?.[1]).toBe(
        ["{", ...params.map((param) => `    ${param};`), "}"].join("\n"),
    );
});

// The two examples on docs/ops/response.usage.md, in page order. Each In
// block is the usage object of a whole response body, so each run rebuilds
// the body around it.
const usageRuns: {
    source: Translator;
    target: Translator;
    body: (usage: unknown) => Record<string, unknown>;
    lowerUsageOp: string;
    out: "usage" | "usageMetadata";
}[] = [
    {
        source: AnthropicTranslator,
        target: OpenAIChatTranslator,
        body: (usage) => ({
            id: "msg_01",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "hi there" }],
            stop_reason: "end_turn",
            usage,
        }),
        lowerUsageOp: "openai_chat.usage",
        out: "usage",
    },
    {
        source: GeminiTranslator,
        target: GeminiTranslator,
        body: (usage) => ({
            responseId: "resp_01",
            model: "gemini-2.5-pro",
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "hi there" }] },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: usage,
        }),
        lowerUsageOp: "gemini.usage",
        out: "usageMetadata",
    },
];

const usageExamples = examplesOf("response.usage.md");

test("docs/ops/response.usage.md has two examples of four json blocks", () => {
    expect(usageExamples.map((example) => example.blocks.length)).toEqual([
        4, 4,
    ]);
});

for (const [index, { heading, blocks }] of usageExamples.entries()) {
    test(`docs/ops/response.usage.md ${heading}: every json block matches the run`, () => {
        const { source, target, body, lowerUsageOp, out } = usageRuns[index]!;
        const [inUsage, raised, lower, outUsage] = blocks;

        const raisedProgram = source.fromResponse(body(JSON.parse(inUsage!)));
        expect(
            printed(raisedProgram.filter((op) => op.op === "response.usage")),
        ).toBe(raised!);

        // The Lower block is the usage op of the lowered program.
        const lowerProgram = target.dialect.response.lower(raisedProgram);
        expect(
            printed(lowerProgram.filter((op) => op.op === lowerUsageOp)),
        ).toBe(lower!);

        const outBody = target.toResponse(raisedProgram) as Record<
            string,
            unknown
        >;
        expect(printed(outBody[out])).toBe(outUsage!);
    });
}

test("docs/ops/response.usage.md shows the type of response.usage that src/core/ops.ts declares", () => {
    const source = read("../src/core/ops.ts");
    const block =
        /\| \{\n( {10}op: "response\.usage";\n(?: {10}\w+\?: number;\n)+) {6}\}/.exec(
            source,
        );
    const params = block?.[1]
        ?.trimEnd()
        .split("\n")
        .map((param) =>
            param
                .replace(/^ {10}/, "")
                .replace(/;$/, "")
                .replace(/^(\w+)\?: (.*)$/, "$1: $2 | null"),
        );
    expect(params).toBeDefined();
    const shown = /```ts\n(.*?)\n```/s.exec(
        read("../docs/ops/response.usage.md"),
    );
    expect(shown?.[1]).toBe(
        ["{", ...params!.map((param) => `    ${param};`), "}"].join("\n"),
    );
});
