import type { ModelDelta, ModelGateway, ModelRequest, TokenEstimate, TokenEstimateInput } from "@agent-sdk/core";

/** Offline deterministic gateway so the sample remains runnable without credentials or network access. */
export class DemoGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelDelta> {
    const latestUser = [...request.messages].reverse().find((message) => message.role === "user");
    const prompt = latestUser?.content.find((content) => content.type === "text");
    const answer = prompt?.type === "text" ? `Demo mode received: ${prompt.text}` : "Demo mode is ready.";
    for (const token of answer.split(/(\s+)/)) if (token) yield { type: "text-delta", text: token };
    yield { type: "finish", reason: "stop" };
  }
  async estimateTokens(input: TokenEstimateInput): Promise<TokenEstimate> { return { tokens: Math.ceil(JSON.stringify(input).length / 4), source: "heuristic" }; }
}
