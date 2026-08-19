import type {
  AgentMessage,
  ModelDelta,
  ModelGateway,
  ModelRequest,
  TokenEstimate,
  TokenEstimateInput,
} from "@agent-sdk/core";

export interface OpenAIResponsesGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

/** Minimal Responses API adapter for text-only chat. Tool mapping belongs in a provider package. */
export class OpenAIResponsesGateway implements ModelGateway {
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: OpenAIResponsesGatewayOptions) {
    this.model = options.model ?? "gpt-5.6";
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async *stream(
    request: ModelRequest,
    options: { signal: AbortSignal },
  ): AsyncIterable<ModelDelta> {
    if (request.tools.length > 0)
      throw new Error(
        "OpenAIResponsesGateway in simple-chat supports text-only sessions; configure no tools.",
      );
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: toOpenAIInput(request.messages),
        stream: true,
        store: false,
        ...(request.maxOutputTokens
          ? { max_output_tokens: request.maxOutputTokens }
          : {}),
      }),
    });
    if (!response.ok)
      throw new Error(
        `OpenAI Responses API ${response.status}: ${await response.text()}`,
      );
    if (!response.body)
      throw new Error("OpenAI Responses API returned no streaming body");
    for await (const event of parseSse(response.body, options.signal)) {
      if (
        event.type === "response.output_text.delta" &&
        typeof event.delta === "string"
      )
        yield { type: "text-delta", text: event.delta };
      else if (event.type === "response.completed") {
        const usage = asRecord(event.response).usage;
        if (
          isRecord(usage) &&
          typeof usage.input_tokens === "number" &&
          typeof usage.output_tokens === "number"
        )
          yield {
            type: "usage",
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          };
        yield { type: "finish", reason: "stop" };
      } else if (event.type === "response.incomplete")
        yield { type: "finish", reason: "length" };
      else if (event.type === "error") throw new Error(readError(event));
    }
  }

  async estimateTokens(input: TokenEstimateInput): Promise<TokenEstimate> {
    return {
      tokens: Math.ceil(JSON.stringify(input).length / 4),
      source: "heuristic",
    };
  }
}

function toOpenAIInput(
  messages: AgentMessage[],
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  return messages.filter(isSupportedMessage).map((message) => ({
    role: message.role,
    content: message.content
      .filter(
        (content): content is Extract<typeof content, { type: "text" }> =>
          content.type === "text",
      )
      .map((content) => content.text)
      .join("\n"),
  }));
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
        if (!data || data === "[DONE]") continue;
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
function isSupportedMessage(
  message: AgentMessage,
): message is AgentMessage & { role: "system" | "user" | "assistant" } {
  return message.role !== "tool";
}
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function readError(event: Record<string, unknown>): string {
  const error = asRecord(event.error);
  return typeof error.message === "string"
    ? error.message
    : "OpenAI Responses API stream error";
}
