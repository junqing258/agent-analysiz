import type { ModelGateway } from "@agent-sdk/core";
import {
  AnthropicMessagesGateway,
  OpenAIResponsesGateway,
} from "@agent-sdk/model-gateway";
import type { DiagnosticLogger } from "./debug.js";

export type SupportedModelProvider = "anthropic" | "openai";
export interface ModelProviderOptions {
  provider?: string;
  model?: string;
  environment: Record<string, string | undefined>;
  diagnosticLogger?: DiagnosticLogger;
}
export interface ResolvedModelProvider {
  provider: SupportedModelProvider;
  model?: string;
  gateway: ModelGateway;
}

/** Single provider boundary for the CLI; new vendors add an adapter here, not in UI code. */
export function createModelProvider(options: ModelProviderOptions): ResolvedModelProvider {
  const requested =
    options.provider ??
    options.environment.MODEL_PROVIDER ??
    (options.environment.ANTHROPIC_AUTH_TOKEN
      ? "anthropic"
      : options.environment.OPENAI_API_KEY
        ? "openai"
        : undefined);
  if (!requested)
    throw new Error(
      "No model provider configured. Set MODEL_PROVIDER to anthropic or openai and configure its credentials.",
    );
  if (requested === "anthropic") {
    const baseUrl = options.environment.ANTHROPIC_BASE_URL;
    const authToken = options.environment.ANTHROPIC_AUTH_TOKEN;
    const model = options.model ?? options.environment.ANTHROPIC_MODEL;
    if (!baseUrl || !authToken || !model)
      throw new Error(
        "MODEL_PROVIDER=anthropic requires ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, and ANTHROPIC_MODEL.",
      );
    return {
      provider: "anthropic",
      model,
      gateway: new AnthropicMessagesGateway({
        baseUrl,
        authToken,
        model,
        diagnosticLogger: options.diagnosticLogger,
      }),
    };
  }
  if (requested === "openai") {
    const apiKey = options.environment.OPENAI_API_KEY;
    if (!apiKey) throw new Error("MODEL_PROVIDER=openai requires OPENAI_API_KEY (set it in .env or the shell).");
    const model = options.model ?? options.environment.OPENAI_MODEL ?? options.environment.MODEL ?? "gpt-5.6";
    const base = options.environment.OPENAI_BASE_URL?.replace(/\/+$/, "");
    return {
      provider: "openai",
      model,
      gateway: new OpenAIResponsesGateway({
        apiKey,
        model,
        ...(base ? { endpoint: `${base}/responses` } : {}),
      }),
    };
  }
  throw new Error(`Unsupported MODEL_PROVIDER: ${requested}. Supported providers: anthropic, openai.`);
}
