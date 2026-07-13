import type { Program } from "../core/ops.js";
import { firstOp } from "../core/program.js";
import type { Translator } from "../core/translator.js";
import {
    headersToRecord,
    providerRequestErrorFromResponse,
} from "./errors.js";
import { isClientDialect, resolveEndpoint } from "./endpoints.js";
import { parseSseData } from "./sse.js";
import type {
    ClientRequestMeta,
    ClientRequestOptions,
    CompleteResponseOptions,
    StreamResponseOptions,
} from "./types.js";

function assertApiKey(apiKey: string, dialect: string): void {
    if (apiKey.trim().length === 0) {
        throw new Error(`No API key for dialect: ${dialect}`);
    }
}

function requireModel(program: Program, dialect: string): string {
    const model = firstOp(program, "llm.model")?.model;
    if (!model) {
        throw new Error(`${dialect} client request: program has no llm.model op`);
    }
    return model;
}

function buildMeta(
    dialect: string,
    model: string,
    baseUrl: string,
    stream: boolean,
): ClientRequestMeta {
    return { dialect, model, baseUrl, stream };
}

function buildRequestBody(
    translator: Translator,
    program: Program,
    stream: boolean,
    options: ClientRequestOptions,
): unknown {
    return translator.toBody(program, {
        strict: options.strict ?? true,
        variant: options.variant,
        stream,
        omitModel: translator.name === "gemini",
    });
}

function mergeHeaders(
    endpointHeaders: Record<string, string>,
    stream: boolean,
    callerHeaders: Record<string, string> | undefined,
): Record<string, string> {
    return {
        "content-type": "application/json",
        accept: stream ? "text/event-stream" : "application/json",
        ...endpointHeaders,
        ...callerHeaders,
    };
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be an object.`);
    }
    return parsed as Record<string, unknown>;
}

async function postRequest(
    translator: Translator,
    program: Program,
    options: ClientRequestOptions,
    stream: boolean,
): Promise<Response> {
    const dialect = translator.name;
    if (!isClientDialect(dialect)) {
        throw new Error(`client: unsupported dialect "${dialect}"`);
    }

    assertApiKey(options.apiKey, dialect);
    const model = requireModel(program, dialect);
    const meta = buildMeta(dialect, model, options.baseUrl, stream);

    let body = buildRequestBody(translator, program, stream, options);
    const replaced = options.onPayload?.(body, meta);
    if (replaced !== undefined) {
        body = replaced;
    }

    const endpoint = resolveEndpoint({
        dialect,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model,
        stream,
    });
    const fetchFn = options.fetch ?? fetch;
    const response = await fetchFn(endpoint.url, {
        body: JSON.stringify(body),
        headers: mergeHeaders(endpoint.headers, stream, options.headers),
        keepalive: true,
        method: "POST",
        signal: options.signal,
    });

    await options.onResponse?.(
        {
            status: response.status,
            headers: headersToRecord(response.headers),
        },
        meta,
    );

    if (!response.ok) {
        throw await providerRequestErrorFromResponse(response, dialect);
    }

    return response;
}

/**
 * Stream a provider response as raised core programs from SSE events.
 *
 * Sends exactly what the program lowers to via `translator.toBody` — no hidden
 * defaults. For `openai_responses`, callers that need `store: false` must
 * include `{ op: "request.store", value: false }` in the program (clutch's old
 * client always sent `store: false`; migrating callers must add the op).
 */
export async function* streamResponse(
    translator: Translator,
    program: Program,
    options: StreamResponseOptions,
): AsyncGenerator<Program> {
    const response = await postRequest(
        translator,
        program,
        options,
        options.stream ?? true,
    );

    for await (const event of parseSseData(response, options.signal)) {
        if (event === "[DONE]") {
            continue;
        }
        const parsed = parseJsonObject(event, `${translator.name} stream event`);
        const raised = translator.fromStreamResponse(parsed);
        if (raised.length > 0) {
            yield raised;
        }
    }

    if (options.signal?.aborted === true) {
        throw new Error("Request was aborted");
    }
}

/**
 * Complete a non-streaming provider response as a raised core program.
 *
 * Sends exactly what the program lowers to via `translator.toBody` — no hidden
 * defaults. For `openai_responses`, callers that need `store: false` must
 * include `{ op: "request.store", value: false }` in the program (clutch's old
 * client always sent `store: false`; migrating callers must add the op).
 */
export async function completeResponse(
    translator: Translator,
    program: Program,
    options: CompleteResponseOptions,
): Promise<Program> {
    const response = await postRequest(translator, program, options, false);
    return translator.fromResponse(await response.json());
}
