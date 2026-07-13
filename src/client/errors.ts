export const ERROR_BODY_EXCERPT_MAX = 800;

export interface ProviderRequestErrorOptions {
    status: number;
    dialect: string;
    bodyExcerpt: string;
    headers: Record<string, string>;
}

export class ProviderRequestError extends Error {
    readonly status: number;
    readonly dialect: string;
    readonly bodyExcerpt: string;
    readonly headers: Record<string, string>;

    constructor(options: ProviderRequestErrorOptions) {
        const excerpt =
            options.bodyExcerpt.trim().length === 0
                ? ""
                : ` ${options.bodyExcerpt.trim().slice(0, ERROR_BODY_EXCERPT_MAX)}`;
        super(
            `Provider request failed: HTTP ${options.status}${excerpt}`,
        );
        this.name = "ProviderRequestError";
        this.status = options.status;
        this.dialect = options.dialect;
        this.bodyExcerpt = options.bodyExcerpt.trim().slice(
            0,
            ERROR_BODY_EXCERPT_MAX,
        );
        this.headers = options.headers;
    }
}

export async function providerRequestErrorFromResponse(
    response: Response,
    dialect: string,
): Promise<ProviderRequestError> {
    const bodyExcerpt = await response.text().catch(() => "");
    return new ProviderRequestError({
        status: response.status,
        dialect,
        bodyExcerpt,
        headers: headersToRecord(response.headers),
    });
}

export function headersToRecord(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
        out[key] = value;
    });
    return out;
}
