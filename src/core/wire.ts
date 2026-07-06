// Tiny assertions for parsing untrusted wire payloads. Failures throw with
// context — malformed input halts the pipeline, it never degrades.

import type { ThinkingEffort } from "./ops.js";

export function asRecord(
    value: unknown,
    what: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
            `${what}: expected an object, got ${JSON.stringify(value)}`,
        );
    }
    return value as Record<string, unknown>;
}

export function asArray(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(
            `${what}: expected an array, got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

export function asString(value: unknown, what: string): string {
    if (typeof value !== "string") {
        throw new Error(
            `${what}: expected a string, got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

export function asNumber(value: unknown, what: string): number {
    if (typeof value !== "number") {
        throw new Error(
            `${what}: expected a number, got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

export function asBoolean(value: unknown, what: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(
            `${what}: expected a boolean, got ${JSON.stringify(value)}`,
        );
    }
    return value;
}

export function asStringArray(value: unknown, what: string): string[] {
    return asArray(value, what).map((item, index) =>
        asString(item, `${what}[${index}]`),
    );
}

export function asThinkingEffort(
    value: unknown,
    what: string,
): ThinkingEffort {
    if (
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max"
    ) {
        return value;
    }
    throw new Error(
        `${what}: expected low, medium, high, xhigh, or max, got ${JSON.stringify(value)}`,
    );
}
