// Executable documentation for the openai_chat dialect: what each wire
// payload looks like as a core-IR program, and that the mapping round-trips.

import { describe, expect, test } from "bun:test";
import { OpenAIChatTranslator } from "../src/index";

describe("openai_chat requests", () => {
  test("a chat body becomes a flat program of core ops", () => {
    const program = OpenAIChatTranslator.fromBody({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        { role: "system", content: "You are an omniscient AI" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "I am an omniscient ai" },
      ],
    });

    expect(program).toEqual([
      { op: "llm.model", model: "gpt-4o" },
      { op: "llm.temperature", value: 0.2 },
      { op: "llm.max_output_tokens", value: 800 },
      { op: "llm.text", role: "system", content: "You are an omniscient AI" },
      { op: "llm.text", role: "user", content: "Hello" },
      { op: "llm.text", role: "assistant", content: "I am an omniscient ai" },
    ]);
  });

  test("core programs serialize back to the same wire body", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "What's on invoice INV-7?" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "list_invoices",
            description: "List customer invoices.",
            parameters: { type: "object", properties: { customer_id: { type: "string" } } },
          },
        },
      ],
      tool_choice: "auto",
    };

    expect(OpenAIChatTranslator.toBody(OpenAIChatTranslator.fromBody(body))).toEqual(body);
  });

  test("tool calls flatten to llm.tool_call with parsed arguments, and regroup on the way out", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Check my invoices" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list_invoices", arguments: '{"customer_id":"c_9"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '["INV-7"]' },
      ],
    };

    const program = OpenAIChatTranslator.fromBody(body);
    expect(program).toEqual([
      { op: "llm.model", model: "gpt-4o" },
      { op: "llm.text", role: "user", content: "Check my invoices" },
      { op: "llm.tool_call", id: "call_1", name: "list_invoices", arguments: { customer_id: "c_9" } },
      { op: "llm.tool_result", id: "call_1", content: '["INV-7"]' },
    ]);

    expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
  });

  test("unmapped body keys survive as openai_chat.param residuals and round-trip", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      user: "user-1234",
    };

    const program = OpenAIChatTranslator.fromBody(body);
    expect(program).toContainEqual({ op: "openai_chat.param", key: "user", value: "user-1234" });
    expect(OpenAIChatTranslator.toBody(program)).toEqual(body);
  });

  test("malformed tool call arguments halt instead of degrading", () => {
    expect(() =>
      OpenAIChatTranslator.fromBody({
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{oops" } }],
          },
        ],
      }),
    ).toThrow("not valid JSON");
  });
});

describe("openai_chat responses", () => {
  const wireResponse = {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "No, it is correct." },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
  };

  test("a response raises to the same op vocabulary as requests", () => {
    // Op order follows wire key order; envelope params are born droppable.
    expect(OpenAIChatTranslator.fromResponse(wireResponse)).toEqual([
      { op: "openai_chat.param", key: "id", value: "chatcmpl-123", required: false },
      { op: "openai_chat.param", key: "object", value: "chat.completion", required: false },
      { op: "openai_chat.param", key: "created", value: 1700000000, required: false },
      { op: "llm.model", model: "gpt-4o" },
      { op: "llm.text", role: "assistant", content: "No, it is correct." },
      { op: "response.stop", reason: "end_turn" },
      { op: "response.usage", inputTokens: 20, outputTokens: 9 },
      // Vendor-specific counts stay in the stream as an ignorable residual:
      // other dialects drop it, openai_chat merges it back into wire usage.
      { op: "openai_chat.usage", usage: { total_tokens: 29 }, required: false },
    ]);
  });

  test("responses round-trip", () => {
    const program = OpenAIChatTranslator.fromResponse(wireResponse);
    expect(OpenAIChatTranslator.toResponse(program)).toEqual(wireResponse);
  });
});
