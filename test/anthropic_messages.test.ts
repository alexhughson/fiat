// Executable documentation for the anthropic_messages dialect.

import { describe, expect, test } from "bun:test";
import { AnthropicTranslator } from "../src/index";

describe("anthropic_messages requests", () => {
  test("system string and content blocks flatten to the same core ops openai produces", () => {
    const program = AnthropicTranslator.fromBody({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: "You are an omniscient AI",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "I am an omniscient ai" }] },
      ],
    });

    expect(program).toEqual([
      { op: "llm.model", model: "claude-sonnet-4-6" },
      { op: "llm.max_output_tokens", value: 800 },
      { op: "llm.text", role: "system", content: "You are an omniscient AI" },
      { op: "llm.text", role: "user", content: "Hello" },
      { op: "llm.text", role: "assistant", content: "I am an omniscient ai" },
    ]);
  });

  test("tool use round-trips through the core IR", () => {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "Check my invoices" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "list_invoices", input: { customer_id: "c_9" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '["INV-7"]' }],
        },
      ],
      tools: [
        {
          name: "list_invoices",
          description: "List customer invoices.",
          input_schema: { type: "object", properties: { customer_id: { type: "string" } } },
        },
      ],
      tool_choice: { type: "auto" },
    };

    const program = AnthropicTranslator.fromBody(body);
    expect(program).toContainEqual({
      op: "llm.tool_call",
      id: "toolu_1",
      name: "list_invoices",
      arguments: { customer_id: "c_9" },
    });
    expect(program).toContainEqual({ op: "llm.tool_result", id: "toolu_1", content: '["INV-7"]' });
    expect(AnthropicTranslator.toBody(program)).toEqual(body);
  });

  test("lowering merges consecutive same-role ops into one alternating-turn message", () => {
    const body = AnthropicTranslator.toBody([
      { op: "llm.model", model: "claude-sonnet-4-6" },
      { op: "llm.max_output_tokens", value: 100 },
      { op: "llm.text", role: "user", content: "first" },
      { op: "llm.text", role: "user", content: "second" },
    ]) as { messages: unknown[] };

    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  test("the default-max-tokens legalization fills in the required cap", () => {
    const body = AnthropicTranslator.toBody([
      { op: "llm.model", model: "claude-sonnet-4-6" },
      { op: "llm.text", role: "user", content: "hi" },
    ]) as { max_tokens: number };

    expect(body.max_tokens).toBe(4096);
  });

  test("llm.output has no anthropic equivalent — lowering lints instead of dropping it", () => {
    expect(() =>
      AnthropicTranslator.toBody([
        { op: "llm.model", model: "claude-sonnet-4-6" },
        { op: "llm.text", role: "user", content: "hi" },
        { op: "llm.output", format: "json_schema", name: "check", schema: {} },
      ]),
    ).toThrow("no structured-output equivalent");
  });
});

describe("anthropic_messages responses", () => {
  const wireResponse = {
    id: "msg_01ABC",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "No, it is correct." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 0 },
  };

  test("responses raise to core ops plus an ignorable vendor-usage residual", () => {
    // The message raises first; the rest follows wire key order.
    expect(AnthropicTranslator.fromResponse(wireResponse)).toEqual([
      { op: "llm.text", role: "assistant", content: "No, it is correct." },
      { op: "anthropic_messages.param", key: "id", value: "msg_01ABC", required: false },
      { op: "anthropic_messages.param", key: "type", value: "message", required: false },
      { op: "llm.model", model: "claude-sonnet-4-6" },
      { op: "response.stop", reason: "end_turn" },
      { op: "response.usage", inputTokens: 20, outputTokens: 9 },
      { op: "anthropic_messages.usage", usage: { cache_read_input_tokens: 0 }, required: false },
    ]);
  });

  test("responses round-trip", () => {
    const program = AnthropicTranslator.fromResponse(wireResponse);
    expect(AnthropicTranslator.toResponse(program)).toEqual(wireResponse);
  });
});
