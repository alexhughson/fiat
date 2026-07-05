export class LintError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LintError";
    }
}

export function lintOrWarn(strict: boolean | undefined, message: string): void {
    if (strict) throw new LintError(message);
    console.warn(`metamodel: ${message}`);
}
