import { createInterface } from "node:readline/promises";
import { argv, cwd, env, stdin, stdout } from "node:process";
import { AgentSession, type ModelGateway, type TransportEvent } from "@agent-sdk/core";
import { jsonlEventStore, localArtifactStore, markInterruptedTools, recoverSession } from "@agent-sdk/storage";
import { loadEnv } from "./env.js";
import { createModelProvider } from "./providers.js";

interface CliOptions { demo: boolean; model?: string; provider?: string; envFile?: string; sessionFile: string; }

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  if (argv.includes("--help") || argv.includes("-h")) return printHelp();
  const loadedEnv = await loadEnv({ file: options.envFile, startDirectory: env.INIT_CWD ?? cwd() });
  const modelProvider = createModelProvider({ provider: options.provider, model: options.model, forceDemo: options.demo, environment: env });
  const gateway: ModelGateway = modelProvider.gateway;
  console.log(`Provider: ${modelProvider.provider}${modelProvider.model ? ` (${modelProvider.model})` : ""}${loadedEnv ? ` · loaded ${loadedEnv}` : ""}\n`);

  const eventStore = jsonlEventStore(options.sessionFile);
  const recovered = await recoverSession(eventStore);
  await markInterruptedTools(eventStore, recovered);
  const session = new AgentSession({
    model: gateway,
    context: { system: "You are a concise, helpful assistant.", contextWindowTokens: 100_000, maxOutputTokens: 2_000 },
    eventStore,
    artifactStore: localArtifactStore(".agent/artifacts"),
    initialMessages: recovered.messages
  });
  const readline = createInterface({ input: stdin, output: stdout, terminal: true });
  console.log(`Simple Chat — /help for commands, /exit to leave.${recovered.messages.length ? ` Resumed ${recovered.messages.length} message(s).` : ""}\n`);
  try {
    while (true) {
      let answer: string;
      try { answer = await readline.question("you> "); }
      catch (error) {
        if (error instanceof Error && error.message === "readline was closed") break;
        throw error;
      }
      const input = answer.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input === "/help") { printHelp(); continue; }
      await printTurn(session, input);
    }
  } finally { readline.close(); }
}

async function printTurn(session: AgentSession, input: string): Promise<void> {
  let wroteText = false;
  try {
    for await (const event of session.run(input)) {
      if (event.type === "model.text.delta") { if (!wroteText) process.stdout.write("assistant> "); process.stdout.write(event.text); wroteText = true; }
      else printNonTextEvent(event);
    }
  } catch (error) { console.error(`\nerror: ${error instanceof Error ? error.message : "unknown failure"}`); }
  if (wroteText) process.stdout.write("\n\n");
}
function printNonTextEvent(event: Exclude<TransportEvent, { type: "model.text.delta" }>): void {
  if (event.type === "turn.failed") console.error(`\nerror: ${event.error.message}`);
  if (event.type === "turn.interrupted") console.error(`\ninterrupted: ${event.reason}`);
}
function parseArgs(args: string[]): CliOptions {
  let model: string | undefined;
  let optionsProvider: string | undefined;
  let envFile: string | undefined;
  let sessionFile = ".agent/sessions/simple-chat.jsonl";
  let demo = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--demo") demo = true;
    else if (args[index] === "--model") model = requireValue(args[++index], "--model");
    else if (args[index] === "--provider") optionsProvider = requireValue(args[++index], "--provider");
    else if (args[index] === "--env") envFile = requireValue(args[++index], "--env");
    else if (args[index] === "--session") sessionFile = requireValue(args[++index], "--session");
    else if (args[index] !== "--help" && args[index] !== "-h") throw new Error(`Unknown option: ${args[index]}`);
  }
  return { demo, model, provider: optionsProvider, envFile, sessionFile };
}
function requireValue(value: string | undefined, option: string): string { if (!value) throw new Error(`${option} requires a value`); return value; }
function printHelp(): void {
  console.log(`Usage: pnpm simple-chat [--demo] [--provider PROVIDER] [--model MODEL] [--env FILE] [--session FILE]

Configuration is loaded from the nearest .env without overwriting shell variables.
Supported providers: openai, demo. Use --demo to force offline mode.

Chat commands: /help, /exit`);
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
