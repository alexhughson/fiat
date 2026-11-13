import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    type Program,
    type Translator,
} from "../src/index";

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
        blocks: [...section.matchAll(/```json\n(.*?)\n```/gs)].map(
            (block) => block[1]!,
        ),
    }));
}

const examples = examplesOf("llm.text.md");

test("docs/ops/llm.text.md has two examples of four json blocks", () => {
    expect(examples.map((example) => example.blocks.length)).toEqual([4, 4]);
});

for (const [index, { heading, blocks }] of examples.entries()) {
    test(`docs/ops/llm.text.md ${heading}: every json block matches the run`, () => {
        const run = runs[index];
        expect(run).toBeDefined();
        const { source, target } = run!;
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
