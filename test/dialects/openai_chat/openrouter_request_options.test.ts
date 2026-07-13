import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { LintError, OpenAIChatTranslator } from "../../../src/index";

const openrouter = { variant: "openrouter" as const };

const baseProgram = [
    { op: "llm.model" as const, model: "google/gemini-3.1-flash-lite" },
    { op: "llm.text" as const, role: "user" as const, content: "hi" },
    { op: "request.stream" as const, value: true },
];

describe("openai_chat OpenRouter request options", () => {
    test("adds priority service tier and reasoning for Gemini 3 models", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    ...baseProgram,
                    { op: "llm.thinking", effort: "medium" },
                    { op: "llm.service_tier", value: "priority" },
                ],
                openrouter,
            ),
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
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "openai/gpt-5.4-mini" },
                    { op: "llm.thinking", effort: "off" },
                    { op: "llm.text", role: "user", content: "hi" },
                    { op: "request.stream", value: true },
                ],
                openrouter,
            ),
        ).toEqual({
            model: "openai/gpt-5.4-mini",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "none", exclude: true },
        });
    });

    test("uses Gemini minimal as the lowest OpenRouter reasoning level", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    {
                        op: "llm.model",
                        model: "google/gemini-3.5-flash",
                    },
                    { op: "llm.thinking", effort: "off" },
                    { op: "llm.text", role: "user", content: "hi" },
                    { op: "request.stream", value: true },
                    { op: "llm.service_tier", value: "priority" },
                ],
                openrouter,
            ),
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
            OpenAIChatTranslator.toBody(
                [
                    {
                        op: "llm.model",
                        model: "google/gemini-3.1-pro-preview",
                    },
                    { op: "llm.thinking", effort: "xhigh" },
                    { op: "llm.text", role: "user", content: "hi" },
                    { op: "request.stream", value: true },
                ],
                openrouter,
            ),
        ).toEqual({
            model: "google/gemini-3.1-pro-preview",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "xhigh", exclude: true },
        });
    });

    test("leaves non-reasoning OpenRouter model payloads unchanged without priority", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "meta-llama/llama-4.1" },
                    { op: "llm.text", role: "user", content: "hi" },
                    { op: "request.stream", value: true },
                ],
                openrouter,
            ),
        ).toEqual({
            model: "meta-llama/llama-4.1",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
        });
    });

    test("does not inject OpenRouter reasoning without variant openrouter", () => {
        expect(
            OpenAIChatTranslator.toBody([
                {
                    op: "llm.model",
                    model: "google/gemini-3.5-flash",
                },
                { op: "llm.thinking", effort: "off" },
                { op: "llm.text", role: "user", content: "hi" },
            ]),
        ).toEqual({
            model: "google/gemini-3.5-flash",
            messages: [{ role: "user", content: "hi" }],
        });
    });

    test("rejects priority service tier for unsupported OpenRouter model families in strict mode", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "meta-llama/llama-4.1" },
                    { op: "llm.thinking", effort: "medium" },
                    { op: "llm.service_tier", value: "priority" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                { ...openrouter, strict: true },
            ),
        ).toThrow("OpenRouter anthropic/, google/, openai/ model IDs");
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
        expect(OpenAIChatTranslator.toBody(program, openrouter)).toEqual(body);
    });

    test("OpenRouter reasoning off round-trips to llm.thinking off", () => {
        const body = {
            model: "openai/gpt-5.4-mini",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
            reasoning: { effort: "none", exclude: true },
        };
        const program = OpenAIChatTranslator.fromBody(body);
        expect(program).toContainEqual({
            op: "llm.thinking",
            effort: "off",
        });
        expect(OpenAIChatTranslator.toBody(program, openrouter)).toEqual(body);
    });

    test("xai/grok models use OpenAI-style reasoning off", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "xai/grok-3" },
                    { op: "llm.thinking", effort: "off" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                openrouter,
            ),
        ).toMatchObject({
            reasoning: { effort: "none", exclude: true },
        });
    });

    test("rejects minimal thinking on OpenAI-style OpenRouter models", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "openai/gpt-5.4-mini" },
                    { op: "llm.thinking", effort: "minimal" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                openrouter,
            ),
        ).toThrow('cannot use llm.thinking effort "minimal"');
    });

    test("openai/o-series maps off to none", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "openai/o3-mini" },
                    { op: "llm.thinking", effort: "off" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                openrouter,
            ),
        ).toMatchObject({
            reasoning: { effort: "none", exclude: true },
        });
    });

    test("openai/o-series passes through medium effort", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "openai/o3-mini" },
                    { op: "llm.thinking", effort: "medium" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                openrouter,
            ),
        ).toMatchObject({
            reasoning: { effort: "medium", exclude: true },
        });
    });

    test("openai/gpt-5 passes through low and high effort", () => {
        for (const effort of ["low", "high"] as const) {
            expect(
                OpenAIChatTranslator.toBody(
                    [
                        { op: "llm.model", model: "openai/gpt-5.4-mini" },
                        { op: "llm.thinking", effort },
                        { op: "llm.text", role: "user", content: "hi" },
                    ],
                    openrouter,
                ),
            ).toMatchObject({
                reasoning: { effort, exclude: true },
            });
        }
    });

    test("xai/grok passes through non-off effort", () => {
        expect(
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "xai/grok-3" },
                    { op: "llm.thinking", effort: "medium" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                openrouter,
            ),
        ).toMatchObject({
            reasoning: { effort: "medium", exclude: true },
        });
    });

    test("rejects max effort on OpenRouter models", () => {
        expect(() =>
            OpenAIChatTranslator.toBody(
                [
                    { op: "llm.model", model: "openai/gpt-5.4-mini" },
                    { op: "llm.thinking", effort: "max" },
                    { op: "llm.text", role: "user", content: "hi" },
                ],
                openrouter,
            ),
        ).toThrow('cannot use llm.thinking effort "max"');
    });
});

describe("openai_chat service_tier strict and lenient behavior", () => {
    let warn: ReturnType<typeof spyOn<Console, "warn">>;

    beforeEach(() => {
        warn = spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    test("lenient mode warns and drops unsupported service_tier on native chat", () => {
        const body = OpenAIChatTranslator.toBody([
            { op: "llm.model", model: "gpt-4o" },
            { op: "llm.service_tier", value: "priority" },
            { op: "llm.text", role: "user", content: "hi" },
        ]);

        expect(body).not.toHaveProperty("service_tier");
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("cannot express llm.service_tier"),
        );
    });

    test("strict mode throws LintError for unsupported native service_tier", () => {
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
        expect(warn).not.toHaveBeenCalled();
    });

    test("lenient mode warns and drops unsupported OpenRouter service_tier prefixes", () => {
        const body = OpenAIChatTranslator.toBody(
            [
                { op: "llm.model", model: "meta-llama/llama-4.1" },
                { op: "llm.service_tier", value: "priority" },
                { op: "llm.text", role: "user", content: "hi" },
            ],
            openrouter,
        );

        expect(body).not.toHaveProperty("service_tier");
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("OpenRouter anthropic/, google/, openai/"),
        );
    });
});
