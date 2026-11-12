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
    // dropResponseOps is not exported. beforeLower receives its return value.
    // dropMetaOps runs before dropResponseOps, so dropResponseOps receives the
    // page's input only when the input holds no meta.* op.
    expect(input.filter((op) => op.op.startsWith("meta."))).toEqual([]);
    // The page says its input comes from a run: the ops raised from these two
    // bodies, then the page's last op.
    const requestOps = AnthropicTranslator.fromBody({
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
    });
    const responseOps = AnthropicTranslator.fromResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
    });
    expect(input.slice(0, -1)).toEqual([...requestOps, ...responseOps]);
    let afterDrop: Program | undefined;
    AnthropicTranslator.toBody(input, {
        beforeLower: (program) => {
            afterDrop = program;
            return program;
        },
    });
    expect(afterDrop).toEqual(output);
});

test("docs/stages/core/dropResponseOps.md shows the signature of dropResponseOps", () => {
    const read = (path: string) =>
        readFileSync(new URL(path, import.meta.url), "utf8");
    // dropResponseOps is not exported, so the test reads its declaration from
    // the source file as text, up to the opening brace of the body.
    const declared = /^function dropResponseOps\(.*?(?= \{$)/ms.exec(
        read("../src/core/pipeline.ts"),
    )?.[0];
    // The page's first ts block is the signature. Prettier ends it with ";".
    const shown = /```ts\n(.*?)\n```/s.exec(
        read("../docs/stages/core/dropResponseOps.md"),
    )?.[1];
    expect(declared).toBeDefined();
    expect(shown).toBe(`${declared};`);
});
