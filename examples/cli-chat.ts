import {
    createCliRenderer,
    InputRenderableEvents,
    BoxRenderable,
    type InputRenderable,
    InputRenderable as OpenTuiInputRenderable,
    type ScrollBoxRenderable,
    ScrollBoxRenderable as OpenTuiScrollBoxRenderable,
    TextRenderable,
} from "@opentui/core";
import {
    AnthropicTranslator,
    GeminiTranslator,
    OpenAIChatTranslator,
    type Program,
    type Translator,
} from "../src/index";

type ProviderName = "openai" | "anthropic" | "gemini";

interface Provider {
    name: ProviderName;
    label: string;
    defaultModel: string;
    apiKeyEnv: string;
    translator: Translator;
    call(body: unknown): Promise<unknown>;
}

interface State {
    provider: ProviderName;
    model: string;
    maxOutputTokens: number;
    transcript: Program;
    status: string;
    busy: boolean;
}

const providers: Record<ProviderName, Provider> = {
    openai: {
        name: "openai",
        label: "OpenAI Chat",
        defaultModel: "gpt-4o-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        translator: OpenAIChatTranslator,
        call: callOpenAI,
    },
    anthropic: {
        name: "anthropic",
        label: "Anthropic Messages",
        defaultModel: "claude-haiku-4-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        translator: AnthropicTranslator,
        call: callAnthropic,
    },
    gemini: {
        name: "gemini",
        label: "Gemini",
        defaultModel: "models/gemini-3.5-flash",
        apiKeyEnv: "GEMINI_API_KEY",
        translator: GeminiTranslator,
        call: callGemini,
    },
};

const state: State = {
    provider: "openai",
    model: providers.openai.defaultModel,
    maxOutputTokens: 512,
    transcript: [],
    status: "type /help for commands",
    busy: false,
};

if (process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
}

if (process.argv.includes("--self-test")) {
    runSelfTest();
    process.exit(0);
}

if (process.argv.includes("--check-target-override")) {
    runTargetOverrideCheck();
    process.exit(0);
}

const checkCommandsIndex = process.argv.indexOf("--check-commands");
if (checkCommandsIndex >= 0) {
    runCommandCheck(process.argv.slice(checkCommandsIndex + 1));
    process.exit(0);
}

const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
});

const chatPane = new OpenTuiScrollBoxRenderable(renderer, {
    id: "chat-pane",
    title: "chat",
    border: true,
    borderStyle: "rounded",
    width: "50%",
    height: "100%",
    paddingX: 1,
    stickyScroll: true,
    stickyStart: "bottom",
});
const irPane = new OpenTuiScrollBoxRenderable(renderer, {
    id: "ir-pane",
    title: "core ir",
    border: true,
    borderStyle: "rounded",
    width: "50%",
    height: "100%",
    paddingX: 1,
    stickyScroll: true,
    stickyStart: "bottom",
});
const statusLine = new TextRenderable(renderer, {
    id: "status",
    content: "",
    height: 1,
    fg: "#8FB3FF",
});
const input = new OpenTuiInputRenderable(renderer, {
    id: "input",
    placeholder: "message or /command",
    width: "100%",
    maxLength: 8_000,
    backgroundColor: "#111111",
    focusedBackgroundColor: "#1A1A1A",
    textColor: "#FFFFFF",
    cursorColor: "#8FB3FF",
});

const layout = new BoxRenderable(renderer, {
    id: "layout",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    padding: 1,
    gap: 1,
});
const panes = new BoxRenderable(renderer, {
    id: "panes",
    flexDirection: "row",
    width: "100%",
    flexGrow: 1,
    gap: 1,
});
panes.add(chatPane);
panes.add(irPane);
layout.add(statusLine);
layout.add(panes);
layout.add(input);
renderer.root.add(layout);

input.on(InputRenderableEvents.ENTER, async (value: string) => {
    const text = value.trim();
    if (state.busy) {
        state.status = "request already in flight";
        redraw();
        return;
    }
    input.value = "";
    if (text.length === 0) return;
    await handleInput(text, input);
});

