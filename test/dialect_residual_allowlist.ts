// Allowlist for the dialect-op units that raising an ordinary request,
// response, or stream event may leave in the higher program, seeded from
// main. Read together with the unit rules in test/dialect_residual.test.ts,
// above `unitsOf`.
//
// providerOnly: units whose data only one provider has. Each reason names
// the references checked. A unit here must not appear in baseline.
//
// baseline: residuals that exist on main and have not been classified. A
// row is the unit string only; it makes no claim about other providers. A
// pull request may delete rows from baseline and may not add rows to it.
//
// A change that leaves a new unit in a raised program must either raise the
// concept to a core op or add a providerOnly row with a reason. A row in
// either list that the corpus no longer produces goes stale and must be
// removed, so every row stays checked.

export const providerOnly: Record<string, string> = {
    // gemini
    "gemini.candidate_meta:safetyRatings[].category":
        "gemini only: safety rating category on a candidate; no other dialect's response schema carries a safety-rating field (checked anthropic_messages, openai_chat, openai_responses, openai_realtime)",
    "gemini.candidate_meta:safetyRatings[].probability":
        "gemini only: safety rating probability on a candidate; no other dialect's response schema carries a safety-rating field (checked anthropic_messages, openai_chat, openai_responses, openai_realtime)",
    "gemini.part_meta:functionResponse:name":
        "gemini only: gemini wire requires the function's name on the functionResponse; no other dialect's tool result carries the tool name (checked anthropic_messages tool_result, openai_chat tool message, openai_responses function_call_output, openai_realtime function_call_output)",

    // openai_chat
    "openai_chat.body_field:system_fingerprint":
        "openai_chat only: a build fingerprint of the serving stack; no other dialect's response schema returns one (checked anthropic_messages, openai_responses, gemini, openai_realtime)",

    // openai_realtime
    "openai_realtime.item_meta:conversation.item.create:event_id":
        "openai_realtime only: the other four dialects send one request body, not a list of client events, so no other provider attaches an id to a request event (checked anthropic_messages, openai_chat, openai_responses, gemini request schemas)",

    // openai_responses
    "openai_responses.body_field:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; openai_realtime groups turns by conversation_id on the response instead)",
    "openai_responses.body_field:response:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; openai_realtime groups turns by conversation_id on the response instead)",
};

