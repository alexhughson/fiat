import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    AnthropicTranslator,
    GeminiTranslator,
    type Program,
    OpenAIResponsesTranslator,
} from "../src/index";

// Each page under docs/stages shows one input program and one output program
// as its first two json blocks, and the signature of its function as its first
// ts block. One test reruns the code on the page's input and compares the
// result with the page's output. The other test compares the page's signature
// with the declaration in the source file. The stream writer page shows one
// whole stream: its input block is the list of raised chunk programs and its
// output block the list of wire events the writer returned.
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

// The stream writer page shows one whole stream as its two json blocks: the
// input is the list of raised chunk programs, in stream order, and the output
// is the list of wire events the writer returned, in the order the writer
// returned them. The writer invents the message item id once per stream, so
// the run normalizes it to the page's placeholder before comparing.
test("docs/stages/openai_responses/streamWriter.md shows what the stream writer returns", () => {
    const markdown = readFileSync(
        new URL(
            "../docs/stages/openai_responses/streamWriter.md",
            import.meta.url,
        ),
        "utf8",
    );
    const blocks = [...markdown.matchAll(/```json\n(.*?)```/gs)].map((block) =>
        JSON.parse(block[1]!),
    );
    const input = blocks[0] as Program[];
    const output = blocks[1] as Record<string, unknown>[];
    expect(input).toBeDefined();
    expect(output).toBeDefined();

    // The page says its input comes from a run: the ops that
    // GeminiTranslator.fromStreamResponse returns for the three chunks the
    // page describes, in stream order.
    const geminiChunk = (
        parts: unknown[],
        rest: Record<string, unknown> = {},
    ): Record<string, unknown> => {
        const { finishReason, ...body } = rest;
        return {
            candidates: [
                {
                    content: { role: "model", parts },
                    ...(finishReason != null ? { finishReason } : {}),
                    index: 0,
                },
            ],
            ...body,
        };
    };
    const raised = [
        geminiChunk([{ text: "A" }]),
        geminiChunk([{ text: "B" }]),
        geminiChunk([{ text: "" }], {
            finishReason: "STOP",
            responseId: "gemini-response-check",
            modelVersion: "gemini-3.5-flash-lite",
            usageMetadata: {
                promptTokenCount: 13,
                candidatesTokenCount: 2,
                totalTokenCount: 15,
            },
        }),
    ].map((chunk) => GeminiTranslator.fromStreamResponse(chunk));
    expect(input).toEqual(raised);

    const writer = OpenAIResponsesTranslator.streamWriter();
    const events = raised.flatMap((program) => writer.write(program));
    const invented = (events[0] as { item_id: string }).item_id;
    expect(invented).toMatch(/^msg_[0-9a-f]+$/);
    const normalized = JSON.parse(
        JSON.stringify(events).replaceAll(
            invented,
            invented.replace(/^msg_[0-9a-f]+$/, "msg_<invented>"),
        ),
    );
    expect(normalized).toEqual(output);
});

test("docs/stages/openai_responses/streamWriter.md shows the signature of streamWriter", () => {
    const read = (path: string) =>
        readFileSync(new URL(path, import.meta.url), "utf8");
    const tsBlocks = [
        ...read("../docs/stages/openai_responses/streamWriter.md").matchAll(
            /```ts\n(.*?)\n```/gs,
        ),
    ].map((block) => block[1]!);
    expect(tsBlocks).toHaveLength(2);

    // streamWriter is a method of Translator, so the test reads its
    // declaration from the class body.
    const method =
        /(?:^|\n)    (streamWriter\(opts\?: LowerOptions\): StreamWriter) \{/m.exec(
            read("../src/core/translator.ts"),
        )?.[1];
    expect(method).toBeDefined();
    expect(tsBlocks[0]).toBe(`${method};`);

    const iface =
        /(?:^|\n)export (interface StreamWriter \{\n    write\(program: Program\): unknown\[];\n\})/.exec(
            read("../src/core/registry.ts"),
        )?.[1];
    expect(iface).toBeDefined();
    expect(tsBlocks[1]).toBe(iface);
});
