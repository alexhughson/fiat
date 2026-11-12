import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    type Program,
    type Translator,
} from "../src/index";

// A page under docs/ops documents one op. Each "## Example" section of a page
// holds four json blocks from one run: In, Raised, Lower, and Out. The label
// above each block names the function that returns the block. These tests
// rerun the named functions and compare every block as text, so that a changed
// value, a changed key order, and a label that names another translator or
// another proxy all fail.
const translators: Record<string, Translator> = {
    AnthropicTranslator,
    OpenAIChatTranslator,
};

// The word that stands for each translator's API in the name of a proxy. The
// page calls a proxy that receives Chat Completions request bodies and sends
// Anthropic request bodies "the Chat-to-Anthropic proxy".
const apiWords = new Map<Translator, string>([
    [AnthropicTranslator, "Anthropic"],
    [OpenAIChatTranslator, "Chat"],
]);

const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), "utf8");

// The docs print every body and program with JSON.stringify(_, null, 4).
const printed = (value: unknown) => JSON.stringify(value, null, 4);

type Example = {
    heading: string;
    labels: string[];
    blocks: string[];
};

function examplesOf(page: string): Example[] {
    const sections = read(`../docs/ops/${page}`).split(/^## (?=Example)/m);
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

// The proxy that a label names, such as "Chat-to-Anthropic".
const proxyIn = (label: string) =>
    /\bthe\s+(\w+-to-\w+)\s+proxy\b/.exec(label)?.[1];

const examples = examplesOf("llm.text.md");

test("docs/ops/llm.text.md has two examples", () => {
    expect(examples.map((example) => example.blocks.length)).toEqual([4, 4]);
    expect(examples.map((example) => example.labels.length)).toEqual([4, 4]);
});

for (const { heading, labels, blocks } of examples) {
    test(`docs/ops/llm.text.md ${heading}: every block is what its label says`, () => {
        const [inLabel, raisedLabel, lowerLabel, outLabel] = labels;
        const [body, raised, lower, out] = blocks;
        expect(inLabel).toStartWith("**In**");
        expect(raisedLabel).toStartWith("**Raised**");
        expect(lowerLabel).toStartWith("**Lower**");
        expect(outLabel).toStartWith("**Out**");
        const source = translatorIn(raisedLabel!, "fromBody");
        const target = translatorIn(lowerLabel!, "toBody");
        expect(translatorIn(outLabel!, "toBody")).toBe(target);

        // In and Out: each label names the proxy of this example, which
        // receives the source translator's bodies and sends the target's.
        const proxy = `${apiWords.get(source)}-to-${apiWords.get(target)}`;
        expect(proxyIn(inLabel!)).toBe(proxy);
        expect(proxyIn(outLabel!)).toBe(proxy);

        // Raised: what the source translator raises from the In body.
        const raisedProgram = source.fromBody(JSON.parse(body!));
        expect(printed(raisedProgram)).toBe(raised!);

        // In: no function returns the In body, so its key order is held to
        // the order in which the source translator writes the same body back.
        expect(printed(source.toBody(raisedProgram))).toBe(body!);

        // Lower and Out: one call of toBody on the Raised block. afterLower
        // is the option of toBody that receives the program its lower step
        // returns.
        let lowerProgram: Program | undefined;
        const outBody = target.toBody(JSON.parse(raised!), {
            afterLower: (program) => {
                lowerProgram = program;
                return program;
            },
        });
        expect(printed(lowerProgram)).toBe(lower!);
        expect(printed(outBody)).toBe(out!);

        // The page says fiat writes the Out body from the Lower program. That
        // holds only while no later step of toBody changes the program.
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
    // The page writes the alias Role out and puts each param on its own line.
    const params = declared!.replace("Role", role!).split("; ");
    const shown = /```ts\n(.*?)\n```/s.exec(read("../docs/ops/llm.text.md"));
    expect(shown?.[1]).toBe(
        ["{", ...params.map((param) => `    ${param};`), "}"].join("\n"),
    );
});