input.focus();
redraw();

async function handleInput(text: string, inputBox: InputRenderable) {
    try {
        if (text.startsWith("/")) {
            handleCommand(text);
            redraw();
            return;
        }

        state.transcript.push({ op: "llm.text", role: "user", content: text });
        state.busy = true;
        state.status = `sending to ${state.provider}:${state.model}`;
        inputBox.placeholder = "waiting for provider response";
        redraw();

        const provider = providers[state.provider];
        requireApiKey(provider);
        const requestProgram = requestProgramForCurrentTarget();
        const body = provider.translator.toBody(requestProgram);
        const response = await provider.call(body);
        state.transcript.push(...provider.translator.fromResponse(response));
        state.status = `received ${provider.name} response`;
    } catch (error) {
        state.status = error instanceof Error ? error.message : String(error);
    } finally {
        state.busy = false;
        inputBox.placeholder = "message or /command";
        inputBox.focus();
        redraw();
    }
}

function handleCommand(line: string) {
    const [command, ...args] = line.slice(1).split(/\s+/);
    switch (command) {
        case "help":
            state.status =
                "/provider openai|anthropic|gemini  /model <id>  /target <provider> <model>  /max <n>  /clear  /quit";
            return;
        case "provider":
            setProvider(args[0]);
            return;
        case "model":
            setModel(args.join(" "));
            return;
        case "target":
            setTarget(args[0], args.slice(1).join(" "));
            return;
        case "max":
            setMaxOutputTokens(args[0]);
            return;
        case "clear":
            state.transcript = [];
            state.status = "cleared transcript";
            return;
        case "quit":
        case "exit":
            renderer.destroy();
            process.exit(0);
        default:
            throw new Error(`unknown command: /${command}`);
    }
}

function setProvider(value: string | undefined) {
    if (!isProviderName(value)) {
        throw new Error("provider must be openai, anthropic, or gemini");
    }
    state.provider = value;
    state.model = providers[value].defaultModel;
    state.status = `provider set to ${value}; model reset to ${state.model}`;
}

function setTarget(provider: string | undefined, model: string) {
    if (!isProviderName(provider)) {
        throw new Error("provider must be openai, anthropic, or gemini");
    }
    if (model.length === 0) throw new Error("model is required");
    state.provider = provider;
    state.model = model;
    state.status = `target set to ${provider}:${model}`;
}

function setModel(model: string) {
    if (model.length === 0) throw new Error("model is required");
    state.model = model;
    state.status = `model set to ${model}`;
}

function setMaxOutputTokens(value: string | undefined) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("max must be a positive integer");
    }
    state.maxOutputTokens = parsed;
    state.status = `max output tokens set to ${parsed}`;
}

function requestProgramForCurrentTarget(): Program {
    return [
        { op: "llm.model", model: state.model },
        { op: "llm.max_output_tokens", value: state.maxOutputTokens },
        ...state.transcript.filter(
            (op) => op.op !== "llm.model" && op.op !== "llm.max_output_tokens",
        ),
    ];
}

function redraw() {
    const provider = providers[state.provider];
    statusLine.content = `${provider.label} | ${state.model} | ops ${state.transcript.length} | ${state.status}`;
    const paneTextWidth = Math.max(20, Math.floor(renderer.width / 2) - 8);
    replaceRows(chatPane, chatRows(), paneTextWidth);
    replaceRows(
        irPane,
        JSON.stringify(requestProgramForCurrentTarget(), null, 2).split("\n"),
        paneTextWidth,
    );
    renderer.requestRender();
}

function chatRows(): string[] {
    if (state.transcript.length === 0) {
        return [
            "send a message to append user text to core ir",
            "switch targets with /target anthropic claude-haiku-4-5",
        ];
    }
    return state.transcript.flatMap((op) => {
        if (op.op === "llm.text") return [`${op.role}> ${op.content}`];
        if (op.op === "llm.tool_call") {
            return [`tool_call> ${op.name} ${JSON.stringify(op.arguments)}`];
        }
        if (op.op === "llm.tool_result") return [`tool_result> ${op.content}`];
        if (op.op === "response.usage") {
            return [
                `usage> in=${op.inputTokens ?? "?"} out=${op.outputTokens ?? "?"}`,
            ];
        }
        if (op.op === "response.stop") return [`stop> ${op.reason}`];
        if (!op.op.startsWith("llm.") && !op.op.startsWith("response.")) {
            return [`residual> ${JSON.stringify(op)}`];
        }
        return [];
    });
}

