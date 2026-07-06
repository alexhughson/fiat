import type {
    AudioSource,
    Base64MediaSource,
    DocumentSource,
    ImageSource,
    UrlMediaSource,
    VideoSource,
} from "./ops.js";

export type MediaKind = "image" | "audio" | "document" | "video";

export function imageSourceFromUrl(
    value: string,
    context: string,
): ImageSource {
    if (value.startsWith("data:")) return parseDataUrl(value, context);
    if (/^https?:\/\//.test(value)) return { type: "url", url: value };
    throw new Error(`${context}: expected an http(s) URL or base64 data URL`);
}

export function documentSourceFromUrl(
    value: string,
    context: string,
): DocumentSource {
    if (value.startsWith("data:")) return parseMediaDataUrl(value, context, "document");
    if (/^https?:\/\//.test(value)) return { type: "url", url: value };
    throw new Error(`${context}: expected an http(s) URL or base64 data URL`);
}

export function parseDataUrl(value: string, context: string): ImageSource {
    return parseMediaDataUrl(value, context, "image");
}

export function parseMediaDataUrl(
    value: string,
    context: string,
    kind: MediaKind,
): Base64MediaSource {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/.exec(value);
    if (!match) {
        throw new Error(
            `${context}: expected a data:<media-type>;base64,<data> URL`,
        );
    }
    const mediaType = match[1]!;
    if (kind === "image" && mediaKindForType(mediaType) !== "image") {
        throw new Error(`${context}: expected an image/* data URL`);
    }
    assertMediaType(kind, mediaType, context);
    return { type: "base64", mediaType, data: match[2]! };
}

export function dataUrlFromBase64(source: {
    mediaType: string;
    data: string;
}): string {
    assertImageMediaType(source.mediaType, "llm.image base64 source");
    return `data:${source.mediaType};base64,${source.data}`;
}

export function mediaDataUrlFromBase64(
    source: Base64MediaSource,
    kind: MediaKind,
    context: string,
): string {
    assertMediaType(kind, source.mediaType, context);
    return `data:${source.mediaType};base64,${source.data}`;
}

export function assertImageMediaType(mediaType: string, context: string): void {
    assertMediaType("image", mediaType, context);
}

export function assertAudioSource(source: AudioSource, context: string): void {
    assertMediaType("audio", source.mediaType, context);
}

export function assertDocumentSource(
    source: DocumentSource,
    context: string,
): void {
    if (source.type === "base64" && !source.data) {
        throw new Error(`${context}: expected non-empty base64 data`);
    }
    if (source.mediaType != null) assertMediaType("document", source.mediaType, context);
}

export function assertVideoSource(source: VideoSource, context: string): void {
    assertMediaType("video", source.mediaType, context);
}

export function mediaKindForType(mediaType: string): MediaKind | undefined {
    if (mediaType.startsWith("image/")) return "image";
    if (mediaType.startsWith("audio/")) return "audio";
    if (mediaType === "application/pdf") return "document";
    if (mediaType.startsWith("video/")) return "video";
    return undefined;
}

export function assertMediaType(
    kind: MediaKind,
    mediaType: string,
    context: string,
): void {
    if (mediaKindForType(mediaType) !== kind) {
        throw new Error(`${context}: expected ${expectedMediaType(kind)} media type`);
    }
}

export function base64Source(
    mediaType: string,
    data: string,
    kind: MediaKind,
    context: string,
    filename?: string,
): Base64MediaSource {
    assertMediaType(kind, mediaType, context);
    return {
        type: "base64",
        mediaType,
        data,
        ...(filename ? { filename } : {}),
    };
}

export function urlSource(
    url: string,
    context: string,
    mediaType?: string,
    filename?: string,
): UrlMediaSource {
    if (!/^https?:\/\//.test(url)) {
        throw new Error(`${context}: expected an http(s) URL`);
    }
    if (mediaType != null) assertMediaType("document", mediaType, context);
    return { type: "url", url, ...(mediaType ? { mediaType } : {}), ...(filename ? { filename } : {}) };
}

function expectedMediaType(kind: MediaKind): string {
    switch (kind) {
        case "image":
            return "image/*";
        case "audio":
            return "audio/*";
        case "document":
            return "application/pdf";
        case "video":
            return "video/*";
    }
}
