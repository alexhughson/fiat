import { describe, expect, test } from "bun:test";
import { parseSseData } from "../../src/client/sse";

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

async function collectSse(
    response: Response,
    signal?: AbortSignal,
): Promise<string[]> {
    const events: string[] = [];
    for await (const event of parseSseData(response, signal)) {
        events.push(event);
    }
    return events;
}

describe("parseSseData", () => {
    test("parses single-line data events", async () => {
        const events = await collectSse(
            sseResponse(["data: {\"a\":1}\n\n", "data: [DONE]\n\n"]),
        );
        expect(events).toEqual(['{"a":1}', "[DONE]"]);
    });

    test("parses JSON event split mid-value across chunks", async () => {
        const events = await collectSse(
            sseResponse(['data: {"a":', "1}\n\n"]),
        );
        expect(events).toEqual(['{"a":1}']);
    });

    test("parses text payload split mid-word across chunks", async () => {
        const events = await collectSse(sseResponse(["data: hel", "lo\n\n"]));
        expect(events).toEqual(["hello"]);
    });

    test("joins multi-line data events", async () => {
        const events = await collectSse(
            sseResponse(["data: line1\ndata: line2\n\n"]),
        );
        expect(events).toEqual(["line1\nline2"]);
    });

    test("skips events without data lines", async () => {
        const events = await collectSse(
            sseResponse(["event: ping\n\n", "data: ok\n\n"]),
        );
        expect(events).toEqual(["ok"]);
    });

    test("handles CRLF delimiters", async () => {
        const events = await collectSse(
            sseResponse(["data: one\r\n\r\ndata: two\r\n\r\n"]),
        );
        expect(events).toEqual(["one", "two"]);
    });

    test("flushes trailing buffer without final delimiter", async () => {
        const events = await collectSse(sseResponse(["data: tail"]));
        expect(events).toEqual(["tail"]);
    });

    test("throws when response body is empty", async () => {
        const response = new Response(null, { status: 200 });
        await expect(collectSse(response)).rejects.toThrow(
            "empty streaming response body",
        );
    });

    test("aborts mid-stream via signal", async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            async start(streamController) {
                streamController.enqueue(
                    encoder.encode("data: first\n\n"),
                );
                controller.abort();
                await new Promise((resolve) => setTimeout(resolve, 0));
                streamController.enqueue(
                    encoder.encode("data: second\n\n"),
                );
                streamController.close();
            },
        });
        const response = new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        });

        const pending = collectSse(response, controller.signal);
        await expect(pending).rejects.toThrow("Request was aborted");
    });
});
