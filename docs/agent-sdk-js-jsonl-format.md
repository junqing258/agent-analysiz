# JSONL event format and compatibility

Each line is a UTF-8 JSON object:

```json
{"sequence":42,"event":{"type":"tool.completed","callId":"call_1","result":{"ok":true,"content":[{"type":"text","text":"ok"}]}}}
```

`sequence` is strictly increasing within a store and must never be reused. Producers may add optional fields but must not change the meaning or type of existing fields in the `0.x` series. Consumers must ignore unknown event fields and reject malformed lines rather than silently treating them as state.

Transport-only event names are `model.text.delta`, `model.tool-call.delta`, and `tool.progress`; their presence in JSONL is invalid. Store schema migrations should use a new file or explicit migration process, never rewrite an append-only active session log.
