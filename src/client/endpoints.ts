export const CLIENT_DIALECTS = [
    "openai_chat",
    "openai_responses",
    "gemini",
] as const;

export type ClientDialect = (typeof CLIENT_DIALECTS)[number];

export function isClientDialect(dialect: string): dialect is ClientDialect {
    return (CLIENT_DIALECTS as readonly string[]).includes(dialect);
}

export function joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface EndpointParams {
    dialect: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    stream: boolean;
}

export interface ResolvedEndpoint {
    url: string;
    headers: Record<string, string>;
}

export function resolveEndpoint(params: EndpointParams): ResolvedEndpoint {
    const { dialect, baseUrl, apiKey, model, stream } = params;
    switch (dialect) {
        case "openai_chat":
            return {
                url: joinUrl(baseUrl, "chat/completions"),
                headers: { authorization: `Bearer ${apiKey}` },
            };
        case "openai_responses":
            return {
                url: joinUrl(baseUrl, "responses"),
                headers: { authorization: `Bearer ${apiKey}` },
            };
        case "gemini": {
            const action = stream
                ? "streamGenerateContent"
                : "generateContent";
            const url = new URL(
                joinUrl(baseUrl, `models/${model}:${action}`),
            );
            url.searchParams.set("key", apiKey);
            if (stream) {
                url.searchParams.set("alt", "sse");
            }
            return { url: url.toString(), headers: {} };
        }
        default:
            throw new Error(`client: unsupported dialect "${dialect}"`);
    }
}
