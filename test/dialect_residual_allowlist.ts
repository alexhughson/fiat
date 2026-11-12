// Allowlist for the dialect-op units that raising an ordinary request,
// response, or stream event may leave in the higher program, seeded from
// main. Read together with the unit rules in test/dialect_residual.test.ts,
// above `unitsOf`.
//
// A unit names one leaf of wire data one input leaves behind: it starts with
// the input kind (`request`, `response`, or `stream` plus, for a stream
// event that has one, the event's wire type), then the op name, the wire
// slot, the object's tag where it has one, and the key path to the leaf.
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
    "request:gemini.part_meta:functionResponse:name":
        "gemini only: gemini wire requires the function's name on the functionResponse; no other dialect's tool result carries the tool name (checked anthropic_messages tool_result, openai_chat tool message, openai_responses function_call_output, openai_realtime function_call_output)",

    // openai_realtime
    "request:openai_realtime.item_meta:conversation.item.create:event_id":
        "openai_realtime only: the other four dialects send one request body, not a list of client events, so no other provider attaches an id to a request event (checked anthropic_messages, openai_chat, openai_responses, gemini request schemas)",

    // gemini
    "response:gemini.candidate_meta:safetyRatings[].category":
        "gemini only: safety rating category on a candidate; no other dialect's response schema carries a safety-rating field (checked anthropic_messages, openai_chat, openai_responses, openai_realtime)",
    "response:gemini.candidate_meta:safetyRatings[].probability":
        "gemini only: safety rating probability on a candidate; no other dialect's response schema carries a safety-rating field (checked anthropic_messages, openai_chat, openai_responses, openai_realtime)",

    // openai_chat
    "response:openai_chat.body_field:system_fingerprint":
        "openai_chat only: a build fingerprint of the serving stack; no other dialect's response schema returns one (checked anthropic_messages, openai_responses, gemini, openai_realtime)",

    // openai_responses
    "response:openai_responses.body_field:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; anthropic_messages has the request field diagnostics.previous_message_id, which the proxy's client fills with the msg_... id of an earlier response so the server can report why the prompt cache missed, not to continue a response; openai_realtime groups turns by conversation_id on the response instead)",
    "stream:response.completed:openai_responses.body_field:response:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; anthropic_messages has the request field diagnostics.previous_message_id, which the proxy's client fills with the msg_... id of an earlier response so the server can report why the prompt cache missed, not to continue a response; openai_realtime groups turns by conversation_id on the response instead)",
    "stream:response.failed:openai_responses.body_field:response:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; anthropic_messages has the request field diagnostics.previous_message_id, which the proxy's client fills with the msg_... id of an earlier response so the server can report why the prompt cache missed, not to continue a response; openai_realtime groups turns by conversation_id on the response instead)",
    "stream:response.incomplete:openai_responses.body_field:response:previous_response_id":
        "openai_responses only: identifies the previous response this one continues server-side; no other dialect has a response-chaining id (anthropic_messages, openai_chat, and gemini are stateless APIs; anthropic_messages has the request field diagnostics.previous_message_id, which the proxy's client fills with the msg_... id of an earlier response so the server can report why the prompt cache missed, not to continue a response; openai_realtime groups turns by conversation_id on the response instead)",
};

