/** Deterministic gateway fixture: each stream request consumes one scripted response. */
export class MockGateway {
  requests = [];
  #cursor = 0;

  constructor(responses) {
    this.responses = responses;
  }

  async *stream(request, options) {
    this.requests.push(request);
    const response = this.responses[this.#cursor++] ?? [{ type: "finish", reason: "stop" }];
    for (const delta of response) {
      if (options.signal.aborted) throw options.signal.reason ?? new Error("aborted");
      yield delta;
    }
  }

  async estimateTokens(input) {
    return {
      tokens: Math.ceil(JSON.stringify(input).length / 4),
      source: "heuristic",
    };
  }
}
