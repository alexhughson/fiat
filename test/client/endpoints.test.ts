import { describe, expect, test } from "bun:test";
import { GeminiTranslator } from "../../src/index";
import {
    CLIENT_DIALECTS,
    isClientDialect,
    resolveEndpoint,
} from "../../src/client/endpoints";

describe("resolveEndpoint", () => {
    test("openai_chat uses chat/completions with bearer auth", () => {
        const endpoint = resolveEndpoint({
            dialect: "openai_chat",
            baseUrl: "https://api.openai.com/v1/",
            apiKey: "sk-test",
            model: "gpt-4o",
            stream: true,
        });

        expect(endpoint.url).toBe("https://api.openai.com/v1/chat/completions");
        expect(endpoint.headers).toEqual({
            authorization: "Bearer sk-test",
        });
    });

    test("openai_responses uses /responses with bearer auth", () => {
        const endpoint = resolveEndpoint({
            dialect: "openai_responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            model: "gpt-5",
            stream: false,
        });

        expect(endpoint.url).toBe("https://api.openai.com/v1/responses");
        expect(endpoint.headers.authorization).toBe("Bearer sk-test");
    });

    test("gemini stream URL uses streamGenerateContent, alt=sse, and key query", () => {
        const endpoint = resolveEndpoint({
            dialect: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
            apiKey: "gem-key",
            model: "gemini-2.5-flash",
            stream: true,
        });

        const url = new URL(endpoint.url);
        expect(url.pathname).toBe(
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
        );
        expect(url.searchParams.get("key")).toBe("gem-key");
        expect(url.searchParams.get("alt")).toBe("sse");
        expect(endpoint.headers).toEqual({});
    });

    test("gemini non-stream URL uses generateContent without alt", () => {
        const endpoint = resolveEndpoint({
            dialect: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            apiKey: "gem-key",
            model: "gemini-2.5-flash",
            stream: false,
        });

        const url = new URL(endpoint.url);
        expect(url.pathname).toBe(
            "/v1beta/models/gemini-2.5-flash:generateContent",
        );
        expect(url.searchParams.get("key")).toBe("gem-key");
        expect(url.searchParams.get("alt")).toBeNull();
    });

    test("rejects unsupported dialects", () => {
        expect(() =>
            resolveEndpoint({
                dialect: "anthropic_messages",
                baseUrl: "https://api.anthropic.com/v1",
                apiKey: "key",
                model: "claude",
                stream: false,
            }),
        ).toThrow('unsupported dialect "anthropic_messages"');
    });
});

describe("gemini omitModel via toBody", () => {
    test("client path omits model from body while keeping llm.model in program", () => {
        const program = [
            { op: "llm.model", model: "gemini-2.5-flash" },
            {
                op: "gemini.content",
                content: {
                    role: "user",
                    parts: [{ text: "hi" }],
                },
            },
        ] as const;

        const withModel = GeminiTranslator.toBody(program, { strict: true });
        const withoutModel = GeminiTranslator.toBody(program, {
            strict: true,
            omitModel: true,
        });

        expect((withModel as { model?: string }).model).toBe(
            "gemini-2.5-flash",
        );
        expect((withoutModel as { model?: string }).model).toBeUndefined();
        expect((withoutModel as { contents: unknown[] }).contents).toEqual(
            (withModel as { contents: unknown[] }).contents,
        );
    });

    test("stream client option does not add stream field to gemini body", () => {
        const program = [
            { op: "llm.model", model: "gemini-2.5-flash" },
            {
                op: "gemini.content",
                content: { role: "user", parts: [{ text: "hi" }] },
            },
        ] as const;

        const body = GeminiTranslator.toBody(program, {
            strict: true,
            stream: true,
            omitModel: true,
        }) as Record<string, unknown>;

        expect(body.stream).toBeUndefined();
        expect(body.model).toBeUndefined();
    });
});

describe("client dialect registry", () => {
    test("lists wired dialects and excludes anthropic_messages", () => {
        expect(CLIENT_DIALECTS).toEqual([
            "openai_chat",
            "openai_responses",
            "gemini",
        ]);
        expect(isClientDialect("openai_chat")).toBe(true);
        expect(isClientDialect("anthropic_messages")).toBe(false);
    });
});
