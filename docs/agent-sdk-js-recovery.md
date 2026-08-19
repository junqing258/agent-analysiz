# Session recovery

Use `recoverSession(eventStore)` to read durable state from the last `context.compacted` checkpoint and replay subsequent messages. Recovery does not rerun a summarizer.

Before presenting recovered state to a model, call `markInterruptedTools(eventStore, recovered)`. It appends a `tool.completed` failure with code `TOOL_INTERRUPTED` for every requested call lacking a completion event. The SDK never retries these calls automatically; a host may issue a new call only after explicitly approving an idempotent recovery policy.

JSONL writes are append-only and serialized. The event store contains durable events only; artifacts hold full tool output, and streaming deltas remain in the caller's transport stream.
