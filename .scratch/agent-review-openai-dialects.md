review the current uncommitted changes in /Users/alex/Code/metamodel, read-only.

write exactly one report file: .scratch/agent-review-openai-dialects-result.md. do not edit source or tests.

what changed:
- openai_responses now preserves response output item templates via output_meta, including content annotations/logprobs, multiple message output items, and item status.
- openai_responses now carries function-tool extra fields such as strict in openai_responses.tool_meta and consumes them only when lowering back to openai_responses.
- openai_responses incomplete_details.reason content_filter maps to response.stop content_filter; unknown incomplete reasons lint.
- openai_chat now preserves response-only assistant message refusal/annotations/audio in openai_chat.message_meta and strips that metadata from request bodies.
- openai_chat/openai_responses stop lowering now throws for pause_turn and model_context_window_exceeded instead of mapping to length/max_tokens.
- request serializers drop legacy droppable response-envelope params like id, but still keep request params such as user.

specific checks:
1. no source edits outside src/dialects/openai_responses/* and src/dialects/openai_chat/* are needed for the implementation.
2. openai_responses lowerResponse cannot silently emit stale output metadata if core text/tool ops no longer match output_meta.
3. multiple openai_responses message output items round-trip without collapsing.
4. annotations/logprobs and item status survive home response round-trip.
5. openai_responses tool_meta is required by default so cross-provider translation halts unless a pass explicitly drops it.
6. openai_chat message_meta is tagged response-only and cannot leak into request bodies through normal translator.toBody.
7. legacy openai_chat.body_field id with required:false is dropped from request bodies, while openai_chat.body_field user still serializes.
8. pause_turn/model_context_window_exceeded throw in openai_chat and openai_responses targets.
9. tests cover the reported blockers without relying on unrelated gemini/realtime files.

report format:
verdict
high-priority findings
medium-priority findings
confirmed ok, keyed to the numbered checks
