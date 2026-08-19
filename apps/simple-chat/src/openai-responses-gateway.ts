import type {
  AgentMessage,
  ModelDelta,
  ModelGateway,
  ModelRequest,
  ModelToolDefinition,
  TokenEstimate,
  TokenEstimateInput,
} from "@agent-sdk/core";

export interface OpenAIResponsesGatewayOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

/** Responses API adapter which normalizes text and function calls for AgentSession. */
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
        ...(request.tools.length ? { tools: toOpenAITools(request.tools) } : {}),
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
    const callsByOutputIndex = new Map<number, OpenAIFunctionCall>();
    const emittedCallIds = new Set<string>();
    for await (const event of parseSse(response.body, options.signal)) {
      if (
        event.type === "response.output_text.delta" &&
        typeof event.delta === "string"
      )
        yield { type: "text-delta", text: event.delta };
      else if (event.type === "response.output_item.added") {
        const item = asRecord(event.item);
        if (item.type === "function_call") {
          const call = readFunctionCall(item);
          if (call) callsByOutputIndex.set(readOutputIndex(event), call);
        }
      } else if (
        event.type === "response.function_call_arguments.delta" &&
        typeof event.delta === "string"
      ) {
        const call = callsByOutputIndex.get(readOutputIndex(event));
        if (call) {
          call.arguments += event.delta;
          yield {
            type: "tool-call-delta",
            id: call.id,
            inputTextDelta: event.delta,
          };
        }
      } else if (event.type === "response.function_call_arguments.done") {
        const call = callsByOutputIndex.get(readOutputIndex(event));
        if (call && typeof event.arguments === "string") {
          call.arguments = event.arguments;
          yield* emitFunctionCall(call, emittedCallIds);
        }
      } else if (event.type === "response.output_item.done") {
        const item = asRecord(event.item);
        if (item.type === "function_call") {
          const call = readFunctionCall(item);
          if (call) yield* emitFunctionCall(call, emittedCallIds);
        }
      } else if (event.type === "response.completed") {
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
        yield {
          type: "finish",
          reason: emittedCallIds.size > 0 ? "tool-use" : "stop",
        };
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

type OpenAIInputItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface OpenAIFunctionCall {
  id: string;
  name: string;
  arguments: string;
}

function toOpenAIInput(messages: AgentMessage[]): OpenAIInputItem[] {
  return messages.flatMap((message) => {
    if (message.role === "tool") {
      return message.content.flatMap((content) =>
        content.type === "tool-result"
          ? [{
              type: "function_call_output" as const,
              call_id: content.callId,
              output: toolResultText(content.result),
            }]
          : [],
      );
    }
    const text = textContent(message);
    const calls = message.content.flatMap((content) =>
      content.type === "tool-call"
        ? [{
            type: "function_call" as const,
            call_id: content.call.id,
            name: content.call.name,
            arguments: JSON.stringify(content.call.input),
          }]
        : [],
    );
    const items: OpenAIInputItem[] = [];
    if (text || calls.length === 0)
      items.push({ role: message.role, content: text });
    items.push(...calls);
    return items;
  });
}

function toOpenAITools(tools: ModelToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
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

function toolResultText(result: Extract<AgentMessage["content"][number], { type: "tool-result" }>["result"]): string {
  const text = result.content
    .reduce<string[]>(
      (texts, content) => content.type === "text" ? [...texts, content.text] : texts,
      [],
    )
    .join("\n");
  return text || JSON.stringify(result);
}

function readOutputIndex(event: Record<string, unknown>): number {
  return typeof event.output_index === "number" ? event.output_index : -1;
}

function readFunctionCall(item: Record<string, unknown>): OpenAIFunctionCall | undefined {
  const id = typeof item.call_id === "string" ? item.call_id : undefined;
  const name = typeof item.name === "string" ? item.name : undefined;
  if (!id || !name) return undefined;
  return {
    id,
    name,
    arguments: typeof item.arguments === "string" ? item.arguments : "",
  };
}

function* emitFunctionCall(
  call: OpenAIFunctionCall,
  emittedCallIds: Set<string>,
): Generator<ModelDelta> {
  if (emittedCallIds.has(call.id)) return;
  emittedCallIds.add(call.id);
  yield {
    type: "tool-call",
    id: call.id,
    name: call.name,
    input: parseFunctionArguments(call.arguments),
  };
}

function parseFunctionArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    return {};
  }
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
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function readError(event: Record<string, unknown>): string {
  const error = asRecord(event.error);
  return typeof error.message === "string"
    ? error.message
    : "OpenAI Responses API stream error";
}
