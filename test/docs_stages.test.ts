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

test("docs/stages/core/stripHostOps.md shows what stripHostOps returns", () => {
    const { input, output } = exampleOf("core/stripHostOps.md");
    // stripHostOps is not exported. beforeLower receives its return value.
    let afterStrip: Program | undefined;
    AnthropicTranslator.toBody(input, {
        beforeLower: (program) => {
            afterStrip = program;
            return program;
        },
    });
    expect(afterStrip).toEqual(output);
});
