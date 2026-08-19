import type { ModelGateway } from "@agent-sdk/core";
import { DemoGateway } from "./demo-gateway.js";
import { OpenAIResponsesGateway } from "./openai-responses-gateway.js";

export type SupportedModelProvider = "demo" | "openai";
export interface ModelProviderOptions { provider?: string; model?: string; forceDemo?: boolean; environment: Record<string, string | undefined>; }
export interface ResolvedModelProvider { provider: SupportedModelProvider; model?: string; gateway: ModelGateway; }

/** Single provider boundary for the CLI; new vendors add an adapter here, not in UI code. */
export function createModelProvider(options: ModelProviderOptions): ResolvedModelProvider {
  const requested = options.forceDemo ? "demo" : options.provider ?? options.environment.MODEL_PROVIDER ?? (options.environment.OPENAI_API_KEY ? "openai" : "demo");
  if (requested === "demo") return { provider: "demo", gateway: new DemoGateway() };
  if (requested === "openai") {
    const apiKey = options.environment.OPENAI_API_KEY;
    if (!apiKey) throw new Error("MODEL_PROVIDER=openai requires OPENAI_API_KEY (set it in .env or the shell).");
    const model = options.model ?? options.environment.OPENAI_MODEL ?? options.environment.MODEL ?? "gpt-5.6";
    const base = options.environment.OPENAI_BASE_URL?.replace(/\/+$/, "");
    return { provider: "openai", model, gateway: new OpenAIResponsesGateway({ apiKey, model, ...(base ? { endpoint: `${base}/responses` } : {}) }) };
  }
  throw new Error(`Unsupported MODEL_PROVIDER: ${requested}. Supported providers: openai, demo.`);
}