// Residuals main produces today, unclassified. Unit string only.
export const baseline: string[] = [
    // anthropic_messages
    "request:anthropic_messages.sampling:top_k",
    "request:anthropic_messages.sampling:top_p",

    // gemini
    "request:gemini.content:parts[].inlineData.data",
    "request:gemini.content:parts[].inlineData.mimeType",
    "request:gemini.content:role",
    "request:gemini.generation_config:stopSequences[]",
    "request:gemini.generation_config:topK",
    "request:gemini.generation_config:topP",
    "request:gemini.part_meta:functionResponse:id",
    "request:gemini.part_meta:functionResponse:index",
    "request:gemini.part_meta:functionResponse:kind",
    "request:gemini.part_meta:functionResponse:response",

    // openai_chat
    "request:openai_chat.body_field:top_p",

    // openai_realtime
    "request:openai_realtime.event_param:event_id",
    "request:openai_realtime.item_meta:conversation.item.create:item.arguments",
    "request:openai_realtime.item_meta:conversation.item.create:item.call_id",
    "request:openai_realtime.item_meta:conversation.item.create:item.content[].image_url",
    "request:openai_realtime.item_meta:conversation.item.create:item.content[].text",
    "request:openai_realtime.item_meta:conversation.item.create:item.content[].type",
    "request:openai_realtime.item_meta:conversation.item.create:item.name",
    "request:openai_realtime.item_meta:conversation.item.create:item.output",
    "request:openai_realtime.item_meta:conversation.item.create:item.role",
    "request:openai_realtime.item_meta:conversation.item.create:item.type",
    "request:openai_realtime.item_meta:conversation.item.create:type",

    // openai_responses
    "request:openai_responses.body_field:top_p",

    // anthropic_messages
    "response:anthropic_messages.body_field:stop_sequence",
    "response:anthropic_messages.body_field:type",

    // gemini
    "response:gemini.body_field:modelVersion",
    "response:gemini.part_meta:functionCall:id",
    "response:gemini.part_meta:functionCall:index",
    "response:gemini.part_meta:functionCall:kind",
    "response:gemini.part_meta:functionCall:meta.thoughtSignature",
    "response:gemini.part_meta:text:index",
    "response:gemini.part_meta:text:kind",
    "response:gemini.part_meta:text:meta.thoughtSignature",
    "response:gemini.usage:serviceTier",
    "response:gemini.usage:thoughtsTokenCount",
    "response:gemini.usage:totalTokenCount",

    // openai_chat
    "response:openai_chat.body_field:created",
    "response:openai_chat.body_field:object",
    "response:openai_chat.body_field:service_tier",
    "response:openai_chat.usage:total_tokens",

    // openai_realtime
    "response:openai_realtime.body_field:created_at",
    "response:openai_realtime.body_field:model",
    "response:openai_realtime.body_field:object",
    "response:openai_realtime.body_field:status",
    "response:openai_realtime.body_field:status_details",
    "response:openai_realtime.body_field:status_details:failed:error.code",
    "response:openai_realtime.body_field:status_details:failed:error.message",
    "response:openai_realtime.body_field:status_details:failed:type",
    "response:openai_realtime.event_param:event_id",
    "response:openai_realtime.output_meta:function_call:call_id",
    "response:openai_realtime.output_meta:function_call:id",
    "response:openai_realtime.output_meta:function_call:type",
    "response:openai_realtime.output_meta:message:id",
    "response:openai_realtime.output_meta:message:status",
    "response:openai_realtime.output_meta:message:type",
    "response:openai_realtime.usage:total_tokens",

    // openai_responses
    "response:openai_responses.body_field:created_at",
    "response:openai_responses.body_field:error",
    "response:openai_responses.body_field:incomplete_details",
    "response:openai_responses.body_field:instructions",
    "response:openai_responses.body_field:max_output_tokens",
    "response:openai_responses.body_field:metadata",
    "response:openai_responses.body_field:object",
    "response:openai_responses.body_field:parallel_tool_calls",
    "response:openai_responses.body_field:reasoning:effort",
    "response:openai_responses.body_field:reasoning:summary",
    "response:openai_responses.body_field:service_tier",
    "response:openai_responses.body_field:status",
    "response:openai_responses.body_field:store",
    "response:openai_responses.body_field:temperature",
    "response:openai_responses.body_field:text:format.type",
    "response:openai_responses.body_field:tool_choice",
    "response:openai_responses.body_field:tools:[]",
    "response:openai_responses.body_field:top_p",
    "response:openai_responses.body_field:truncation",
    "response:openai_responses.output_meta:function_call:arguments",
    "response:openai_responses.output_meta:function_call:call_id",
    "response:openai_responses.output_meta:function_call:id",
    "response:openai_responses.output_meta:function_call:name",
    "response:openai_responses.output_meta:function_call:status",
    "response:openai_responses.output_meta:function_call:type",
    "response:openai_responses.output_meta:message:content[].annotations[]",
    "response:openai_responses.output_meta:message:content[].text",
    "response:openai_responses.output_meta:message:content[].type",
    "response:openai_responses.output_meta:message:id",
    "response:openai_responses.output_meta:message:role",
    "response:openai_responses.output_meta:message:status",
    "response:openai_responses.output_meta:message:type",
    "response:openai_responses.usage:total_tokens",

    // gemini
    "stream:gemini.body_field:modelVersion",
    "stream:gemini.body_field:responseId",
    "stream:gemini.candidate_meta:index",
    "stream:gemini.usage:serviceTier",
    "stream:gemini.usage:totalTokenCount",

    // anthropic_messages
    "stream:message_stop:anthropic_messages.stream_event:message_stop:type",

    // openai_chat
    "stream:openai_chat.body_field:created",
    "stream:openai_chat.body_field:id",
    "stream:openai_chat.body_field:object",
    "stream:openai_chat.stream_choice_param:index",
    "stream:openai_chat.usage:total_tokens",

    // openai_responses
    "stream:response.completed:openai_responses.body_field:response:created_at",
    "stream:response.completed:openai_responses.body_field:response:error",
    "stream:response.completed:openai_responses.body_field:response:id",
    "stream:response.completed:openai_responses.body_field:response:incomplete_details",
    "stream:response.completed:openai_responses.body_field:response:instructions",
    "stream:response.completed:openai_responses.body_field:response:max_output_tokens",
    "stream:response.completed:openai_responses.body_field:response:metadata",
    "stream:response.completed:openai_responses.body_field:response:model",
    "stream:response.completed:openai_responses.body_field:response:object",
    "stream:response.completed:openai_responses.body_field:response:output[].content[].annotations[]",
    "stream:response.completed:openai_responses.body_field:response:output[].content[].text",
    "stream:response.completed:openai_responses.body_field:response:output[].content[].type",
    "stream:response.completed:openai_responses.body_field:response:output[].id",
    "stream:response.completed:openai_responses.body_field:response:output[].role",
    "stream:response.completed:openai_responses.body_field:response:output[].status",
    "stream:response.completed:openai_responses.body_field:response:output[].type",
    "stream:response.completed:openai_responses.body_field:response:parallel_tool_calls",
    "stream:response.completed:openai_responses.body_field:response:reasoning.effort",
    "stream:response.completed:openai_responses.body_field:response:reasoning.summary",
    "stream:response.completed:openai_responses.body_field:response:service_tier",
    "stream:response.completed:openai_responses.body_field:response:status",
    "stream:response.completed:openai_responses.body_field:response:store",
    "stream:response.completed:openai_responses.body_field:response:temperature",
    "stream:response.completed:openai_responses.body_field:response:text.format.type",
    "stream:response.completed:openai_responses.body_field:response:tool_choice",
    "stream:response.completed:openai_responses.body_field:response:tools[]",
    "stream:response.completed:openai_responses.body_field:response:top_p",
    "stream:response.completed:openai_responses.body_field:response:truncation",
    "stream:response.completed:openai_responses.body_field:sequence_number",
    "stream:response.completed:openai_responses.body_field:type",
    "stream:response.completed:openai_responses.usage:total_tokens",

    // openai_realtime
    "stream:response.content_part.done:openai_realtime.event_param:content_index",
    "stream:response.content_part.done:openai_realtime.event_param:event_id",
    "stream:response.content_part.done:openai_realtime.event_param:item_id",
    "stream:response.content_part.done:openai_realtime.event_param:output_index",
    "stream:response.content_part.done:openai_realtime.event_param:part:output_text:text",
    "stream:response.content_part.done:openai_realtime.event_param:part:output_text:type",
    "stream:response.content_part.done:openai_realtime.event_param:response_id",
    "stream:response.content_part.done:openai_realtime.event_param:type",
    "stream:response.done:openai_realtime.event_param:event_id",
    "stream:response.done:openai_realtime.event_param:response:created_at",
    "stream:response.done:openai_realtime.event_param:response:id",
    "stream:response.done:openai_realtime.event_param:response:model",
    "stream:response.done:openai_realtime.event_param:response:object",
    "stream:response.done:openai_realtime.event_param:response:output[]",
    "stream:response.done:openai_realtime.event_param:response:status",
    "stream:response.done:openai_realtime.event_param:response:status_details",
    "stream:response.done:openai_realtime.event_param:type",
    "stream:response.done:openai_realtime.usage:total_tokens",

    // openai_responses
    "stream:response.failed:openai_responses.body_field:response:created_at",
    "stream:response.failed:openai_responses.body_field:response:error.code",
    "stream:response.failed:openai_responses.body_field:response:error.message",
    "stream:response.failed:openai_responses.body_field:response:id",
    "stream:response.failed:openai_responses.body_field:response:incomplete_details",
    "stream:response.failed:openai_responses.body_field:response:instructions",
    "stream:response.failed:openai_responses.body_field:response:max_output_tokens",
    "stream:response.failed:openai_responses.body_field:response:metadata",
    "stream:response.failed:openai_responses.body_field:response:model",
    "stream:response.failed:openai_responses.body_field:response:object",
    "stream:response.failed:openai_responses.body_field:response:output[]",
    "stream:response.failed:openai_responses.body_field:response:parallel_tool_calls",
    "stream:response.failed:openai_responses.body_field:response:reasoning.effort",
    "stream:response.failed:openai_responses.body_field:response:reasoning.summary",
    "stream:response.failed:openai_responses.body_field:response:service_tier",
    "stream:response.failed:openai_responses.body_field:response:status",
    "stream:response.failed:openai_responses.body_field:response:store",
    "stream:response.failed:openai_responses.body_field:response:temperature",
    "stream:response.failed:openai_responses.body_field:response:text.format.type",
    "stream:response.failed:openai_responses.body_field:response:tool_choice",
    "stream:response.failed:openai_responses.body_field:response:tools[]",
    "stream:response.failed:openai_responses.body_field:response:top_p",
    "stream:response.failed:openai_responses.body_field:response:truncation",
    "stream:response.failed:openai_responses.body_field:sequence_number",
    "stream:response.failed:openai_responses.body_field:type",
    "stream:response.failed:openai_responses.usage:total_tokens",

    // openai_realtime
    "stream:response.function_call_arguments.delta:openai_realtime.event_param:event_id",
    "stream:response.function_call_arguments.delta:openai_realtime.event_param:item_id",
    "stream:response.function_call_arguments.delta:openai_realtime.event_param:output_index",
    "stream:response.function_call_arguments.delta:openai_realtime.event_param:response_id",
    "stream:response.function_call_arguments.delta:openai_realtime.event_param:type",

    // openai_responses
    "stream:response.function_call_arguments.delta:openai_responses.body_field:item_id",
    "stream:response.function_call_arguments.delta:openai_responses.body_field:output_index",
    "stream:response.function_call_arguments.delta:openai_responses.body_field:sequence_number",
    "stream:response.function_call_arguments.delta:openai_responses.body_field:type",
    "stream:response.incomplete:openai_responses.body_field:response:created_at",
    "stream:response.incomplete:openai_responses.body_field:response:error",
    "stream:response.incomplete:openai_responses.body_field:response:id",
    "stream:response.incomplete:openai_responses.body_field:response:incomplete_details.reason",
    "stream:response.incomplete:openai_responses.body_field:response:instructions",
    "stream:response.incomplete:openai_responses.body_field:response:max_output_tokens",
    "stream:response.incomplete:openai_responses.body_field:response:metadata",
    "stream:response.incomplete:openai_responses.body_field:response:model",
    "stream:response.incomplete:openai_responses.body_field:response:object",
    "stream:response.incomplete:openai_responses.body_field:response:output[]",
    "stream:response.incomplete:openai_responses.body_field:response:parallel_tool_calls",
    "stream:response.incomplete:openai_responses.body_field:response:reasoning.effort",
    "stream:response.incomplete:openai_responses.body_field:response:reasoning.summary",
    "stream:response.incomplete:openai_responses.body_field:response:service_tier",
    "stream:response.incomplete:openai_responses.body_field:response:status",
    "stream:response.incomplete:openai_responses.body_field:response:store",
    "stream:response.incomplete:openai_responses.body_field:response:temperature",
    "stream:response.incomplete:openai_responses.body_field:response:text.format.type",
    "stream:response.incomplete:openai_responses.body_field:response:tool_choice",
    "stream:response.incomplete:openai_responses.body_field:response:tools[]",
    "stream:response.incomplete:openai_responses.body_field:response:top_p",
    "stream:response.incomplete:openai_responses.body_field:response:truncation",
    "stream:response.incomplete:openai_responses.body_field:sequence_number",
    "stream:response.incomplete:openai_responses.body_field:type",
    "stream:response.incomplete:openai_responses.usage:total_tokens",

    // openai_realtime
    "stream:response.output_item.added:openai_realtime.event_param:event_id",
    "stream:response.output_item.added:openai_realtime.event_param:item:message:content[]",
    "stream:response.output_item.added:openai_realtime.event_param:item:message:id",
    "stream:response.output_item.added:openai_realtime.event_param:item:message:role",
    "stream:response.output_item.added:openai_realtime.event_param:item:message:status",
    "stream:response.output_item.added:openai_realtime.event_param:item:message:type",
    "stream:response.output_item.added:openai_realtime.event_param:output_index",
    "stream:response.output_item.added:openai_realtime.event_param:response_id",
    "stream:response.output_item.added:openai_realtime.event_param:type",

    // openai_responses
    "stream:response.output_item.added:openai_responses.body_field:item:message:content[]",
    "stream:response.output_item.added:openai_responses.body_field:item:message:id",
    "stream:response.output_item.added:openai_responses.body_field:item:message:role",
    "stream:response.output_item.added:openai_responses.body_field:item:message:status",
    "stream:response.output_item.added:openai_responses.body_field:item:message:type",
    "stream:response.output_item.added:openai_responses.body_field:output_index",
    "stream:response.output_item.added:openai_responses.body_field:sequence_number",
    "stream:response.output_item.added:openai_responses.body_field:type",

    // openai_realtime
    "stream:response.output_item.done:openai_realtime.event_param:event_id",
    "stream:response.output_item.done:openai_realtime.event_param:item:function_call:arguments",
    "stream:response.output_item.done:openai_realtime.event_param:item:function_call:call_id",
    "stream:response.output_item.done:openai_realtime.event_param:item:function_call:id",
    "stream:response.output_item.done:openai_realtime.event_param:item:function_call:name",
    "stream:response.output_item.done:openai_realtime.event_param:item:function_call:type",
    "stream:response.output_item.done:openai_realtime.event_param:output_index",
    "stream:response.output_item.done:openai_realtime.event_param:response_id",
    "stream:response.output_item.done:openai_realtime.event_param:type",

    // openai_responses
    "stream:response.output_item.done:openai_responses.body_field:item:function_call:arguments",
    "stream:response.output_item.done:openai_responses.body_field:item:function_call:call_id",
    "stream:response.output_item.done:openai_responses.body_field:item:function_call:id",
    "stream:response.output_item.done:openai_responses.body_field:item:function_call:name",
    "stream:response.output_item.done:openai_responses.body_field:item:function_call:status",
    "stream:response.output_item.done:openai_responses.body_field:item:function_call:type",
    "stream:response.output_item.done:openai_responses.body_field:output_index",
    "stream:response.output_item.done:openai_responses.body_field:sequence_number",
    "stream:response.output_item.done:openai_responses.body_field:type",

    // openai_realtime
    "stream:response.output_text.delta:openai_realtime.event_param:content_index",
    "stream:response.output_text.delta:openai_realtime.event_param:event_id",
    "stream:response.output_text.delta:openai_realtime.event_param:item_id",
    "stream:response.output_text.delta:openai_realtime.event_param:output_index",
    "stream:response.output_text.delta:openai_realtime.event_param:response_id",
    "stream:response.output_text.delta:openai_realtime.event_param:type",

    // openai_responses
    "stream:response.output_text.delta:openai_responses.body_field:content_index",
    "stream:response.output_text.delta:openai_responses.body_field:item_id",
    "stream:response.output_text.delta:openai_responses.body_field:output_index",
    "stream:response.output_text.delta:openai_responses.body_field:sequence_number",
    "stream:response.output_text.delta:openai_responses.body_field:type",

    // openai_realtime
    "stream:response.output_text.done:openai_realtime.event_param:content_index",
    "stream:response.output_text.done:openai_realtime.event_param:event_id",
    "stream:response.output_text.done:openai_realtime.event_param:item_id",
    "stream:response.output_text.done:openai_realtime.event_param:output_index",
    "stream:response.output_text.done:openai_realtime.event_param:response_id",
    "stream:response.output_text.done:openai_realtime.event_param:text",
    "stream:response.output_text.done:openai_realtime.event_param:type",
];
