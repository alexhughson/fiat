import {
    fixtureDirFromArgs,
    readFixtureArtifacts,
    validateArtifact,
} from "./shared";

const dir = fixtureDirFromArgs(Bun.argv.slice(2));
const artifacts = await readFixtureArtifacts(dir);

let failures = 0;

for (const artifact of artifacts) {
    try {
        const validated = validateArtifact(artifact);
        console.log(`ok ${validated.scenario} ${validated.model}`);
        for (const check of validated.checks) console.log(`  - ${check}`);
    } catch (error) {
        failures += 1;
        console.error(`not ok ${artifact.scenario} ${artifact.model}`);
        console.error(`  ${errorMessage(error)}`);
    }
}

if (failures > 0) {
    throw new Error(
        `anthropic fixture validation failed: ${failures}/${artifacts.length}`,
    );
}

console.log(`validated ${artifacts.length} anthropic fixtures from ${dir}`);

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
