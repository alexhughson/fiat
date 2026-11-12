// Allowlist of dialect-op units that raising an ordinary request, response,
// or stream event may leave in the higher program, seeded from main.
//
// A unit names the wire data the op still carries:
// - `op:key` for an op carrying one keyed wire field (body_field,
//   event_param, response_param, stream_choice_param, sampling);
// - `op:key` per key for an op carrying a record of wire fields (usage,
//   generation_config, candidate_meta);
// - `op:tag.key` per top-level key for an op carrying a whole wire object
//   (output_meta, item_meta, part_meta, stream_event), where the tag is the
//   object's type or kind;
// - `op:key:subkey` per top-level key of the value for a keyed op whose
//   value is a whole object (body_field:item, body_field:response,
//   event_param:item, event_param:part, event_param:response).
//
// A change that leaves a new unit in a raised program adds a row here with a
// reason saying why only that provider has the data, or gives the concept a
// core op instead. A concept another provider also has is written "shared
// with <providers>: not provider-only" and is a row to fix, not a reason to
// keep.

export const dialectResidualAllowlist: Record<string, string> = {
    // anthropic_messages
    "anthropic_messages.body_field:id":
        "shared with openai_chat (id), openai_responses (id), openai_realtime (id), gemini (responseId): not provider-only (response id)",
    "anthropic_messages.body_field:stop_sequence":
        "shared with openai_chat (stop), gemini (generationConfig.stopSequences): not provider-only (stop sequence, echoed on the response)",
    "anthropic_messages.body_field:type":
        "shared with openai_chat (object), openai_responses (object), openai_realtime (object): not provider-only (envelope kind tag)",
    "anthropic_messages.sampling:top_k":
        "shared with gemini (generationConfig.topK): not provider-only (top_k sampling param)",
    "anthropic_messages.sampling:top_p":
        "shared with openai_chat (top_p), openai_responses (top_p), gemini (generationConfig.topP): not provider-only (top_p sampling param)",
    "anthropic_messages.stream_event:message_stop.type":
        "shared with openai_chat ([DONE] after the last chunk), openai_responses (response.completed), openai_realtime (response.done): not provider-only (stream end marker)",

    // openai_chat
    "openai_chat.body_field:created":
        "shared with openai_responses (created_at), openai_realtime (created_at): not provider-only (creation time)",
    "openai_chat.body_field:id":
        "shared with anthropic_messages (id), openai_responses (id), openai_realtime (id), gemini (responseId): not provider-only (response id)",
    "openai_chat.body_field:object":
        "shared with anthropic_messages (type), openai_responses (object), openai_realtime (object): not provider-only (envelope kind tag)",
    "openai_chat.body_field:service_tier":
        "shared with openai_responses (service_tier), gemini (usageMetadata.serviceTier): not provider-only (service tier)",
    "openai_chat.body_field:system_fingerprint":
        "openai_chat only: a build fingerprint of the serving stack; no other dialect's response schema returns one (checked anthropic_messages, openai_responses, gemini, openai_realtime)",
    "openai_chat.body_field:top_p":
        "shared with anthropic_messages (top_p), openai_responses (top_p), gemini (generationConfig.topP): not provider-only (top_p sampling param)",
    "openai_chat.stream_choice_param:index":
        "shared with openai_responses (output_index), openai_realtime (output_index), gemini (candidates[].index): not provider-only (choice index)",
    "openai_chat.usage:total_tokens":
        "shared with openai_responses (usage.total_tokens), openai_realtime (usage.total_tokens), gemini (usageMetadata.totalTokenCount): not provider-only (total token count)",

    // openai_responses
    "openai_responses.body_field:content_index":
        "shared with openai_realtime (content_index): not provider-only (content part position)",
    "openai_responses.body_field:created_at":
        "shared with openai_chat (created), openai_realtime (created_at): not provider-only (creation time)",
    "openai_responses.body_field:error":
        "shared with openai_realtime (status_details.error): not provider-only (response error object)",
    "openai_responses.body_field:id":
        "shared with anthropic_messages (id), openai_chat (id), openai_realtime (id), gemini (responseId): not provider-only (response id)",
    "openai_responses.body_field:incomplete_details":
        'shared with openai_chat (finish_reason "length"), anthropic_messages (stop_reason "max_tokens"), gemini (finishReason "MAX_TOKENS"): not provider-only (why the answer stopped short)',
    "openai_responses.body_field:instructions":
        "shared with anthropic_messages (system), openai_chat (messages system), openai_realtime (instructions), gemini (systemInstruction): not provider-only (system prompt echoed on the response)",
    "openai_responses.body_field:item_id":
        "shared with openai_realtime (item_id): not provider-only (item id)",
    "openai_responses.body_field:item:arguments":
        "shared with openai_realtime (item.arguments): not provider-only (tool call arguments)",
    "openai_responses.body_field:item:call_id":
        "shared with openai_realtime (item.call_id): not provider-only (tool call id)",
    "openai_responses.body_field:item:content":
        "shared with openai_realtime (item.content): not provider-only (message content)",
    "openai_responses.body_field:item:id":
        "shared with openai_realtime (item.id): not provider-only (output item id)",
    "openai_responses.body_field:item:name":
        "shared with openai_realtime (item.name): not provider-only (tool name)",
    "openai_responses.body_field:item:role":
        "shared with openai_realtime (item.role): not provider-only (message role)",
    "openai_responses.body_field:item:status":
        "shared with openai_realtime (item.status): not provider-only (item status)",
    "openai_responses.body_field:item:type":
        "shared with openai_realtime (item.type): not provider-only (output item type tag)",
    "openai_responses.body_field:max_output_tokens":
        "shared with anthropic_messages (max_tokens), openai_chat (max_tokens), openai_realtime (max_output_tokens), gemini (generationConfig.maxOutputTokens): not provider-only (token limit echoed on the response)",
    "openai_responses.body_field:object":
        "shared with anthropic_messages (type), openai_chat (object), openai_realtime (object): not provider-only (envelope kind tag)",
    "openai_responses.body_field:output_index":
        "shared with openai_realtime (output_index): not provider-only (output item position)",
    "openai_responses.body_field:parallel_tool_calls":
        "shared with anthropic_messages (tool_choice.disable_parallel_tool_use), openai_chat (parallel_tool_calls): not provider-only (whether the model may call tools in parallel, echoed on the response)",
    "openai_responses.body_field:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; openai_realtime groups turns by conversation_id on the response instead)",
    "openai_responses.body_field:reasoning:effort":
        "shared with anthropic_messages (thinking.budget_tokens), gemini (generationConfig.thinkingConfig.thinkingBudget), openai_chat (reasoning_effort): not provider-only (reasoning effort setting echoed on the response)",
    "openai_responses.body_field:reasoning:summary":
        "shared with gemini (generationConfig.thinkingConfig.includeThoughts): not provider-only (reasoning summary setting echoed on the response)",
    "openai_responses.body_field:response:created_at":
        "shared with openai_realtime (response.created_at): not provider-only (creation time on the terminal event)",
    "openai_responses.body_field:response:error":
        "shared with openai_realtime (response.status_details.error): not provider-only (response error object on the terminal event)",
    "openai_responses.body_field:response:id":
        "shared with openai_realtime (response.id): not provider-only (response id on the terminal event)",
    "openai_responses.body_field:response:incomplete_details":
        'shared with openai_chat (finish_reason "length"), anthropic_messages (stop_reason "max_tokens"), gemini (finishReason "MAX_TOKENS"): not provider-only (why the answer stopped short, on the terminal event)',
    "openai_responses.body_field:response:instructions":
        "shared with anthropic_messages (system), openai_chat (messages system), openai_realtime (instructions), gemini (systemInstruction): not provider-only (system prompt on the terminal event)",
    "openai_responses.body_field:response:max_output_tokens":
        "shared with anthropic_messages (max_tokens), openai_chat (max_tokens), openai_realtime (max_output_tokens), gemini (generationConfig.maxOutputTokens): not provider-only (token limit on the terminal event)",
    "openai_responses.body_field:response:metadata":
        "shared with openai_realtime (response.metadata): not provider-only (free-form key-value metadata on the response)",
    "openai_responses.body_field:response:model":
        "shared with anthropic_messages (model), openai_chat (model), gemini (modelVersion): not provider-only (model name on the terminal event)",
    "openai_responses.body_field:response:object":
        "shared with openai_realtime (response.object): not provider-only (envelope kind tag on the terminal event)",
    "openai_responses.body_field:response:output":
        "shared with openai_realtime (response.output): not provider-only (output items on the terminal event)",
    "openai_responses.body_field:response:parallel_tool_calls":
        "shared with anthropic_messages (tool_choice.disable_parallel_tool_use), openai_chat (parallel_tool_calls): not provider-only (whether the model may call tools in parallel, on the terminal event)",
    "openai_responses.body_field:response:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; openai_realtime groups turns by conversation_id on the response instead)",
    "openai_responses.body_field:response:reasoning":
        "shared with anthropic_messages (thinking), gemini (generationConfig.thinkingConfig): not provider-only (reasoning setting on the terminal event)",
    "openai_responses.body_field:response:service_tier":
        "shared with openai_chat (service_tier), gemini (usageMetadata.serviceTier): not provider-only (service tier on the terminal event)",
    "openai_responses.body_field:response:status":
        "shared with openai_realtime (response.status): not provider-only (response status on the terminal event)",
    "openai_responses.body_field:response:store":
        "shared with openai_chat (store request param): not provider-only (server-side storage flag on the terminal event)",
    "openai_responses.body_field:response:temperature":
        "shared with anthropic_messages (temperature), openai_chat (temperature), gemini (generationConfig.temperature): not provider-only (temperature on the terminal event)",
    "openai_responses.body_field:response:text":
        "shared with openai_chat (response_format), gemini (generationConfig.responseMimeType): not provider-only (requested output format on the terminal event)",
    "openai_responses.body_field:response:tool_choice":
        "shared with anthropic_messages (tool_choice), openai_chat (tool_choice), gemini (toolConfig.toolChoiceConfig): not provider-only (tool choice setting on the terminal event)",
    "openai_responses.body_field:response:tools":
        "shared with anthropic_messages (tools), openai_chat (tools), gemini (tools.functionDeclarations), openai_realtime (tools): not provider-only (tool list on the terminal event)",
    "openai_responses.body_field:response:top_p":
        "shared with anthropic_messages (top_p), openai_chat (top_p), gemini (generationConfig.topP): not provider-only (top_p on the terminal event)",
    "openai_responses.body_field:response:truncation":
        "shared with openai_realtime (truncation on response.create): not provider-only (how long context is truncated, on the terminal event)",
    "openai_responses.body_field:sequence_number":
        "shared with openai_realtime (event_id): not provider-only (per-event ordering in the stream)",
    "openai_responses.body_field:service_tier":
        "shared with openai_chat (service_tier), gemini (usageMetadata.serviceTier): not provider-only (service tier)",
    "openai_responses.body_field:status":
        "shared with openai_realtime (status): not provider-only (response status)",
    "openai_responses.body_field:store":
        "shared with openai_chat (store request param): not provider-only (server-side storage of the call, echoed on the response)",
    "openai_responses.body_field:temperature":
        "shared with anthropic_messages (temperature), openai_chat (temperature), gemini (generationConfig.temperature): not provider-only (temperature echoed on the response)",
    "openai_responses.body_field:text:format":
        "shared with openai_chat (response_format), gemini (generationConfig.responseMimeType): not provider-only (requested output format echoed on the response)",
    "openai_responses.body_field:tool_choice":
        "shared with anthropic_messages (tool_choice), openai_chat (tool_choice), gemini (toolConfig.toolChoiceConfig): not provider-only (tool choice setting echoed on the response)",
    "openai_responses.body_field:tools":
        "shared with anthropic_messages (tools), openai_chat (tools), gemini (tools.functionDeclarations), openai_realtime (tools): not provider-only (tool list echoed on the response)",
    "openai_responses.body_field:top_p":
        "shared with anthropic_messages (top_p), openai_chat (top_p), gemini (generationConfig.topP): not provider-only (top_p sampling param)",
    "openai_responses.body_field:truncation":
        "shared with openai_realtime (truncation on response.create): not provider-only (how long context is truncated, echoed on the response)",
    "openai_responses.body_field:type":
        "shared with openai_realtime (event type), anthropic_messages (event type): not provider-only (stream event name)",
    "openai_responses.output_meta:function_call.arguments":
        "shared with openai_realtime (item.arguments): not provider-only (tool call arguments kept for round-trip)",
    "openai_responses.output_meta:function_call.call_id":
        "shared with openai_realtime (item.call_id): not provider-only (tool call id kept for round-trip)",
    "openai_responses.output_meta:function_call.id":
        "shared with openai_realtime (item.id): not provider-only (function call item id kept for round-trip)",
    "openai_responses.output_meta:function_call.name":
        "shared with openai_realtime (item.name): not provider-only (tool name kept for round-trip)",
    "openai_responses.output_meta:function_call.status":
        "shared with openai_realtime (item.status): not provider-only (item status kept for round-trip)",
    "openai_responses.output_meta:function_call.type":
        "shared with openai_realtime (item.type): not provider-only (function call item type tag kept for round-trip)",
    "openai_responses.output_meta:message.content":
        "shared with openai_realtime (item.content): not provider-only (assistant text answer kept for round-trip)",
    "openai_responses.output_meta:message.id":
        "shared with openai_realtime (item.id): not provider-only (message item id kept for round-trip)",
    "openai_responses.output_meta:message.role":
        "shared with openai_realtime (item.role): not provider-only (assistant role kept for round-trip)",
    "openai_responses.output_meta:message.status":
        "shared with openai_realtime (item.status): not provider-only (item status kept for round-trip)",
    "openai_responses.output_meta:message.type":
        "shared with openai_realtime (item.type): not provider-only (assistant message item type tag kept for round-trip)",
    "openai_responses.usage:total_tokens":
        "shared with openai_chat (usage.total_tokens), openai_realtime (usage.total_tokens), gemini (usageMetadata.totalTokenCount): not provider-only (total token count)",

    // gemini
    "gemini.body_field:modelVersion":
        "shared with anthropic_messages (model), openai_chat (model), openai_responses (model): not provider-only (model name on the response)",
    "gemini.body_field:responseId":
        "shared with anthropic_messages (id), openai_chat (id), openai_responses (id), openai_realtime (id): not provider-only (response id)",
    "gemini.candidate_meta:index":
        "shared with openai_chat (choices[].index), openai_responses (output_index), openai_realtime (output_index): not provider-only (choice index)",
    "gemini.candidate_meta:safetyRatings":
        "gemini only: safety ratings on a candidate; no other dialect's response schema carries a safety-rating field (checked anthropic_messages, openai_chat, openai_responses, openai_realtime)",
    "gemini.content":
        "shared with anthropic_messages (image source), openai_chat (image_url), openai_responses (input_image), openai_realtime (input_image): not provider-only (user image; the raise recognizes only the SDK-style inline_data form, so the REST inlineData form survives with its whole content)",
    "gemini.generation_config:stopSequences":
        "shared with anthropic_messages (stop_sequences), openai_chat (stop): not provider-only (stop sequences)",
    "gemini.generation_config:topK":
        "shared with anthropic_messages (top_k): not provider-only (top_k sampling param)",
    "gemini.generation_config:topP":
        "shared with anthropic_messages (top_p), openai_chat (top_p), openai_responses (top_p): not provider-only (top_p sampling param)",
    "gemini.part_meta:functionCall.id":
        "shared with anthropic_messages (tool_use.id), openai_chat (tool_calls[].id), openai_responses (call_id), openai_realtime (call_id): not provider-only (tool call id)",
    "gemini.part_meta:functionCall.index":
        "shared with openai_chat (choices[].index), openai_responses (output_index): not provider-only (part position)",
    "gemini.part_meta:functionCall.kind":
        "shared with openai_realtime (item.type), openai_responses (item.type): not provider-only (part type tag)",
    "gemini.part_meta:functionCall.meta":
        "shared with anthropic_messages (thinking block signature): not provider-only (reasoning signature on a function call part)",
    "gemini.part_meta:functionResponse.id":
        "shared with anthropic_messages (tool_result.tool_use_id), openai_chat (tool message tool_call_id), openai_responses (function_call_output.call_id), openai_realtime (function_call_output.call_id): not provider-only (tool result id)",
    "gemini.part_meta:functionResponse.index":
        "shared with openai_chat (choices[].index), openai_responses (output_index): not provider-only (part position)",
    "gemini.part_meta:functionResponse.kind":
        "shared with openai_realtime (item.type), openai_responses (item.type): not provider-only (part type tag)",
    "gemini.part_meta:functionResponse.name":
        "gemini only: gemini wire requires the function's name on the functionResponse; no other dialect's tool result carries the tool name (checked anthropic_messages tool_result, openai_chat tool message, openai_responses function_call_output, openai_realtime function_call_output)",
    "gemini.part_meta:functionResponse.response":
        "shared with anthropic_messages (tool_result content), openai_chat (tool message content), openai_responses (function_call_output.output), openai_realtime (function_call_output.output): not provider-only (raw tool result object kept for round-trip)",
    "gemini.part_meta:text.index":
        "shared with openai_chat (choices[].index), openai_responses (output_index): not provider-only (part position)",
    "gemini.part_meta:text.kind":
        "shared with openai_realtime (item.type), openai_responses (item.type): not provider-only (part type tag)",
    "gemini.part_meta:text.meta":
        "shared with anthropic_messages (thinking block signature): not provider-only (reasoning signature on a text part)",
    "gemini.usage:serviceTier":
        "shared with openai_chat (service_tier), openai_responses (service_tier): not provider-only (service tier)",
    "gemini.usage:thoughtsTokenCount":
        "shared with openai_chat (completion_tokens_details.reasoning_tokens), openai_responses (output_tokens_details.reasoning_tokens): not provider-only (reasoning token count)",
    "gemini.usage:totalTokenCount":
        "shared with openai_chat (usage.total_tokens), openai_responses (usage.total_tokens), openai_realtime (usage.total_tokens): not provider-only (total token count)",

    // openai_realtime
    "openai_realtime.body_field:created_at":
        "shared with openai_chat (created), openai_responses (created_at): not provider-only (creation time)",
    "openai_realtime.body_field:id":
        "shared with anthropic_messages (id), openai_chat (id), openai_responses (id), gemini (responseId): not provider-only (response id)",
    "openai_realtime.body_field:model":
        "shared with anthropic_messages (model), openai_chat (model), openai_responses (model), gemini (modelVersion): not provider-only (model name on fiat's aggregate response envelope)",
    "openai_realtime.body_field:object":
        "shared with anthropic_messages (type), openai_chat (object), openai_responses (object): not provider-only (envelope kind tag)",
    "openai_realtime.body_field:status":
        "shared with openai_responses (status): not provider-only (response status)",
    "openai_realtime.body_field:status_details":
        "shared with openai_responses (incomplete_details): not provider-only (response status detail)",
    "openai_realtime.body_field:status_details:error":
        "shared with openai_responses (error): not provider-only (error object inside the status detail)",
    "openai_realtime.body_field:status_details:type":
        "shared with openai_responses (incomplete_details.reason): not provider-only (kind of status detail)",
    "openai_realtime.event_param:content_index":
        "shared with openai_responses (content_index): not provider-only (content part position)",
    "openai_realtime.event_param:event_id":
        "shared with openai_responses (sequence_number): not provider-only (per-event id that orders the stream)",
    "openai_realtime.event_param:item_id":
        "shared with openai_responses (item_id): not provider-only (item id)",
    "openai_realtime.event_param:item:arguments":
        "shared with openai_responses (item.arguments): not provider-only (tool call arguments on the event)",
    "openai_realtime.event_param:item:call_id":
        "shared with openai_responses (item.call_id): not provider-only (tool call id on the event)",
    "openai_realtime.event_param:item:content":
        "shared with openai_responses (item.content): not provider-only (message content on the event)",
    "openai_realtime.event_param:item:id":
        "shared with openai_responses (item.id): not provider-only (output item id on the event)",
    "openai_realtime.event_param:item:name":
        "shared with openai_responses (item.name): not provider-only (tool name on the event)",
    "openai_realtime.event_param:item:role":
        "shared with openai_responses (item.role): not provider-only (message role on the event)",
    "openai_realtime.event_param:item:status":
        "shared with openai_responses (item.status): not provider-only (item status on the event)",
    "openai_realtime.event_param:item:type":
        "shared with openai_responses (item.type): not provider-only (output item type tag on the event)",
    "openai_realtime.event_param:output_index":
        "shared with openai_responses (output_index): not provider-only (output item position)",
    "openai_realtime.event_param:part:text":
        "shared with openai_responses (content part text in message content): not provider-only (text content part)",
    "openai_realtime.event_param:part:type":
        "shared with openai_responses (content part type in message content): not provider-only (content part type tag)",
    "openai_realtime.event_param:response_id":
        "shared with gemini (responseId on stream chunks): not provider-only (response id on the event)",
    "openai_realtime.event_param:response:created_at":
        "shared with openai_responses (response.created_at): not provider-only (creation time on the terminal event)",
    "openai_realtime.event_param:response:id":
        "shared with openai_responses (response.id): not provider-only (response id on the terminal event)",
    "openai_realtime.event_param:response:model":
        "shared with openai_responses (response.model): not provider-only (model name on the terminal event)",
    "openai_realtime.event_param:response:object":
        "shared with openai_responses (response.object): not provider-only (envelope kind tag on the terminal event)",
    "openai_realtime.event_param:response:output":
        "shared with openai_responses (response.output): not provider-only (output items on the terminal event)",
    "openai_realtime.event_param:response:status":
        "shared with openai_responses (response.status): not provider-only (response status on the terminal event)",
    "openai_realtime.event_param:response:status_details":
        "shared with openai_responses (response.incomplete_details): not provider-only (response status detail on the terminal event)",
    "openai_realtime.event_param:text":
        "shared with openai_chat (message.content), openai_responses (output text), anthropic_messages (text block), gemini (text part): not provider-only (completed text of a message item)",
    "openai_realtime.event_param:type":
        "shared with openai_responses (event type), anthropic_messages (event type): not provider-only (stream event name)",
    "openai_realtime.item_meta:conversation.item.create.event_id":
        "openai_realtime only: the other four dialects send one request body, not a list of client events, so no other provider attaches an id to a request event (checked anthropic_messages, openai_chat, openai_responses, gemini request schemas)",
    "openai_realtime.item_meta:conversation.item.create.item":
        "shared with anthropic_messages (user message), openai_chat (messages), openai_responses (input items), gemini (contents): not provider-only (user message item kept whole for round-trip)",
    "openai_realtime.item_meta:conversation.item.create.type":
        "shared with openai_responses (stream event type), anthropic_messages (stream event type): not provider-only (event name on the request event kept for round-trip)",
    "openai_realtime.output_meta:function_call.call_id":
        "shared with openai_responses (item.call_id): not provider-only (tool call id kept for round-trip)",
    "openai_realtime.output_meta:function_call.id":
        "shared with openai_responses (item.id): not provider-only (function call item id kept for round-trip)",
    "openai_realtime.output_meta:function_call.type":
        "shared with openai_responses (item.type): not provider-only (function call item type tag kept for round-trip)",
    "openai_realtime.output_meta:message.id":
        "shared with openai_responses (item.id): not provider-only (message item id kept for round-trip)",
    "openai_realtime.output_meta:message.status":
        "shared with openai_responses (item.status): not provider-only (item status kept for round-trip)",
    "openai_realtime.output_meta:message.type":
        "shared with openai_responses (item.type): not provider-only (assistant message item type tag kept for round-trip)",
    "openai_realtime.usage:total_tokens":
        "shared with openai_chat (usage.total_tokens), openai_responses (usage.total_tokens), gemini (usageMetadata.totalTokenCount): not provider-only (total token count)",
};