// Residuals main produces today, unclassified. Unit string only.
export const baseline: string[] = [
    // anthropic_messages
    "anthropic_messages.body_field:id",
    "anthropic_messages.body_field:stop_sequence",
    "anthropic_messages.body_field:type",
    "anthropic_messages.sampling:top_k",
    "anthropic_messages.sampling:top_p",
    "anthropic_messages.stream_event:message_stop:type",

    // gemini
    "gemini.body_field:modelVersion",
    "gemini.body_field:responseId",
    "gemini.candidate_meta:index",
    "gemini.content:parts[].inlineData.data",
    "gemini.content:parts[].inlineData.mimeType",
    "gemini.content:role",
    "gemini.generation_config:stopSequences[]",
    "gemini.generation_config:topK",
    "gemini.generation_config:topP",
    "gemini.part_meta:functionCall:id",
    "gemini.part_meta:functionCall:index",
    "gemini.part_meta:functionCall:kind",
    "gemini.part_meta:functionCall:meta",
    "gemini.part_meta:functionResponse:id",
    "gemini.part_meta:functionResponse:index",
    "gemini.part_meta:functionResponse:kind",
    "gemini.part_meta:functionResponse:response",
    "gemini.part_meta:text:index",
    "gemini.part_meta:text:kind",
    "gemini.part_meta:text:meta",
    "gemini.usage:serviceTier",
    "gemini.usage:thoughtsTokenCount",
    "gemini.usage:totalTokenCount",

    // openai_chat
    "openai_chat.body_field:created",
    "openai_chat.body_field:id",
    "openai_chat.body_field:object",
    "openai_chat.body_field:service_tier",
    "openai_chat.body_field:top_p",
    "openai_chat.stream_choice_param:index",
    "openai_chat.usage:total_tokens",

    // openai_realtime
    "openai_realtime.body_field:created_at",
    "openai_realtime.body_field:id",
    "openai_realtime.body_field:model",
    "openai_realtime.body_field:object",
    "openai_realtime.body_field:status",
    "openai_realtime.body_field:status_details",
    "openai_realtime.body_field:status_details:failed:error.code",
    "openai_realtime.body_field:status_details:failed:error.message",
    "openai_realtime.body_field:status_details:failed:type",
    "openai_realtime.event_param:content_index",
    "openai_realtime.event_param:event_id",
    "openai_realtime.event_param:item:function_call:arguments",
    "openai_realtime.event_param:item:function_call:call_id",
    "openai_realtime.event_param:item:function_call:id",
    "openai_realtime.event_param:item:function_call:name",
    "openai_realtime.event_param:item:function_call:type",
    "openai_realtime.event_param:item:message:content[]",
    "openai_realtime.event_param:item:message:id",
    "openai_realtime.event_param:item:message:role",
    "openai_realtime.event_param:item:message:status",
    "openai_realtime.event_param:item:message:type",
    "openai_realtime.event_param:item_id",
    "openai_realtime.event_param:output_index",
    "openai_realtime.event_param:part:output_text:text",
    "openai_realtime.event_param:part:output_text:type",
    "openai_realtime.event_param:response:created_at",
    "openai_realtime.event_param:response:id",
    "openai_realtime.event_param:response:model",
    "openai_realtime.event_param:response:object",
    "openai_realtime.event_param:response:output[]",
    "openai_realtime.event_param:response:status",
    "openai_realtime.event_param:response:status_details",
    "openai_realtime.event_param:response_id",
    "openai_realtime.event_param:text",
    "openai_realtime.event_param:type",
    "openai_realtime.item_meta:conversation.item.create:item.arguments",
    "openai_realtime.item_meta:conversation.item.create:item.call_id",
    "openai_realtime.item_meta:conversation.item.create:item.content[].image_url",
    "openai_realtime.item_meta:conversation.item.create:item.content[].text",
    "openai_realtime.item_meta:conversation.item.create:item.content[].type",
    "openai_realtime.item_meta:conversation.item.create:item.name",
    "openai_realtime.item_meta:conversation.item.create:item.output",
    "openai_realtime.item_meta:conversation.item.create:item.role",
    "openai_realtime.item_meta:conversation.item.create:item.type",
    "openai_realtime.item_meta:conversation.item.create:type",
    "openai_realtime.output_meta:function_call:call_id",
    "openai_realtime.output_meta:function_call:id",
    "openai_realtime.output_meta:function_call:type",
    "openai_realtime.output_meta:message:id",
    "openai_realtime.output_meta:message:status",
    "openai_realtime.output_meta:message:type",
    "openai_realtime.usage:total_tokens",

    // openai_responses
    "openai_responses.body_field:content_index",
    "openai_responses.body_field:created_at",
    "openai_responses.body_field:error",
    "openai_responses.body_field:id",
    "openai_responses.body_field:incomplete_details",
    "openai_responses.body_field:instructions",
    "openai_responses.body_field:item:function_call:arguments",
    "openai_responses.body_field:item:function_call:call_id",
    "openai_responses.body_field:item:function_call:id",
    "openai_responses.body_field:item:function_call:name",
    "openai_responses.body_field:item:function_call:status",
    "openai_responses.body_field:item:function_call:type",
    "openai_responses.body_field:item:message:content[]",
    "openai_responses.body_field:item:message:id",
    "openai_responses.body_field:item:message:role",
    "openai_responses.body_field:item:message:status",
    "openai_responses.body_field:item:message:type",
    "openai_responses.body_field:item_id",
    "openai_responses.body_field:max_output_tokens",
    "openai_responses.body_field:metadata",
    "openai_responses.body_field:object",
    "openai_responses.body_field:output_index",
    "openai_responses.body_field:parallel_tool_calls",
    "openai_responses.body_field:reasoning:effort",
    "openai_responses.body_field:reasoning:summary",
    "openai_responses.body_field:response:created_at",
    "openai_responses.body_field:response:error",
    "openai_responses.body_field:response:error.code",
    "openai_responses.body_field:response:error.message",
    "openai_responses.body_field:response:id",
    "openai_responses.body_field:response:incomplete_details",
    "openai_responses.body_field:response:incomplete_details.reason",
    "openai_responses.body_field:response:instructions",
    "openai_responses.body_field:response:max_output_tokens",
    "openai_responses.body_field:response:metadata",
    "openai_responses.body_field:response:model",
    "openai_responses.body_field:response:object",
    "openai_responses.body_field:response:output[]",
    "openai_responses.body_field:response:output[].content[].annotations[]",
    "openai_responses.body_field:response:output[].content[].text",
    "openai_responses.body_field:response:output[].content[].type",
    "openai_responses.body_field:response:output[].id",
    "openai_responses.body_field:response:output[].role",
    "openai_responses.body_field:response:output[].status",
    "openai_responses.body_field:response:output[].type",
    "openai_responses.body_field:response:parallel_tool_calls",
    "openai_responses.body_field:response:reasoning.effort",
    "openai_responses.body_field:response:reasoning.summary",
    "openai_responses.body_field:response:service_tier",
    "openai_responses.body_field:response:status",
    "openai_responses.body_field:response:store",
    "openai_responses.body_field:response:temperature",
    "openai_responses.body_field:response:text.format.type",
    "openai_responses.body_field:response:tool_choice",
    "openai_responses.body_field:response:tools[]",
    "openai_responses.body_field:response:top_p",
    "openai_responses.body_field:response:truncation",
    "openai_responses.body_field:sequence_number",
    "openai_responses.body_field:service_tier",
    "openai_responses.body_field:status",
    "openai_responses.body_field:store",
    "openai_responses.body_field:temperature",
    "openai_responses.body_field:text:format.type",
    "openai_responses.body_field:tool_choice",
    "openai_responses.body_field:tools:[]",
    "openai_responses.body_field:top_p",
    "openai_responses.body_field:truncation",
    "openai_responses.body_field:type",
    "openai_responses.output_meta:function_call:arguments",
    "openai_responses.output_meta:function_call:call_id",
    "openai_responses.output_meta:function_call:id",
    "openai_responses.output_meta:function_call:name",
    "openai_responses.output_meta:function_call:status",
    "openai_responses.output_meta:function_call:type",
    "openai_responses.output_meta:message:content[].annotations[]",
    "openai_responses.output_meta:message:content[].text",
    "openai_responses.output_meta:message:content[].type",
    "openai_responses.output_meta:message:id",
    "openai_responses.output_meta:message:role",
    "openai_responses.output_meta:message:status",
    "openai_responses.output_meta:message:type",
    "openai_responses.usage:total_tokens",
];
