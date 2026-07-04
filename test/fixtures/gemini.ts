export const geminiModelFixture = "models/gemini-3.5-flash";
export const geminiWeatherToolName = "get_weather";

export const geminiRequestFixture = {
    model: geminiModelFixture,
    systemInstruction: { parts: [{ text: "Reply tersely." }] },
    generationConfig: {
        maxOutputTokens: 80,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
    },
    contents: [
        {
            role: "user",
            parts: [{ text: "What's the weather in Paris?" }],
        },
        {
            role: "model",
            parts: [
                {
                    functionCall: {
                        name: geminiWeatherToolName,
                        args: { city: "Paris" },
                        id: "call_1",
                    },
                },
            ],
        },
        {
            role: "user",
            parts: [
                {
                    functionResponse: {
                        name: geminiWeatherToolName,
                        response: { temp_c: 21 },
                        id: "call_1",
                    },
                },
            ],
        },
    ],
    tools: [
        {
            functionDeclarations: [
                {
                    name: geminiWeatherToolName,
                    description: "Get the current weather for a city.",
                    parameters: {
                        type: "object",
                        properties: { city: { type: "string" } },
                        required: ["city"],
                    },
                },
            ],
        },
    ],
    toolConfig: {
        functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: [geminiWeatherToolName],
        },
    },
} as const;

export const geminiTextResponseFixture = {
    model: geminiModelFixture,
    candidates: [
        {
            content: {
                role: "model",
                parts: [{ text: "pong", thoughtSignature: "thought_sig_1" }],
            },
            finishReason: "STOP",
            safetyRatings: [
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    probability: "NEGLIGIBLE",
                },
            ],
        },
    ],
    usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 2,
        totalTokenCount: 14,
        thoughtsTokenCount: 1,
        serviceTier: "default",
    },
    responseId: "resp_123",
} as const;

export const geminiFunctionCallResponseFixture = {
    model: geminiModelFixture,
    candidates: [
        {
            content: {
                role: "model",
                parts: [
                    {
                        functionCall: {
                            name: geminiWeatherToolName,
                            args: { city: "Paris" },
                            id: "call_1",
                        },
                        thoughtSignature: "sig",
                    },
                ],
            },
            finishReason: "STOP",
        },
    ],
    usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
    },
} as const;

export function assertGeminiTextResponseShape(
    value: unknown,
    what = "gemini text response",
): void {
    const body = responseEnvelope(value, what);
    const candidate = singleCandidate(body, what);
    const content = responseContent(candidate, what);
    const parts = array(content.parts, `${what}.candidates[0].content.parts`);
    if (
        !parts.some(
            (part) => typeof record(part, `${what}.part`).text === "string",
        )
    ) {
        throw new Error(`${what}: expected a text part`);
    }
    assertFinishReason(candidate, what);
}

export function assertGeminiFunctionCallResponseShape(
    value: unknown,
    expectedToolName = geminiWeatherToolName,
    what = "gemini function-call response",
): void {
    const body = responseEnvelope(value, what);
    const candidate = singleCandidate(body, what);
    const content = responseContent(candidate, what);
    const parts = array(content.parts, `${what}.candidates[0].content.parts`);
    const callPart = parts.find(
        (part) => record(part, `${what}.part`).functionCall != null,
    );
    if (!callPart) throw new Error(`${what}: expected a functionCall part`);
    const call = record(
        record(callPart, `${what}.functionCall part`).functionCall,
        `${what}.functionCall`,
    );
    const name = string(call.name, `${what}.functionCall.name`);
    if (name !== expectedToolName) {
        throw new Error(
            `${what}: expected functionCall.name ${JSON.stringify(expectedToolName)}, got ${JSON.stringify(name)}`,
        );
    }
    record(call.args, `${what}.functionCall.args`);
    if (call.id != null) string(call.id, `${what}.functionCall.id`);
    assertFinishReason(candidate, what);
}

function responseEnvelope(
    value: unknown,
    what: string,
): Record<string, unknown> {
    const body = record(value, what);
    if (body.model != null) string(body.model, `${what}.model`);
    array(body.candidates, `${what}.candidates`);
    usageMetadata(body.usageMetadata, `${what}.usageMetadata`);
    if (body.responseId != null) string(body.responseId, `${what}.responseId`);
    if (body.modelVersion != null)
        string(body.modelVersion, `${what}.modelVersion`);
    return body;
}

function singleCandidate(
    body: Record<string, unknown>,
    what: string,
): Record<string, unknown> {
    const candidates = array(body.candidates, `${what}.candidates`);
    if (candidates.length !== 1) {
        throw new Error(
            `${what}: expected exactly 1 candidate, got ${candidates.length}`,
        );
    }
    return record(candidates[0], `${what}.candidates[0]`);
}

function responseContent(
    candidate: Record<string, unknown>,
    what: string,
): Record<string, unknown> {
    const content = record(candidate.content, `${what}.candidates[0].content`);
    const role = string(content.role, `${what}.candidates[0].content.role`);
    if (role !== "model") {
        throw new Error(
            `${what}: expected content.role "model", got ${JSON.stringify(role)}`,
        );
    }
    return content;
}

function assertFinishReason(
    candidate: Record<string, unknown>,
    what: string,
): void {
    string(candidate.finishReason, `${what}.candidates[0].finishReason`);
}

function usageMetadata(value: unknown, what: string): void {
    const usage = record(value, what);
    number(usage.promptTokenCount, `${what}.promptTokenCount`);
    number(usage.candidatesTokenCount, `${what}.candidatesTokenCount`);
    number(usage.totalTokenCount, `${what}.totalTokenCount`);
}

function record(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${what}: expected object`);
    }
    return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${what}: expected array`);
    return value;
}

function string(value: unknown, what: string): string {
    if (typeof value !== "string") throw new Error(`${what}: expected string`);
    return value;
}

function number(value: unknown, what: string): number {
    if (typeof value !== "number") throw new Error(`${what}: expected number`);
    return value;
}
