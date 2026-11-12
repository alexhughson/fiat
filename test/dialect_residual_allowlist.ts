// Allowlist of dialect-op units that raising an ordinary request, response,
// or stream event may leave in the higher program, seeded from main.
//
// A unit names the wire data the op still carries:
// - `op:key` for an op carrying one keyed wire field (body_field,
//   event_param, response_param, stream_choice_param, sampling);
// - `op:key` per key for an op carrying a record of wire fields (usage,
//   generation_config, candidate_meta);
// - `op:tag` for an op carrying a whole wire object (output_meta, item_meta,
//   part_meta, stream_event), where the tag is the object's type or kind.
//
// A change that leaves a new unit in a raised program adds a row here with a
// reason saying why only that provider has the data, or gives the concept a
// core op instead. A concept another provider also has is written "shared
// with <providers>: not provider-only" and is a row to fix, not a reason to
// keep.

export const dialectResidualAllowlist: Record<string, string> = {
    // anthropic_messages
    "anthropic_messages.sampling:top_p":
        "shared with openai_chat (top_p), openai_responses (top_p), gemini (generationConfig.topP): not provider-only (top_p sampling param)",
    "anthropic_messages.sampling:top_k":
        "shared with gemini (generationConfig.topK): not provider-only (top_k sampling param)",
    "anthropic_messages.body_field:id":
        "shared with openai_chat (id), openai_responses (id), openai_realtime (id), gemini (responseId): not provider-only (response id)",
    "anthropic_messages.body_field:type":
        "shared with openai_chat (object), openai_responses (object): not provider-only (envelope kind tag)",
    "anthropic_messages.stream_event:message_stop":
        "shared with openai_chat (finish_reason on the last chunk), openai_responses (response.completed), openai_realtime (response.done): not provider-only (stream end marker)",

    // openai_chat
    "openai_chat.body_field:top_p":
        "shared with anthropic_messages (top_p), openai_responses (top_p), gemini (generationConfig.topP): not provider-only (top_p sampling param)",
    "openai_chat.body_field:id":
        "shared with anthropic_messages (id), openai_responses (id), openai_realtime (id), gemini (responseId): not provider-only (response id)",
    "openai_chat.body_field:object":
        "shared with anthropic_messages (type), openai_responses (object): not provider-only (envelope kind tag)",
    "openai_chat.body_field:created":
        "shared with openai_responses (created_at): not provider-only (creation time)",
    "openai_chat.body_field:service_tier":
        "shared with openai_responses (service_tier), gemini (usageMetadata.serviceTier): not provider-only (service tier)",
    "openai_chat.body_field:system_fingerprint":
        "openai_chat only: the openai_responses response object carries no system_fingerprint, and no other provider returns a build fingerprint",
    "openai_chat.usage:total_tokens":
        "shared with openai_responses (usage.total_tokens), openai_realtime (usage.total_tokens), gemini (usageMetadata.totalTokenCount): not provider-only (total token count)",
    "openai_chat.stream_choice_param:index":
        "shared with openai_responses (output_index), gemini (candidates[].index): not provider-only (choice index)",

    // openai_responses
    "openai_responses.body_field:top_p":
        "shared with anthropic_messages (top_p), openai_chat (top_p), gemini (generationConfig.topP): not provider-only (top_p sampling param)",
    "openai_responses.body_field:id":
        "shared with anthropic_messages (id), openai_chat (id), openai_realtime (id), gemini (responseId): not provider-only (response id)",
    "openai_responses.body_field:object":
        "shared with anthropic_messages (type), openai_chat (object): not provider-only (envelope kind tag)",
    "openai_responses.body_field:created_at":
        "shared with openai_chat (created): not provider-only (creation time)",
    "openai_responses.body_field:status":
        "shared with openai_realtime (status): not provider-only (response status)",
    "openai_responses.body_field:service_tier":
        "shared with openai_chat (service_tier), gemini (usageMetadata.serviceTier): not provider-only (service tier)",
    "openai_responses.output_meta:message":
        "shared with anthropic_messages (content text), openai_chat (message), openai_realtime (message item), gemini (text part): not provider-only (assistant text answer; the item template keeps the item id, role, status, and content)",
    "openai_responses.output_meta:function_call":
        "shared with anthropic_messages (tool_use), openai_chat (tool_calls), openai_realtime (function_call item), gemini (functionCall part): not provider-only (tool call; the item template keeps the item id, call id, name, and arguments)",
    "openai_responses.usage:total_tokens":
        "shared with openai_chat (usage.total_tokens), openai_realtime (usage.total_tokens), gemini (usageMetadata.totalTokenCount): not provider-only (total token count)",
    "openai_responses.body_field:type":
        "shared with openai_realtime (event type), anthropic_messages (event type): not provider-only (stream event name)",
    "openai_responses.body_field:response_id":
        "shared with openai_realtime (response_id): not provider-only (response id on the event)",
    "openai_responses.body_field:output_index":
        "shared with openai_realtime (output_index): not provider-only (output item position)",
    "openai_responses.body_field:content_index":
        "shared with openai_realtime (content_index): not provider-only (content part position)",
    "openai_responses.body_field:item_id":
        "shared with openai_realtime (item_id on function call argument deltas): not provider-only (item id)",
    "openai_responses.body_field:item":
        "shared with openai_realtime (item): not provider-only (output item object)",
    "openai_responses.body_field:response":
        "shared with openai_realtime (response): not provider-only (response object)",

    // gemini
    "gemini.generation_config:topP":
        "shared with anthropic_messages (top_p), openai_chat (top_p), openai_responses (top_p): not provider-only (top_p sampling param)",
    "gemini.generation_config:stopSequences":
        "shared with anthropic_messages (stop_sequences) and openai_chat (stop), which raise it to core request.stop_sequences: not provider-only (stop sequences)",
    "gemini.generation_config:topK":
        "shared with anthropic_messages (top_k): not provider-only (top_k sampling param)",
    "gemini.part_meta:functionResponse":
        "shared with anthropic_messages (tool_result), openai_chat (tool message), openai_responses (function_call_output), openai_realtime (function_call_output item): not provider-only (tool result; the part keeps the tool name and the raw response object, which llm.tool_result lacks)",
    "gemini.part_meta:text":
        "shared with anthropic_messages (thinking signatures on tool_use blocks): not provider-only (reasoning signature on a text part)",
    "gemini.part_meta:functionCall":
        "shared with anthropic_messages (thinking signatures on tool_use blocks): not provider-only (reasoning signature on a function call part)",
    "gemini.candidate_meta:index":
        "shared with openai_chat (choices[].index), openai_responses (output_index): not provider-only (choice index)",
    "gemini.candidate_meta:safetyRatings":
        "gemini only: safety ratings on a candidate; no other dialect's response carries a safety-rating field",
    "gemini.usage:totalTokenCount":
        "shared with openai_chat (usage.total_tokens), openai_responses (usage.total_tokens), openai_realtime (usage.total_tokens): not provider-only (total token count)",
    "gemini.usage:thoughtsTokenCount":
        "shared with openai_chat (completion_tokens_details.reasoning_tokens), openai_responses (output_tokens_details.reasoning_tokens): not provider-only (reasoning token count)",
    "gemini.usage:serviceTier":
        "shared with openai_chat (service_tier), openai_responses (service_tier): not provider-only (service tier)",
    "gemini.body_field:responseId":
        "shared with anthropic_messages (id), openai_chat (id), openai_responses (id), openai_realtime (id): not provider-only (response id)",
    "gemini.body_field:modelVersion":
        "shared with anthropic_messages (model), openai_chat (model), openai_responses (model): not provider-only (model name on the response)",

    // openai_realtime
    "openai_realtime.item_meta:message":
        "shared with anthropic_messages (user text and image), openai_chat (user message), openai_responses (user message), gemini (user content): not provider-only (user text and image; the item template keeps the multi-part item for round-trip)",
    "openai_realtime.response_param:temperature":
        "shared with anthropic_messages (temperature), openai_chat (temperature), openai_responses (temperature), gemini (generationConfig.temperature): not provider-only (temperature sampling param)",
    "openai_realtime.response_param:modalities":
        "shared with gemini (generationConfig.responseModalities): not provider-only (requested output modalities)",
    "openai_realtime.body_field:id":
        "shared with anthropic_messages (id), openai_chat (id), openai_responses (id), gemini (responseId): not provider-only (response id)",
    "openai_realtime.body_field:status":
        "shared with openai_responses (status): not provider-only (response status)",
    "openai_realtime.body_field:error":
        "shared with openai_responses (error): not provider-only (response error object)",
    "openai_realtime.output_meta:message":
        "shared with anthropic_messages (content text), openai_chat (message), openai_responses (message item), gemini (text part): not provider-only (assistant text answer; the item template keeps the item id, role, status, and content)",
    "openai_realtime.output_meta:function_call":
        "shared with anthropic_messages (tool_use), openai_chat (tool_calls), openai_responses (function_call item), gemini (functionCall part): not provider-only (tool call; the item template keeps the item id and call id)",
    "openai_realtime.usage:total_tokens":
        "shared with openai_chat (usage.total_tokens), openai_responses (usage.total_tokens), gemini (usageMetadata.totalTokenCount): not provider-only (total token count)",
    "openai_realtime.event_param:type":
        "shared with openai_responses (event type), anthropic_messages (event type): not provider-only (stream event name)",
    "openai_realtime.event_param:response_id":
        "shared with openai_responses (response_id): not provider-only (response id on the event)",
    "openai_realtime.event_param:output_index":
        "shared with openai_responses (output_index): not provider-only (output item position)",
    "openai_realtime.event_param:content_index":
        "shared with openai_responses (content_index): not provider-only (content part position)",
    "openai_realtime.event_param:item_id":
        "shared with openai_responses (item_id): not provider-only (item id)",
    "openai_realtime.event_param:item":
        "shared with openai_responses (item): not provider-only (output item object)",
    "openai_realtime.event_param:response":
        "shared with openai_responses (response): not provider-only (response object)",
};
