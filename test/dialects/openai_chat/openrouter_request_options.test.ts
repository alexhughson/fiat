import { describe, expect, test } from "bun:test";
import { LintError, OpenAIChatTranslator } from "../../../src/index";

const baseProgram = [
    { op: "llm.model" as const, model: "google/gemini-3.1-flash-lite" },
    { op: "llm.text" as const, role: "user" as const, content: "hi" },
    { op: "request.stream" as const, value: true },
];

describe("openai_chat OpenRouter request options", () => {
    test("adds priority service tier and reasoning for Gemini 3 models", () => {
        expect(
            OpenAIChatTranslator.toBody([
                ...baseProgram,
                { op: "llm.thinking", effort: "medium" },
                { op: "llm.service_tier", value: "priority" },
            ]),
        ).toEqual({
            model: "google/gemini-3.1-flash-lite",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "medium", exclude: true },
            service_tier: "priority",
        });
    });

    test("turns OpenRouter OpenAI-style reasoning off explicitly", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "openai/gpt-5.4-mini" },
                { op: "llm.text", role: "user", content: "hi" },
                { op: "request.stream", value: true },
            ]),
        ).toEqual({
            model: "openai/gpt-5.4-mini",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "none", exclude: true },
        });
    });

    test("uses Gemini minimal as the lowest OpenRouter reasoning level", () => {
        expect(
            OpenAIChatTranslator.toBody([
                {
                    op: "llm.model",
                    model: "google/gemini-3.5-flash",
                },
                { op: "llm.text", role: "user", content: "hi" },
                { op: "request.stream", value: true },
                { op: "llm.service_tier", value: "priority" },
            ]),
        ).toEqual({
            model: "google/gemini-3.5-flash",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "minimal", exclude: true },
            service_tier: "priority",
        });
    });

    test("maps resolved xhigh thinking effort for Gemini models", () => {
        expect(
            OpenAIChatTranslator.toBody([
                {
                    op: "llm.model",
                    model: "google/gemini-3.1-pro-preview",
                },
                { op: "llm.thinking", effort: "high" },
                { op: "llm.text", role: "user", content: "hi" },
                { op: "request.stream", value: true },
            ]),
        ).toEqual({
            model: "google/gemini-3.1-pro-preview",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "high", exclude: true },
        });
    });

    test("leaves non-reasoning OpenRouter model payloads unchanged without priority", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "meta-llama/llama-4.1" },
                { op: "llm.text", role: "user", content: "hi" },
                { op: "request.stream", value: true },
            ]),
        ).toEqual({
            model: "meta-llama/llama-4.1",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        });
    });

    test("rejects priority service tier for unsupported OpenRouter model families", () => {
        expect(() =>
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "meta-llama/llama-4.1" },
                { op: "llm.thinking", effort: "medium" },
                { op: "llm.service_tier", value: "priority" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toThrow("OpenRouter anthropic/, google/, openai/ model IDs");
    });

    test("rejects priority service tier for native OpenAI chat models", () => {
        expect(() =>
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "gpt-4o" },
                { op: "llm.service_tier", value: "priority" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toThrow("cannot express service_tier");
    });

    test("OpenRouter reasoning and service tier round-trip through fromBody", () => {
        const body = {
            model: "google/gemini-3.1-flash-lite",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "medium", exclude: true },
            service_tier: "priority",
        };
        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.thinking",
            effort: "medium",
        });
        expect(program).toContainEqual({
            op: "llm.service_tier",
            value: "priority",
        });
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("OpenRouter reasoning off round-trips without llm.thinking", () => {
        const body = {
            model: "openai/gpt-5.4-mini",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "none", exclude: true },
        };
        const program = OpenAIChatTranslator.fromBody(body);
        expect(program.some((op) => op.op === "llm.thinking")).toBe(false);
        expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
    });

    test("xai/grok models use OpenAI-style reasoning off", () => {
        expect(
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "xai/grok-3" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toMatchObject({
            reasoning: { effort: "none", exclude: true },
        });
    });

    test("rejects minimal thinking on OpenAI-style OpenRouter models", () => {
        expect(() =>
            OpenAIChatTranslator.toBody([
                { op: "llm.model", model: "openai/gpt-5.4-mini" },
                { op: "llm.thinking", effort: "minimal" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toThrow('cannot use llm.thinking effort "minimal"');
    });
});

describe("openai_chat service_tier strict failures", () => {
    test("throws LintError for unsupported targets", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "gpt-4o" },
                    { op: "llm.service_tier", value: "priority" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { strict: true },
            ),
        ).toThrow(LintError);
    });
});
