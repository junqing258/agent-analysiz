import { argv, cwd, env } from "node:process";
import {
  AgentSession,
  type ModelGateway,
} from "@agent-sdk/core";
import {
  jsonlEventStore,
  localArtifactStore,
  markInterruptedTools,
  recoverSession,
} from "@agent-sdk/storage";
import { loadEnv } from "./env.js";
import { createDiagnosticLogger, isDebugEnabled } from "./debug.js";
import { createModelProvider } from "./providers.js";
import { TerminalChat } from "./tui.js";

interface CliOptions {
  demo: boolean;
  debug: boolean;
  model?: string;
  provider?: string;
  envFile?: string;
  sessionFile: string;
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  if (argv.includes("--help") || argv.includes("-h")) return printHelp();
  const loadedEnv = await loadEnv({
    file: options.envFile,
    startDirectory: env.INIT_CWD ?? cwd(),
  });
  const diagnosticLogger = createDiagnosticLogger(
    options.debug || isDebugEnabled(env.SIMPLE_CHAT_DEBUG),
  );
  const modelProvider = createModelProvider({
    provider: options.provider,
    model: options.model,
    forceDemo: options.demo,
    environment: env,
    diagnosticLogger,
  });
  const gateway: ModelGateway = modelProvider.gateway;
  diagnosticLogger?.("cli.configuration", {
    provider: modelProvider.provider,
    model: modelProvider.model,
    loadedEnv,
    sessionFile: options.sessionFile,
    authConfigured: Boolean(env.ANTHROPIC_AUTH_TOKEN),
  });
  const eventStore = jsonlEventStore(options.sessionFile);
  const recovered = await recoverSession(eventStore);
  await markInterruptedTools(eventStore, recovered);
  const session = new AgentSession({
    model: gateway,
    context: {
      system: "You are a concise, helpful assistant.",
      contextWindowTokens: 100_000,
      maxOutputTokens: 2_000,
    },
    eventStore,
    artifactStore: localArtifactStore(".agent/artifacts"),
    initialMessages: recovered.messages,
  });
  const providerLabel = `${modelProvider.provider}${modelProvider.model ? ` · ${modelProvider.model}` : ""}${loadedEnv ? " · .env loaded" : ""}`;
  await new TerminalChat({
    session,
    providerLabel,
    resumedMessages: recovered.messages.length,
    diagnosticLogger,
  }).start();
}
function parseArgs(args: string[]): CliOptions {
  let model: string | undefined;
  let optionsProvider: string | undefined;
  let envFile: string | undefined;
  let sessionFile = ".agent/sessions/simple-chat.jsonl";
  let demo = false;
  let debug = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--demo") demo = true;
    else if (args[index] === "--debug") debug = true;
    else if (args[index] === "--model")
      model = requireValue(args[++index], "--model");
    else if (args[index] === "--provider")
      optionsProvider = requireValue(args[++index], "--provider");
    else if (args[index] === "--env")
      envFile = requireValue(args[++index], "--env");
    else if (args[index] === "--session")
      sessionFile = requireValue(args[++index], "--session");
    else if (args[index] !== "--help" && args[index] !== "-h")
      throw new Error(`Unknown option: ${args[index]}`);
  }
  return { demo, debug, model, provider: optionsProvider, envFile, sessionFile };
}
function requireValue(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}
function printHelp(): void {
  console.log(`Usage: pnpm simple-chat [--demo] [--debug] [--provider PROVIDER] [--model MODEL] [--env FILE] [--session FILE]

Configuration is loaded from the nearest .env without overwriting shell variables.
Supported providers: anthropic, openai, demo. Use --demo to force offline mode.
Use --debug or SIMPLE_CHAT_DEBUG=1 to print secret-safe diagnostics.

The TUI requires an interactive terminal. Chat commands: /help, /clear, /exit.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
