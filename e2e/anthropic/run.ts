import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateArtifact, type ResponseArtifact } from "./shared";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

const model = optionValue(Bun.argv.slice(2), "--model") ?? "claude-sonnet-4-6";
const outDir = resolve(
    optionValue(Bun.argv.slice(2), "--out") ?? "e2e/anthropic/output",
);
const requestBody = thinkingRequest(model);

console.log(`anthropic live e2e model: ${model}`);
console.log(`saving artifacts: ${outDir}`);

const started = Date.now();
const responseBody = await callAnthropic(apiKey, requestBody);
const artifact: ResponseArtifact & {
    requestBody: Record<string, unknown>;
    durationMs: number;
} = {
    scenario: "live-thinking-signature-response",
    kind: "response",
    model,
    requestBody,
    responseBody,
    durationMs: Date.now() - started,
};

const validated = validateArtifact(artifact);
await mkdir(outDir, { recursive: true });
const file = resolve(outDir, "live-thinking-signature-response.json");
await writeFile(`${file}`, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`ok ${validated.scenario} ${model} ${artifact.durationMs}ms`);
for (const check of validated.checks) console.log(`  - ${check}`);
console.log(`saved ${file}`);

function thinkingRequest(model: string): Record<string, unknown> {
    const adaptive =
        /^claude-(?:sonnet-5|sonnet-4-6|opus-4-[678]|fable-5|mythos(?:-5|-preview)?)(?:-|$)/.test(
            model,
        );
    return {
        model,
        max_tokens: 1536,
        thinking: adaptive
            ? { type: "adaptive", display: "omitted" }
            : { type: "enabled", budget_tokens: 1024, display: "omitted" },
        ...(adaptive ? { output_config: { effort: "high" } } : {}),
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Compute 531 * 47. Think carefully, then answer with only the integer.",
                    },
                ],
            },
        ],
    };
}

async function callAnthropic(
    apiKey: string,
    body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `Anthropic API ${response.status} ${response.statusText}: ${text}`,
        );
    }
    return JSON.parse(text) as Record<string, unknown>;
}

function optionValue(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    return value;
}
