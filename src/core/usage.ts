// Shared arithmetic for the token-count parts of response.usage. Core holds
// the parts; each provider's wire holds its own totals, so every raise
// subtracts the details a body reports inside a total, and every lowering
// sums the parts back into the totals its provider requires.

import { LintError } from "./lint.js";
import type { OpOf } from "./ops.js";

export type UsageCounts = Omit<OpOf<"response.usage">, "op">;

export type UsagePart = keyof UsageCounts;

export const ALL_PARTS: UsagePart[] = [
    "inputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "toolUsePromptTokens",
    "outputTokens",
    "reasoningTokens",
];

// Sum of the parts that are present, in the order named. An absent part adds
// nothing: a count the source body did not report is unknown, not zero. No
// part present gives undefined, so a caller can omit an optional wire field.
export function sumParts(
    counts: UsageCounts,
    parts: UsagePart[],
): number | undefined {
    let total: number | undefined = undefined;
    for (const part of parts) {
        const value = counts[part];
        if (value != null) total = (total ?? 0) + value;
    }
    return total;
}

// Sum of the parts that are present, or 0 with a warning when no part is
// present. For a wire field the target schema requires as a plain number:
// the source body reported no count for it, and failing the call would block
// a program whose source dialect reports fewer parts (a proxy routing a
// Gemini answer to a Responses client), so the lowering writes 0 and the
// warning names the field.
export function sumOrZero(
    counts: UsageCounts,
    parts: UsagePart[],
    field: string,
    context: string,
): number {
    const total = sumParts(counts, parts);
    if (total == null) {
        const names = parts
            .map((part) => `response.usage.${part}`)
            .join(" or ");
        console.warn(
            `metamodel: ${context}: the source reported no count for ${field} (${names}); the wire field requires a number, so the lowering writes 0`,
        );
        return 0;
    }
    return total;
}

// A detail count a body reports inside a total, subtracted from that total.
// A detail larger than the total it sits in (or two details that together
// exceed it) is a body the provider's own reference rules out, so this fails
// rather than write a negative part.
export function totalMinusDetails(
    total: number,
    details: { field: string; value: number }[],
    totalField: string,
    context: string,
): number {
    let rest = total;
    for (const { field, value } of details) {
        if (value > rest) {
            throw new LintError(
                `${context}: ${field} ${value} exceeds the remaining ${totalField} ${rest} (total ${total}), and a detail larger than its total is a body the provider's reference rules out`,
            );
        }
        rest -= value;
    }
    return rest;
}

// A body total is a sum of the parts; the raise warns when the body's own
// total disagrees with the sum computed from the parts, naming both numbers.
// The parts win: no param holds a total, and each lowering recomputes it.
export function warnTotalMismatch(
    dialect: string,
    totalField: string,
    wireTotal: number,
    computedTotal: number,
): void {
    console.warn(
        `metamodel: ${dialect} usage ${totalField} ${wireTotal} disagrees with the sum of the parts ${computedTotal}; the parts win and each lowering recomputes the total`,
    );
}

// A copy of `record` without `keys`, or undefined when nothing remains, so a
// raise shrinks a wire usage object to the fields core does not model.
export function withoutKeys(
    record: Record<string, unknown>,
    keys: string[],
): Record<string, unknown> | undefined {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (!keys.includes(key)) rest[key] = value;
    }
    return Object.keys(rest).length > 0 ? rest : undefined;
}

// Shrinks a wire usage object to the fields core does not model: `keys` are
// removed from the top level, and each name in `details` selects a nested
// object whose listed keys are removed. A nested object left with no keys is
// dropped, and undefined comes back when nothing remains.
export function shrinkUsage(
    wireUsage: Record<string, unknown>,
    keys: string[],
    details: Record<string, string[]>,
): Record<string, unknown> | undefined {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(wireUsage)) {
        if (keys.includes(key)) continue;
        const detailKeys = details[key];
        if (detailKeys == null || !isRecord(value)) {
            rest[key] = value;
            continue;
        }
        const nested = withoutKeys(value, detailKeys);
        if (nested) rest[key] = nested;
    }
    return Object.keys(rest).length > 0 ? rest : undefined;
}

// Merges the usage objects of several dialect usage ops into one wire usage
// object: `from`'s keys win over `into`'s, except the details objects named in
// `detailsKeys`, whose keys merge key-wise so the counts computed from core
// parts and the vendor fields kept in a residual survive together.
export function mergeUsageObjects(
    into: Record<string, unknown>,
    from: Record<string, unknown>,
    detailsKeys: string[],
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...into };
    for (const [key, value] of Object.entries(from)) {
        if (!detailsKeys.includes(key) || !isRecord(value)) {
            merged[key] = value;
            continue;
        }
        const previous = merged[key];
        merged[key] = {
            ...(isRecord(previous) ? previous : {}),
            ...value,
        };
    }
    return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
