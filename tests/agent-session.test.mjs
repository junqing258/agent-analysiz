import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, InMemoryPermissionStore, defineTool } from "../packages/core/dist/index.js";
import { MockGateway } from "../packages/mock-gateway/dist/index.js";

class MemoryEventStore {
  events = [];
  async append(event) { const stored = { sequence: this.events.length + 1, event }; this.events.push(stored); return stored; }
  async *readAfter(sequence) { yield* this.events.filter((entry) => entry.sequence > sequence); }
}
const ok = (text) => ({ ok: true, content: [{ type: "text", text }] });

test("runs a streamed two-tool loop and never stores deltas", async () => {
  const store = new MemoryEventStore();
  const gateway = new MockGateway([
    [{ type: "text-delta", text: "I will check. " }, { type: "tool-call-delta", id: "a", inputTextDelta: "{}" }, { type: "tool-call", id: "a", name: "first", input: {} }, { type: "finish", reason: "tool-use" }],
    [{ type: "tool-call", id: "b", name: "second", input: { value: "x" } }, { type: "finish", reason: "tool-use" }],
    [{ type: "text-delta", text: "Done." }, { type: "finish", reason: "stop" }]
  ]);
  const calls = [];
  const tools = [
    defineTool({ name: "first", description: "first", risk: "read", inputSchema: { type: "object", additionalProperties: false }, async execute(_, ctx) { calls.push(ctx.callId); return ok("one"); } }),
    defineTool({ name: "second", description: "second", risk: "read", inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } }, async execute(input) { calls.push(input.value); return ok("two"); } })
  ];
  const session = new AgentSession({ model: gateway, tools, eventStore: store });
  const transport = [];
  for await (const event of session.run("start")) transport.push(event);
  assert.deepEqual(calls, ["a", "x"]);
  assert.equal(session.state, "completed");
  assert.equal(gateway.requests.length, 3);
  assert(transport.some((event) => event.type === "model.text.delta"));
  assert(!store.events.some(({ event }) => event.type === "model.text.delta" || event.type === "model.tool-call.delta"));
  assert.equal(store.events.filter(({ event }) => event.type === "tool.completed").length, 2);
});

test("hangs on policy ask and resumes after one resolved permission", async () => {
  const store = new MemoryEventStore();
  const gateway = new MockGateway([
    [{ type: "tool-call", id: "edit-1", name: "edit", input: {} }, { type: "finish", reason: "tool-use" }],
    [{ type: "text-delta", text: "Saved." }, { type: "finish", reason: "stop" }]
  ]);
  const session = new AgentSession({ model: gateway, eventStore: store, permissions: { store: new InMemoryPermissionStore(), permissionTimeoutMs: 5_000 }, tools: [defineTool({ name: "edit", description: "edit", risk: "write", inputSchema: { type: "object" }, async execute() { return ok("saved"); } })] });
  const iterator = session.run("write")[Symbol.asyncIterator]();
  let request;
  while (!request) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === "permission.requested") request = next.value.request;
  }
  assert.equal(session.state, "awaiting-permission");
  await session.resolvePermission(request.id, { type: "allow-once" });
  const remaining = [];
  for (;;) { const next = await iterator.next(); if (next.done) break; remaining.push(next.value); }
  assert.equal(session.state, "completed");
  assert(remaining.some((event) => event.type === "permission.resolved"));
  assert.equal(store.events.filter(({ event }) => event.type === "tool.completed").length, 1);
});

test("turn cancellation records interruption and does not execute a later tool", async () => {
  const store = new MemoryEventStore();
  const controller = new AbortController();
  const gateway = new MockGateway([[{ type: "tool-call", id: "a", name: "slow", input: {} }, { type: "finish", reason: "tool-use" }]]);
  let executed = false;
  const session = new AgentSession({ model: gateway, eventStore: store, tools: [defineTool({ name: "slow", description: "slow", risk: "read", inputSchema: { type: "object" }, async execute(_, ctx) { executed = true; controller.abort(); await new Promise((resolve) => setTimeout(resolve, 1)); return ok("late"); } })] });
  for await (const _ of session.run("cancel", { signal: controller.signal })) { /* consume */ }
  assert.equal(executed, true);
  assert.equal(session.state, "interrupted");
  assert(store.events.some(({ event }) => event.type === "turn.interrupted" && event.reason === "aborted"));
});

test("compacts over-budget history into a durable checkpoint", async () => {
  const store = new MemoryEventStore();
  const gateway = new MockGateway(Array.from({ length: 3 }, () => [[{ type: "text-delta", text: "reply" }, { type: "finish", reason: "stop" }]]).flat());
  const session = new AgentSession({ model: gateway, eventStore: store, context: { system: "system", contextWindowTokens: 30, maxOutputTokens: 5, retainRecentMessages: 1 } });
  for (const text of ["a long first message that exceeds a tiny budget", "another large user message", "one more large user message"]) for await (const _ of session.run(text)) { /* consume */ }
  const checkpoint = store.events.find(({ event }) => event.type === "context.compacted");
  assert(checkpoint);
  assert.equal(checkpoint.event.snapshot.messages.some((message) => message.content.some((content) => content.type === "text" && content.text.startsWith("Conversation summary"))), true);
});

test("truncation preserves a tool failure instead of changing it to success", async () => {
  const store = new MemoryEventStore();
  const gateway = new MockGateway([
    [{ type: "tool-call", id: "bad", name: "bad", input: {} }, { type: "finish", reason: "tool-use" }],
    [{ type: "finish", reason: "stop" }]
  ]);
  const session = new AgentSession({ model: gateway, eventStore: store, maxToolResultChars: 20, tools: [defineTool({ name: "bad", description: "bad", risk: "read", inputSchema: { type: "object" }, async execute() { return { ok: false, error: { code: "LONG_FAILURE", message: "x".repeat(200), retryable: false }, content: [{ type: "text", text: "x".repeat(200) }] }; } })] });
  for await (const _ of session.run("go")) { /* consume */ }
  const completed = store.events.find(({ event }) => event.type === "tool.completed").event;
  assert.equal(completed.result.ok, false);
  assert.equal(completed.result.error.code, "LONG_FAILURE");
});
