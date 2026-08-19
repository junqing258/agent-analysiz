import type {
  AgentMessage,
  ModelDelta,
  ModelGateway,
  ModelRequest,
  TokenEstimate,
  TokenEstimateInput,
} from "@agent-sdk/core";
import type { DiagnosticLogger } from "./debug.js";

export interface AnthropicMessagesGatewayOptions {
  baseUrl: string;
  authToken: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  diagnosticLogger?: DiagnosticLogger;
}

/** Text-only Anthropic Messages API adapter using the normalized SDK stream contract. */
export class AnthropicMessagesGateway implements ModelGateway {
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: AnthropicMessagesGatewayOptions) {
    this.endpoint = messagesEndpoint(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelDelta> {
    if (request.tools.length > 0)
      throw new Error(
        "AnthropicMessagesGateway in simple-chat supports text-only sessions; configure no tools.",
      );
    const { system, messages } = toAnthropicInput(request.messages);
    const body = {
      model: this.options.model,
      max_tokens: request.maxOutputTokens ?? 2_000,
      stream: true,
      ...(system ? { system } : {}),
      messages,
    };
    this.log("anthropic.request.started", {
      endpoint: this.endpoint,
      model: this.options.model,
      messageCount: messages.length,
      systemChars: system?.length ?? 0,
      maxTokens: body.max_tokens,
    });
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        signal: options.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.authToken,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.log("anthropic.request.transport_error", {
        message: error instanceof Error ? error.message : "unknown transport error",
      });
      throw error;
    }
    this.log("anthropic.response.received", {
      status: response.status,
      ok: response.ok,
      requestId:
        response.headers.get("request-id") ??
        response.headers.get("x-request-id") ??
        undefined,
      contentType: response.headers.get("content-type") ?? undefined,
    });
    if (!response.ok) {
      const errorBody = await response.text();
      this.log("anthropic.response.error", {
        status: response.status,
        bodyChars: errorBody.length,
      });
      throw new Error(`Anthropic Messages API ${response.status}: ${errorBody}`);
    }
    if (!response.body)
      throw new Error("Anthropic Messages API returned no streaming body");
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finish: "stop" | "length" = "stop";
    for await (const event of parseSse(response.body, options.signal)) {
      this.log("anthropic.stream.event", {
        type: typeof event.type === "string" ? event.type : "unknown",
      });
      if (event.type === "content_block_delta") {
        const delta = asRecord(event.delta);
        if (delta.type === "text_delta" && typeof delta.text === "string")
          yield { type: "text-delta", text: delta.text };
      } else if (event.type === "message_start") {
        const usage = asRecord(asRecord(event.message).usage);
        if (typeof usage.input_tokens === "number")
          inputTokens = usage.input_tokens;
      } else if (event.type === "message_delta") {
        const delta = asRecord(event.delta);
        const usage = asRecord(event.usage);
        if (typeof usage.output_tokens === "number")
          outputTokens = usage.output_tokens;
        if (
          delta.stop_reason === "max_tokens" ||
          delta.stop_reason === "model_context_window_exceeded"
        )
          finish = "length";
      } else if (event.type === "error") throw new Error(readError(event));
    }
    if (inputTokens !== undefined && outputTokens !== undefined)
      yield { type: "usage", inputTokens, outputTokens };
    this.log("anthropic.stream.finished", {
      finish,
      inputTokens,
      outputTokens,
    });
    yield { type: "finish", reason: finish };
  }
  async estimateTokens(input: TokenEstimateInput): Promise<TokenEstimate> {
    return {
      tokens: Math.ceil(JSON.stringify(input).length / 4),
      source: "heuristic",
    };
  }
  private log(stage: string, details: Record<string, unknown>): void {
    this.options.diagnosticLogger?.(stage, details);
  }
}

function toAnthropicInput(messages: AgentMessage[]): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .flatMap(textContent)
    .join("\n\n");
  return {
    ...(system ? { system } : {}),
    messages: messages
      .filter(
        (message): message is AgentMessage & { role: "user" | "assistant" } =>
          message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({
        role: message.role,
        content: textContent(message),
      })),
  };
}
function textContent(message: AgentMessage): string {
  return message.content
    .filter(
      (content): content is Extract<typeof content, { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
}
function messagesEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1/messages")) return base;
  if (base.endsWith("/v1")) return `${base}/messages`;
  return `${base}/v1/messages`;
}
async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      if (done && buffer.trim()) {
        frames.push(buffer);
        buffer = "";
      }
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const parsed: unknown = JSON.parse(data);
        if (isRecord(parsed)) yield parsed;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function readError(event: Record<string, unknown>): string {
  const error = asRecord(event.error);
  return typeof error.message === "string"
    ? error.message
    : "Anthropic Messages API stream error";
}
