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
