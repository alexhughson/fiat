import {
    artifactFromResponse,
    callRealtimeWebSocket,
    modelsFromArgs,
    outputDirFromArgs,
    requestBodyFromSource,
    sourceRequestBody,
    writeArtifact,
    writeManifest,
    type ScenarioName,
} from "./shared";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const args = Bun.argv.slice(2);
const models = modelsFromArgs(args);
const outDir = outputDirFromArgs(args);
const scenarios: ScenarioName[] = ["text", "tool"];

console.log(`openai realtime e2e models: ${models.join(", ")}`);
console.log(`saving artifacts: ${outDir}`);

const artifactFiles: string[] = [];

for (const model of models) {
    for (const scenario of scenarios) {
        const source = sourceRequestBody(scenario, model);
        const requestBody = requestBodyFromSource(source);
        const response = await callRealtimeWebSocket(apiKey, requestBody);
        const artifact = artifactFromResponse(
            scenario,
            model,
            source,
            requestBody,
            response.events,
            response.durationMs,
        );
        artifactFiles.push(await writeArtifact(outDir, artifact));
        console.log(`ok ${scenario} ${model} ${artifact.durationMs}ms`);
    }
}

await writeManifest(outDir, {
    generatedAt: new Date().toISOString(),
    models,
    artifacts: artifactFiles.sort(),
});

console.log(`ok manifest ${outDir}/manifest.json`);
