export async function* parseSseData(
    response: Response,
    signal?: AbortSignal,
): AsyncGenerator<string> {
    if (response.body === null) {
        throw new Error("Provider returned an empty streaming response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            if (signal?.aborted === true) {
                throw new Error("Request was aborted");
            }
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? "";
            for (const event of events) {
                const data = extractSseEventData(event);
                if (data.length > 0) {
                    yield data;
                }
            }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            const data = extractSseEventData(buffer);
            if (data.length > 0) {
                yield data;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function extractSseEventData(event: string): string {
    return event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
}
