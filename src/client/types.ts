import type { TargetVariant } from "../core/rewrite.js";

export interface ClientRequestMeta {
    dialect: string;
    model: string;
    stream: boolean;
    baseUrl: string;
}

export interface ClientRequestOptions {
    apiKey: string;
    baseUrl: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    strict?: boolean;
    variant?: TargetVariant;
    fetch?: typeof fetch;
    onPayload?: (
        body: unknown,
        meta: ClientRequestMeta,
    ) => unknown | undefined;
    onResponse?: (
        response: { status: number; headers: Record<string, string> },
        meta: ClientRequestMeta,
    ) => void | Promise<void>;
}

export interface StreamResponseOptions extends ClientRequestOptions {
    stream?: true;
}

export interface CompleteResponseOptions extends ClientRequestOptions {
    stream?: false;
}
