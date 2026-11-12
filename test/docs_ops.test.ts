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

// A page under docs/ops documents one op. Each "## Example" section of
// docs/ops/response.model.md holds four json blocks from one run: In, Raised,
// Lower, and Out. The label above each block names the function that returns
// the block. These tests rerun the named functions and compare the blocks as
// text, so that a changed value, a changed key order, and a label that names
// another translator all fail.
const translators: Record<string, Translator> = {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
};

const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");

// The docs print every body and program with JSON.stringify(_, null, 4).
const printed = (value: unknown) => JSON.stringify(value, null, 4);

type Section = {
    heading: string;
    labels: string[];
    blocks: string[];
};

function sectionsOf(page: string): Section[] {
    const sections = read(`../docs/ops/${page}`).split(/^## /m);
    return sections.slice(1).map((section) => ({
        heading: section.slice(0, section.indexOf("\n")),
        labels: [...section.matchAll(/^\*\*.*?(?=\n\n```json\n)/gms)].map(
            (label) => label[0],
        ),
        blocks: [...section.matchAll(/```json\n(.*?)\n```/gs)].map(
            (block) => block[1]!,
        ),
    }));
}

// The translator that a label names as the owner of `method`.
function translatorIn(label: string, method: string): Translator {
    const name = new RegExp(`\`(\\w+)\\.${method}\``).exec(label)?.[1];
    const translator = name ? translators[name] : undefined;
    if (!translator)
        throw new Error(`no translator for ${method} in label: ${label}`);
    return translator;
}

const sections = sectionsOf("response.model.md");
const examples = sections.filter(({ heading }) =>
    heading.startsWith("Example"),
);
const nextRequest = sections.find(
    ({ heading }) => heading === "The next request",
);

test("docs/ops/response.model.md has two examples and the next request", () => {
    expect(examples.map((example) => example.blocks.length)).toEqual([4, 4]);
    expect(examples.map((example) => example.labels.length)).toEqual([4, 4]);
    expect(nextRequest?.blocks.length).toBe(2);
    expect(nextRequest?.labels.length).toBe(2);
});

for (const { heading, labels, blocks } of examples) {
    test(`docs/ops/response.model.md ${heading}: every block is what its label says`, () => {
        const [inLabel, raisedLabel, lowerLabel, outLabel] = labels;
        const [body, raised, lower, out] = blocks;
        expect(inLabel).toStartWith("**In**");
        expect(raisedLabel).toStartWith("**Raised**");
        expect(lowerLabel).toStartWith("**Lower**");
        expect(outLabel).toStartWith("**Out**");
        const source = translatorIn(raisedLabel!, "fromResponse");
        const target = translatorIn(lowerLabel!, "toResponse");
        expect(translatorIn(outLabel!, "toResponse")).toBe(target);

        // Raised: what the source translator raises from the In body.
        const raisedProgram = source.fromResponse(JSON.parse(body!));
        expect(printed(raisedProgram)).toBe(raised!);

        // In: the page shows the body in the key order of the provider's
        // API. The source translator writes the same keys and values back,
        // in its own key order.
        expect(source.toResponse(raisedProgram)).toEqual(JSON.parse(body!));

        // Lower and Out: one call of toResponse on the Raised block.
        // afterLower is the option of toResponse that receives the program
        // its lower step returns.
        let lowerProgram: Program | undefined;
        const outBody = target.toResponse(JSON.parse(raised!), {
            afterLower: (program) => {
                lowerProgram = program;
                return program;
            },
        });
        expect(printed(lowerProgram)).toBe(lower!);
        expect(printed(outBody)).toBe(out!);

        // The Lower label says how many ops of the source dialect
        // dropForeignResiduals removes, and that fiat writes the Out body
        // from the ops that are left.
        const kept = dropForeignResiduals(JSON.parse(lower!), target.name);
        const count = { two: 2, three: 3 }[
            /removes the (\w+) `(\w+)\.\*` ops/.exec(lowerLabel!)?.[1] ?? ""
        ];
        expect(lowerProgram!.length - kept.length).toBe(count!);
        expect(lowerLabel).toContain(`\`${source.name}.*\``);
        expect(printed(target.dialect.response.toWire(kept))).toBe(out!);
    });
}

test("docs/ops/response.model.md The next request: every block is what its label says", () => {
    const [inLabel, outLabel] = nextRequest!.labels;
    const [program, out] = nextRequest!.blocks;
    expect(inLabel).toStartWith("**In**");
    expect(outLabel).toStartWith("**Out**");
    const translator = translatorIn(inLabel!, "toBody");
    expect(translatorIn(inLabel!, "fromBody")).toBe(translator);
    expect(translatorIn(outLabel!, "toBody")).toBe(translator);

    // In: the ops raised from the first request body, the Raised program of
    // Example 1, and one llm.text op.
    const requestOps = translator.fromBody({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
    });
    const responseOps = JSON.parse(examples[0]!.blocks[1]!) as Program;
    expect(printed(JSON.parse(program!).slice(0, -1))).toBe(
        printed([...requestOps, ...responseOps]),
    );
    expect(JSON.parse(program!).at(-1).op).toBe("llm.text");

    expect(printed(translator.toBody(JSON.parse(program!)))).toBe(out!);
    // The page says the request body asks for the model in llm.model.
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
