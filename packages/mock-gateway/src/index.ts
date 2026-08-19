import type { ModelDelta, ModelGateway, ModelRequest, TokenEstimate, TokenEstimateInput } from "@agent-sdk/core";

/** Deterministic gateway fixture: each stream request consumes one scripted response. */
export class MockGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  constructor(private readonly responses: readonly ModelDelta[][]) {}
  async *stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelDelta> {
    this.requests.push(request);
    const response = this.responses[this.cursor++] ?? [{ type: "finish", reason: "stop" }];
    for (const delta of response) {
      if (options.signal.aborted) throw options.signal.reason ?? new Error("aborted");
      yield delta;
    }
  }
  async estimateTokens(input: TokenEstimateInput): Promise<TokenEstimate> {
    return { tokens: Math.ceil(JSON.stringify(input).length / 4), source: "heuristic" };
  }
}
