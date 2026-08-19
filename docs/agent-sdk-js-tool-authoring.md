# Tool authoring

Tools are pure protocol objects: they declare a Draft 2020-12 JSON Schema subset, a risk class, and an async `execute` function. The runtime validates input before executing and converts validation, policy, timeout, and execution errors into structured tool results.

```ts
import { defineTool } from "@agent-sdk/core";

export const lookupIssue = defineTool({
  name: "lookup_issue",
  description: "Look up one issue by its project-local identifier.",
  risk: "read",
  inputSchema: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string", pattern: "^[A-Z]+-[0-9]+$" } }
  },
  async execute({ id }, ctx) {
    ctx.emit({ message: "Searching", percent: 50 });
    return { ok: true, content: [{ type: "json", value: { id } }] };
  }
});
```

Choose `read`, `write`, `execute`, `external`, or `agent` conservatively. Do not ask for permission inside a tool; policy is evaluated by `AgentSession` before `execute` begins. A tool must observe `ctx.signal`, return `ToolFailure` for expected operational errors, and only use `parallelSafe: true` if it has no shared resource conflicts.

Large results are persisted as artifacts and context is truncated by the runtime. Return a concise result, retrieval hint, and durable reference rather than embedding unbounded output in `content`.
