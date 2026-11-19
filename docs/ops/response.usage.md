# response.usage

```ts
{
    op: "response.usage";
    inputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    toolUsePromptTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
}
```

The token-count parts of a response's usage. The parts do not overlap and
there is no total: each dialect's lowering computes its provider's own totals
by summing the parts that are present. An absent param means the source
response body carried no count for that part — the count is unknown, not
zero — and a present 0 means the body reported the count 0.

- `inputTokens` — input tokens the provider did not report as read from or
  written to its prompt cache.
- `cacheReadTokens` — input tokens the provider served from its prompt cache.
- `cacheWriteTokens` — input tokens the provider wrote to its prompt cache
  while answering the request.
- `toolUsePromptTokens` — tool-result tokens Gemini counts beside its input
  total; the other providers fold them into their input counts.
- `outputTokens` — response tokens the provider did not itemize as reasoning.
- `reasoningTokens` — response tokens the provider itemized as reasoning.

Usage data that one provider reports — and shared concepts whose rows come
later: service tiers, modality breakdowns, cache-write lifetimes, server-tool
request counts — stay in the source dialect's usage op as a residual.

A wire total (OpenAI's `total_tokens`, Gemini's `totalTokenCount`) raises
nowhere: it is the sum of the parts, so each lowering recomputes it, and a
raise that reads a disagreeing total warns naming both numbers and keeps the
parts.

## Example 1: Anthropic usage lowered to a Chat Completions response

A proxy which exposes OpenAI's Chat Completions API and forwards each request
to Anthropic's Messages API. **In** is the `usage` object nested in the
response body Anthropic's API returns to the proxy; **Raised** is the
`response.usage` op of the program the proxy raises from that body; **Out** is
the `usage` object nested in the response body the proxy returns to its
client as if OpenAI had answered.

**In**

```json
{
    "input_tokens": 52,
    "cache_creation_input_tokens": 500,
    "cache_read_input_tokens": 2048,
    "output_tokens": 97,
    "output_tokens_details": {
        "thinking_tokens": 40
    }
}
```

**Raised**

```json
[
    {
        "op": "response.usage",
        "inputTokens": 52,
        "cacheReadTokens": 2048,
        "cacheWriteTokens": 500,
        "outputTokens": 57,
        "reasoningTokens": 40
    }
]
```

Anthropic reports every part beside its totals, so the raise only subtracts
`thinking_tokens` from `output_tokens`.

**Out**

```json
{
    "prompt_tokens": 2600,
    "prompt_tokens_details": {
        "cached_tokens": 2048,
        "cache_write_tokens": 500
    },
    "completion_tokens": 97,
    "completion_tokens_details": {
        "reasoning_tokens": 40
    },
    "total_tokens": 2697
}
```

Chat's `prompt_tokens` counts every input part, and `completion_tokens`
counts the reasoning tokens, so the lowering sums the parts back into the
totals and recomputes `total_tokens`.

## Example 2: the Gemini tool-use prompt count round-trips at home

A proxy which exposes Gemini's API and forwards each request to Gemini's own
API. **In** is the `usageMetadata` object nested in the response body
Gemini's API returns to the proxy; **Raised** is the `response.usage` op of
the program the proxy raises from that body; **Out** is the `usageMetadata`
object nested in the response body the proxy returns to its client.

**In**

```json
{
    "promptTokenCount": 2600,
    "cachedContentTokenCount": 2048,
    "toolUsePromptTokenCount": 33,
    "thoughtsTokenCount": 40,
    "candidatesTokenCount": 57,
    "totalTokenCount": 2730
}
```

**Raised**

```json
[
    {
        "op": "response.usage",
        "inputTokens": 552,
        "cacheReadTokens": 2048,
        "toolUsePromptTokens": 33,
        "outputTokens": 57,
        "reasoningTokens": 40
    }
]
```

Gemini counts its cached tokens inside `promptTokenCount` and reports its
tool-use prompt tokens and its thoughts beside its totals, so the raise
subtracts only the cached part.

**Out**

```json
{
    "promptTokenCount": 2600,
    "cachedContentTokenCount": 2048,
    "toolUsePromptTokenCount": 33,
    "candidatesTokenCount": 57,
    "thoughtsTokenCount": 40,
    "totalTokenCount": 2730
}
```

Every field comes back: the lowering keeps the tool-use count beside the
totals, as Gemini's wire requires, and recomputes `totalTokenCount` from the
parts.
