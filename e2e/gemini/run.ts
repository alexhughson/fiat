import {
    artifactFromResponse,
    assertRequestedModelsAvailable,
    bodyFromProgram,
    buildMultimodalToolProgram,
    buildTextProgram,
    callGeminiGenerateContent,
    listGenerateContentModels,
    modelsFromArgs,
    outputDirFromArgs,
    validateArtifactFields,
    validateMultimodalToolRequestBody,
    validateTextRequestBody,
    writeArtifact,
    writeManifest,
} from "./shared";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is required");

const args = Bun.argv.slice(2);
const models = modelsFromArgs(args);
const outDir = outputDirFromArgs(args);

console.log(`gemini e2e models: ${models.join(", ")}`);
console.log(`saving artifacts: ${outDir}`);

const availableModels = await listGenerateContentModels(apiKey);
assertRequestedModelsAvailable(models, availableModels);

const artifactFiles: string[] = [];

for (const model of models) {
    const textProgram = buildTextProgram(model);
    const textBody = bodyFromProgram(textProgram);
    validateTextRequestBody(textBody, model);
    const textResponse = await callGeminiGenerateContent(apiKey, textBody);
    const textArtifact = artifactFromResponse(
        "text",
        model,
        textProgram,
        textBody,
        textResponse,
    );
    validateArtifactFields(textArtifact);
    artifactFiles.push(await writeArtifact(outDir, textArtifact));
    console.log(`ok text ${model} ${textArtifact.durationMs}ms`);

    const toolProgram = buildMultimodalToolProgram(model);
    const toolBody = bodyFromProgram(toolProgram);
    validateMultimodalToolRequestBody(toolBody, model);
    const toolResponse = await callGeminiGenerateContent(apiKey, toolBody);
    const toolArtifact = artifactFromResponse(
        "multimodal-tool",
        model,
        toolProgram,
        toolBody,
        toolResponse,
    );
    validateArtifactFields(toolArtifact);
    artifactFiles.push(await writeArtifact(outDir, toolArtifact));
    console.log(`ok multimodal-tool ${model} ${toolArtifact.durationMs}ms`);
}

await writeManifest(outDir, {
    generatedAt: new Date().toISOString(),
    models,
    artifacts: artifactFiles.sort(),
});

console.log(`ok manifest ${outDir}/manifest.json`);