function replaceRows(pane: ScrollBoxRenderable, rows: string[], width: number) {
    for (const child of pane.getChildren()) pane.remove(child);
    for (const row of rows.flatMap((value) => wrap(value, width))) {
        pane.add(new TextRenderable(renderer, { content: row, width: "100%" }));
    }
}

function wrap(text: string, width: number): string[] {
    if (text.length <= width) return [text];
    const rows: string[] = [];
    for (let start = 0; start < text.length; start += width) {
        rows.push(text.slice(start, start + width));
    }
    return rows;
}

function requireApiKey(provider: Provider) {
    if (!process.env[provider.apiKeyEnv]) {
        throw new Error(
            `${provider.apiKeyEnv} is required for ${provider.name}`,
        );
    }
}

async function callOpenAI(body: unknown): Promise<unknown> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    return res.json();
}

async function callAnthropic(body: unknown): Promise<unknown> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    return res.json();
}

async function callGemini(body: unknown): Promise<unknown> {
    const request = body as { model?: unknown; [key: string]: unknown };
    const model = String(request.model);
    const { model: _model, ...generateContentBody } = request;
    const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(generateContentBody),
        },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
    return { model, ...(await res.json()) };
}

function isProviderName(value: string | undefined): value is ProviderName {
    return value === "openai" || value === "anthropic" || value === "gemini";
}

function printHelp() {
    console.log(`metamodel cli chat

run:
  bun run example:cli-chat

commands:
  /provider openai|anthropic|gemini
  /model <model-id>
  /target <provider> <model-id>
  /max <positive-integer>
  /clear
  /quit

env:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY`);
}

function runSelfTest() {
    handleCommand("/target gemini models/gemini-3.5-flash");
    state.transcript.push({ op: "llm.text", role: "user", content: "ping" });
    const program = requestProgramForCurrentTarget();
    if (program[0]?.op !== "llm.model" || program[0].model !== state.model) {
        throw new Error("self-test failed: model op not first");
    }
    if (program.at(-1)?.op !== "llm.text") {
        throw new Error("self-test failed: transcript not appended");
    }
    console.log(JSON.stringify(program, null, 2));
}

function runTargetOverrideCheck() {
    state.transcript.push(
        { op: "llm.text", role: "user", content: "first" },
        { op: "llm.model", model: "old-provider-response-model" },
        { op: "llm.text", role: "assistant", content: "second" },
    );
    handleCommand("/target anthropic claude-haiku-4-5");
    const program = requestProgramForCurrentTarget();
    if (program[0]?.op !== "llm.model" || program[0].model !== state.model) {
        throw new Error("target override check failed: selected model lost");
    }
    if (program.some((op, index) => index > 0 && op.op === "llm.model")) {
        throw new Error("target override check failed: stale model survived");
    }
    console.log(JSON.stringify(program, null, 2));
}

function runCommandCheck(commands: string[]) {
    for (const command of groupCommands(commands)) handleCommand(command);
    console.log(
        JSON.stringify(
            {
                provider: state.provider,
                model: state.model,
                maxOutputTokens: state.maxOutputTokens,
                ops: state.transcript.length,
                status: state.status,
            },
            null,
            2,
        ),
    );
}

function groupCommands(args: string[]): string[] {
    const commands: string[] = [];
    for (const arg of args) {
        if (arg.startsWith("/")) {
            commands.push(arg);
            continue;
        }
        if (commands.length === 0) {
            throw new Error(
                `command check argument must follow a slash command: ${arg}`,
            );
        }
        commands[commands.length - 1] += ` ${arg}`;
    }
    return commands;
}
