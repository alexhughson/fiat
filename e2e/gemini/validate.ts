import {
    readSavedArtifacts,
    validateArtifactFields,
    validationDirFromArgs,
} from "./shared";

const dir = validationDirFromArgs(Bun.argv.slice(2));
const artifacts = await readSavedArtifacts(dir);

for (const artifact of artifacts) {
    const checks = validateArtifactFields(artifact);
    console.log(`ok ${artifact.scenario} ${artifact.model}`);
    for (const check of checks) console.log(`  - ${check}`);
}

console.log(`validated ${artifacts.length} gemini artifacts from ${dir}`);
