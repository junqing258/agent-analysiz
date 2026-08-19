# Model gateway contract

`ModelGateway` isolates the SDK from provider protocols. It streams normalized `text-delta`, `tool-call-delta`, complete `tool-call`, usage, and finish events. Provider adapters must not execute tools or expose provider-specific event shapes to core.

The core only persists a `tool.requested` event after it receives a complete tool call. Text deltas and tool-call deltas are transport-only and must never be appended to `EventStore`.

For deterministic testing, use `@agent-sdk/mock-gateway` with a sequence of `ModelDelta[]` responses. Production adapters should propagate the supplied `AbortSignal`, normalize retries/rate limits, and implement `estimateTokens()` when their provider supports it.
