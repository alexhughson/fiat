import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    AnthropicTranslator,
    OpenAIChatTranslator,
    type Program,
} from "../src/index";

// An op's entry in docs/core-ir.md is the section under its heading. These
// tests rerun the code on the json blocks of an entry and compare the results
// with the blocks that follow.
function jsonBlocksOf(heading: string): unknown[] {
    const markdown = readFileSync(
        new URL("../docs/core-ir.md", import.meta.url),
        "utf8",
    );
    const section = markdown.split(/^## /m).find((part) => {
        return part.startsWith(`${heading}\n`);
    });
    if (!section) throw new Error(`docs/core-ir.md has no "## ${heading}"`);
    return [...section.matchAll(/```json\n(.*?)```/gs)].map((block) =>
        JSON.parse(block[1]!),
    );
}

test("docs/core-ir.md Text: the example's program and Anthropic body come from its OpenAI Chat body", () => {
    const blocks = jsonBlocksOf("Text");
    expect(blocks.length).toBe(3);
    const [chatBody, program, anthropicBody] = blocks;
    expect(OpenAIChatTranslator.fromBody(chatBody)).toEqual(program as Program);
    expect(AnthropicTranslator.toBody(program as Program)).toEqual(
        anthropicBody,
    );
});
