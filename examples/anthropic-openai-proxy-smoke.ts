import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const port = Bun.env.PORT == null ? await openPort() : Number(Bun.env.PORT);
const backendModel = Bun.env.OPENAI_BACKEND_MODEL ?? "gpt-5.5";
const logDir = resolve(
    Bun.env.PROXY_LOG_DIR ??
        `examples/output/anthropic-openai-proxy-smoke/${new Date().toISOString().replaceAll(":", "-")}`,
);
const baseUrl = `http://127.0.0.1:${port}`;

await mkdir(logDir, { recursive: true });

const server = Bun.spawn({
    cmd: ["bun", "examples/anthropic-openai-proxy.ts"],
    env: {
        ...Bun.env,
        PORT: String(port),
        OPENAI_BACKEND_MODEL: backendModel,
        PROXY_LOG_DIR: logDir,
    },
    stdout: "pipe",
    stderr: "pipe",
});

const stdout = collect("server.stdout", server.stdout);
const stderr = collect("server.stderr", server.stderr);

try {
    await waitForHealth();
    const raw = await rawAnthropicCall();
    await save("raw-anthropic-response.json", raw);
    const stream = await rawAnthropicStreamCall();
    await save("raw-anthropic-stream-response.json", stream);
    const claude = await runClaudeCode();
    await save("claude-code-result.json", claude);
    console.log(
        JSON.stringify({
            ok: true,
            baseUrl,
            backendModel,
            logDir,
            rawText: textFromAnthropic(raw),
            streamEvents: stream.events.map((event) => event.type),
            claudeExitCode: claude.exitCode,
        }),
    );
} finally {
    server.kill();
    await server.exited;
    await writeFile(join(logDir, "server.stdout.log"), await stdout);
    await writeFile(join(logDir, "server.stderr.log"), await stderr);
}

async function waitForHealth(): Promise<void> {
    const deadline = Date.now() + 15_000;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
            lastError = `${response.status} ${await response.text()}`;
        } catch (error) {
            lastError =
                error instanceof Error ? error.message : JSON.stringify(error);
        }
        await Bun.sleep(250);
    }
    throw new Error(`proxy did not become healthy: ${lastError}`);
}

async function rawAnthropicCall(): Promise<Record<string, unknown>> {
    const body = {
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        stream: false,
        system: "answer in one short sentence.",
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "say proxy-ok" }],
            },
        ],
    };
    const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": "local-proxy-key",
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `raw Anthropic call failed ${response.status}: ${text}`,
        );
    }
    return JSON.parse(text) as Record<string, unknown>;
}

async function rawAnthropicStreamCall(): Promise<StreamResult> {
    const body = {
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        stream: true,
        system: "answer in one short sentence.",
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: "say stream-proxy-ok" }],
            },
        ],
    };
    const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": "local-proxy-key",
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `raw Anthropic stream call failed ${response.status}: ${text}`,
        );
    }
    const events = parseSseEvents(text);
    if (events.at(0)?.type !== "message_start") {
        throw new Error(`stream did not start with message_start: ${text}`);
    }
    if (events.at(-1)?.type !== "message_stop") {
        throw new Error(`stream did not end with message_stop: ${text}`);
    }
    if (
        !events.some(
            (event) =>
                event.type === "content_block_delta" &&
                record(event.delta, "stream delta").type === "text_delta",
        )
    ) {
        throw new Error(`stream did not include a text delta: ${text}`);
    }
    return { text, events };
}

async function runClaudeCode(): Promise<ClaudeResult> {
    const proc = Bun.spawn({
        cmd: [
            "claude",
            "--bare",
            "-p",
            "using no tools, reply with exactly: claude-proxy-ok",
            "--model",
            "sonnet",
            "--tools",
            "",
            "--output-format",
            "json",
            "--prompt-suggestions",
            "false",
            "--no-session-persistence",
        ],
        env: {
            ...Bun.env,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_API_KEY: "local-proxy-key",
            DISABLE_TELEMETRY: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    const timeout = setTimeout(() => proc.kill(), 120_000);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timeout);
    const result = { exitCode, stdout, stderr };
    if (exitCode !== 0) {
        throw new Error(
            `claude -p failed with ${exitCode}; stdout=${stdout}; stderr=${stderr}`,
        );
    }
    if (!stdout.includes("claude-proxy-ok")) {
        throw new Error(`claude -p output did not include marker: ${stdout}`);
    }
    return result;
}

async function collect(name: string, stream: ReadableStream): Promise<string> {
    try {
        return await new Response(stream).text();
    } catch (error) {
        return `${name} read failed: ${
            error instanceof Error ? error.message : JSON.stringify(error)
        }`;
    }
}

async function save(fileName: string, value: unknown): Promise<void> {
    await writeFile(
        join(logDir, fileName),
        `${JSON.stringify(value, null, 2)}\n`,
    );
}

function textFromAnthropic(body: Record<string, unknown>): string {
    const content = body.content;
    if (!Array.isArray(content)) return "";
    return content
        .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
                ? block.text
                : "",
        )
        .join("");
}

function parseSseEvents(text: string): Record<string, unknown>[] {
    return text
        .split("\n\n")
        .filter((chunk) => chunk.trim() !== "")
        .map((chunk) => {
            const dataLine = chunk
                .split("\n")
                .find((line) => line.startsWith("data: "));
            if (!dataLine) throw new Error(`SSE chunk missing data: ${chunk}`);
            return record(JSON.parse(dataLine.slice("data: ".length)), "SSE");
        });
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${what}: expected object`);
    }
    return value as Record<string, unknown>;
}

interface StreamResult {
    text: string;
    events: Record<string, unknown>[];
}

interface ClaudeResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function openPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error("could not allocate a local port"));
                return;
            }
            const chosen = address.port;
            server.close(() => resolve(chosen));
        });
    });
}
