import type {
  AgentMessage,
  ModelDelta,
  ModelGateway,
  ModelRequest,
  ModelToolDefinition,
  TokenEstimate,
  TokenEstimateInput,
} from "@agent-sdk/core";
export type DiagnosticLogger = (stage: string, details?: Record<string, unknown>) => void;

export interface AnthropicMessagesGatewayOptions {
  debugLogger?: (message: string) => void;
  baseUrl: string;
  authToken: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  diagnosticLogger?: DiagnosticLogger;
}

/** Messages API adapter using the normalized SDK stream and tool contracts. */
export class AnthropicMessagesGateway implements ModelGateway {
  private readonly endpoint: string;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: AnthropicMessagesGatewayOptions) {
    this.endpoint = messagesEndpoint(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async *stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelDelta> {
    const { system, messages } = toAnthropicInput(request.messages);
    const body = {
      model: this.options.model,
      max_tokens: request.maxOutputTokens ?? 2_000,
      stream: true,
      ...(system ? { system } : {}),
      messages,
      ...(request.tools.length ? { tools: toAnthropicTools(request.tools) } : {}),
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
      requestId: response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? undefined,
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
    if (!response.body) throw new Error("Anthropic Messages API returned no streaming body");
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finish: "stop" | "tool-use" | "length" = "stop";
    const callsByContentIndex = new Map<number, AnthropicFunctionCall>();
    const emittedCallIds = new Set<string>();
    for await (const event of parseSse(response.body, options.signal)) {
      this.log("anthropic.stream.event", {
        type: typeof event.type === "string" ? event.type : "unknown",
      });
      if (event.type === "content_block_start") {
        const block = asRecord(event.content_block);
        if (block.type === "tool_use") {
          const call = readFunctionCall(block);
          if (call) callsByContentIndex.set(readContentIndex(event), call);
        }
      } else if (event.type === "content_block_delta") {
        const delta = asRecord(event.delta);
        if (delta.type === "text_delta" && typeof delta.text === "string")
          yield { type: "text-delta", text: delta.text };
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const call = callsByContentIndex.get(readContentIndex(event));
          if (call) {
            call.inputText += delta.partial_json;
            yield {
              type: "tool-call-delta",
              id: call.id,
              inputTextDelta: delta.partial_json,
            };
          }
        }
      } else if (event.type === "content_block_stop") {
        const call = callsByContentIndex.get(readContentIndex(event));
        if (call) yield* emitFunctionCall(call, emittedCallIds);
      } else if (event.type === "message_start") {
        const usage = asRecord(asRecord(event.message).usage);
        if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      } else if (event.type === "message_delta") {
        const delta = asRecord(event.delta);
        const usage = asRecord(event.usage);
        if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
        if (delta.stop_reason === "tool_use") finish = "tool-use";
        else if (delta.stop_reason === "max_tokens" || delta.stop_reason === "model_context_window_exceeded")
          finish = "length";
      } else if (event.type === "error") throw new Error(readError(event));
    }
    if (inputTokens !== undefined && outputTokens !== undefined) yield { type: "usage", inputTokens, outputTokens };
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

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

interface AnthropicFunctionCall {
  id: string;
  name: string;
  inputText: string;
}

function toAnthropicInput(messages: AgentMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .flatMap(textContent)
    .join("\n\n");
  const output: AnthropicMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const results: AnthropicContentBlock[] = [];
      while (index < messages.length) {
        const toolMessage = messages[index];
        if (!toolMessage || toolMessage.role !== "tool") break;
        for (const content of toolMessage.content) {
          if (content.type !== "tool-result") continue;
          results.push({
            type: "tool_result",
            tool_use_id: content.callId,
            content: toolResultText(content.result),
            ...(!content.result.ok ? { is_error: true } : {}),
          });
        }
        index += 1;
      }
      index -= 1;
      if (results.length) output.push({ role: "user", content: results });
      continue;
    }
    const text = textContent(message);
    const calls = message.content.flatMap((content) =>
      content.type === "tool-call"
        ? [
            {
              type: "tool_use" as const,
              id: content.call.id,
              name: content.call.name,
              input: content.call.input,
            },
          ]
        : [],
    );
    output.push({
      role: message.role,
      content: calls.length ? [...(text ? [{ type: "text" as const, text }] : []), ...calls] : text,
    });
  }
  return { ...(system ? { system } : {}), messages: output };
}
function textContent(message: AgentMessage): string {
  return message.content
    .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}
function toolResultText(result: Extract<AgentMessage["content"][number], { type: "tool-result" }>["result"]): string {
  const text = result.content
    .reduce<string[]>((texts, content) => (content.type === "text" ? [...texts, content.text] : texts), [])
    .join("\n");
  return text || JSON.stringify(result);
}
function toAnthropicTools(tools: ModelToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
function readContentIndex(event: Record<string, unknown>): number {
  return typeof event.index === "number" ? event.index : -1;
}
function readFunctionCall(block: Record<string, unknown>): AnthropicFunctionCall | undefined {
  const id = typeof block.id === "string" ? block.id : undefined;
  const name = typeof block.name === "string" ? block.name : undefined;
  if (!id || !name) return undefined;
  const initialInput = isRecord(block.input) && Object.keys(block.input).length ? JSON.stringify(block.input) : "";
  return {
    id,
    name,
    inputText: initialInput,
  };
}
function* emitFunctionCall(call: AnthropicFunctionCall, emittedCallIds: Set<string>): Generator<ModelDelta> {
  if (emittedCallIds.has(call.id)) return;
  emittedCallIds.add(call.id);
  yield {
    type: "tool-call",
    id: call.id,
    name: call.name,
    input: parseFunctionInput(call.inputText),
  };
}
function parseFunctionInput(inputText: string): unknown {
  try {
    return JSON.parse(inputText);
  } catch {
    return {};
  }
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
  return typeof error.message === "string" ? error.message : "Anthropic Messages API stream error";
}
