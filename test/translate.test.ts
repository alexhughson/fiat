// Executable documentation for the cross-dialect pipeline: requests and
// responses translating between providers, core-IR passes, residual
// semantics, and response-onto-request chaining.

import { describe, expect, test } from "bun:test";
import {
  append,
  LintError,
  opsOf,
  translateRequest,
  translateResponse,
  AnthropicTranslator,
  OpenAIChatTranslator,
  type Pass,
} from "../src/index";

describe("request translation", () => {
  test("an openai body becomes an anthropic body: system message moves to the system param", () => {
    const anthropicBody = translateRequest(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        messages: [
          { role: "system", content: "You are an omniscient AI" },
          { role: "user", content: "Hello" },
        ],
      },
      { from: "openai_chat", to: "anthropic_messages" },
    );

    expect(anthropicBody).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: "You are an omniscient AI",
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
  });

  test("tools translate: function parameters become input_schema, tool_calls become tool_use blocks", () => {
    const anthropicBody = translateRequest(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        messages: [
          { role: "user", content: "Check my invoices" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "list_invoices", arguments: '{"customer_id":"c_9"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '["INV-7"]' },
        ],
        tools: [
          {
            type: "function",
            function: { name: "list_invoices", description: "List customer invoices.", parameters: { type: "object" } },
          },
        ],
        tool_choice: "required",
      },
      { from: "openai_chat", to: "anthropic_messages" },
    );

    expect(anthropicBody).toEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      messages: [
        { role: "user", content: [{ type: "text", text: "Check my invoices" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "list_invoices", input: { customer_id: "c_9" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '["INV-7"]' }] },
      ],
      tools: [{ name: "list_invoices", description: "List customer invoices.", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
  });

  test("core-IR passes run between raise and lower — e.g. rerouting the model", () => {
    const rerouteToHaiku: Pass = {
      name: "reroute-to-haiku",
      run: (program) =>
        program.map((op) => (op.op === "llm.model" ? { op: "llm.model", model: "claude-haiku-4-5" } : op)),
    };

    const body = translateRequest(
      { model: "gpt-4o", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { from: "openai_chat", to: "anthropic_messages", passes: [rerouteToHaiku] },
    ) as { model: string };

    expect(body.model).toBe("claude-haiku-4-5");
  });
});

describe("residual semantics", () => {
  const bodyWithResidual = (required: boolean | undefined) => ({
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    // openai-only; anthropic has no equivalent
    logit_bias: { "50256": -100 },
    ...(required === undefined ? {} : {}),
  });

  test("an endpoint-only param that nothing consumed halts the translation", () => {
    expect(() =>
      translateRequest(bodyWithResidual(undefined), { from: "openai_chat", to: "anthropic_messages" }),
    ).toThrow(LintError);
  });

  test("a pass can mark a residual droppable, and then it is silently dropped by design", () => {
    const allowDroppingLogitBias: Pass = {
      name: "allow-dropping-logit-bias",
      run: (program) =>
        program.map((op) =>
          op.op === "openai_chat.param" && (op as { key?: string }).key === "logit_bias"
            ? { ...op, required: false }
            : op,
        ),
    };

    const body = translateRequest(bodyWithResidual(undefined), {
      from: "openai_chat",
      to: "anthropic_messages",
      passes: [allowDroppingLogitBias],
    }) as Record<string, unknown>;

    expect(body.logit_bias).toBeUndefined();
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("residuals returning to their home dialect are consumed losslessly", () => {
    const original = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      logit_bias: { "50256": -100 },
    };
    const roundTripped = translateRequest(original, { from: "openai_chat", to: "openai_chat" });
    expect(roundTripped).toEqual(original);
  });
});

describe("response translation and chaining", () => {
  const anthropicResponse = {
    id: "msg_01ABC",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "It is correct." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 20, output_tokens: 9 },
  };

  test("an anthropic response becomes an openai response — the proxy use case", () => {
    const openaiResponse = translateResponse(anthropicResponse, {
      from: "anthropic_messages",
      to: "openai_chat",
    }) as Record<string, unknown>;

    expect(openaiResponse.model).toBe("claude-sonnet-4-6");
    expect(openaiResponse.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "It is correct." },
        finish_reason: "stop",
        logprobs: null,
      },
    ]);
    expect(openaiResponse.usage).toEqual({ prompt_tokens: 20, completion_tokens: 9 });
    // Protocol boilerplate is synthesized when the source has none to map.
    expect(openaiResponse.object).toBe("chat.completion");
  });

  test("appending a response program to a request program makes the next request", () => {
    const request = OpenAIChatTranslator.fromBody({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Was I double charged?" }],
    });
    const response = OpenAIChatTranslator.fromResponse({
      model: "gpt-4o",
      choices: [
        { index: 0, message: { role: "assistant", content: "No, it is correct." }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });

    const nextTurn = append(
      append(request, ...response),
      { op: "llm.text", role: "user", content: "Are you sure?" },
    );

    // response.* and residual bookkeeping ops don't get re-sent; the
    // assistant turn does.
    expect(OpenAIChatTranslator.toBody(nextTurn)).toEqual({
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Was I double charged?" },
        { role: "assistant", content: "No, it is correct." },
        { role: "user", content: "Are you sure?" },
      ],
    });

    expect(opsOf(nextTurn, "response.usage")).toHaveLength(1);
  });
});
