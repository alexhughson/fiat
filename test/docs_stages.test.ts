import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AnthropicTranslator, type Program } from "../src/index";

// Each page under docs/stages shows one input program and one output program
// as its first two json blocks. These tests rerun the code on the page's input
// and compare the result with the page's output.
function exampleOf(page: string): { input: Program; output: Program } {
    const markdown = readFileSync(
        new URL(`../docs/stages/${page}`, import.meta.url),
        "utf8",
    );
    const [input, output] = [...markdown.matchAll(/```json\n(.*?)```/gs)].map(
        (block) => JSON.parse(block[1]!) as Program,
    );
    if (!input || !output)
        throw new Error(`${page} needs an input and an output json block`);
    return { input, output };
}

test("docs/stages/core/dropResponseOps.md shows what dropResponseOps returns", () => {
    const { input, output } = exampleOf("core/dropResponseOps.md");
    // dropResponseOps is not exported. The page's input holds no meta.* op, so
    // dropMetaOps changes nothing and beforeLower receives the return value of
    // dropResponseOps.
    let afterDrop: Program | undefined;
    AnthropicTranslator.toBody(input, {
        beforeLower: (program) => {
            afterDrop = program;
            return program;
        },
    });
    expect(afterDrop).toEqual(output);
});
