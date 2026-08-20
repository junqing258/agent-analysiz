import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, defineTool } from "../packages/core/dist/index.js";
import { InMemoryMemoryStore } from "../packages/memory/dist/index.js";
import { MockGateway } from "./mock-gateway.mjs";

class Events {
  events = [];
  async append(event) {
    const stored = { sequence: this.events.length + 1, event };
    this.events.push(stored);
    return stored;
  }
  async *readAfter(sequence) {
    yield* this.events.filter((item) => item.sequence > sequence);
  }
}
const tool = (name) =>
  defineTool({
    name,
    description: name,
    risk: "read",
    inputSchema: { type: "object" },
    async execute() {
      return { ok: true, content: [{ type: "text", text: "ok" }] };
    },
  });

test("skills are injected per-turn, freeze visible tools, and do not enter history", async () => {
  const events = new Events();
  const skill = {
    name: "release",
    description: "release checklist",
    triggers: ["release"],
    allowedTools: ["read"],
    root: "trusted",
    instructions: "Use the release checklist.",
  };
  const gateway = new MockGateway([
    [
      { type: "tool-call", id: "write", name: "write", input: {} },
      { type: "finish", reason: "tool-use" },
    ],
    [{ type: "finish", reason: "stop" }],
  ]);
  const session = new AgentSession({
    model: gateway,
    eventStore: events,
    tools: [tool("read"), tool("write")],
    skills: {
      async list() {
        return [skill];
      },
      async match() {
        return [skill];
      },
      async load() {
        return skill;
      },
    },
  });
  for await (const _ of session.run("release now")) {
    /* consume */
  }
  assert.deepEqual(
    gateway.requests[0].tools.map((entry) => entry.name),
    ["read"],
  );
  assert.match(gateway.requests[0].messages.at(-1).content[0].text, /release checklist/);
  assert(
    events.events.some(
      ({ event }) => event.type === "tool.completed" && event.result.error.code === "TOOL_DISABLED_BY_SKILL",
    ),
  );
  assert.equal(
    session
      .getMessages()
      .some((message) =>
        message.content.some((part) => part.type === "text" && part.text.includes("release checklist")),
      ),
    false,
  );
});

test("memory bindings isolate records and deletion removes search visibility", async () => {
  const store = new InMemoryMemoryStore();
  const record = {
    id: "m1",
    binding: { scope: "project", workspaceId: "a" },
    kind: "fact",
    content: "The project uses TypeScript",
    tags: ["typescript"],
    source: { sessionId: "s1" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.upsert(record, { sessionId: "s1", workspaceId: "a" });
  assert.equal(
    (await store.search("typescript", { scopes: ["project"], limit: 5, access: { sessionId: "s2", workspaceId: "a" } }))
      .length,
    1,
  );
  assert.equal(
    (await store.search("typescript", { scopes: ["project"], limit: 5, access: { sessionId: "s2", workspaceId: "b" } }))
      .length,
    0,
  );
  await assert.rejects(store.delete("m1", { sessionId: "s2", workspaceId: "b" }), /denied/);
  await store.delete("m1", { sessionId: "s2", workspaceId: "a" });
  assert.equal(
    (await store.search("typescript", { scopes: ["project"], limit: 5, access: { sessionId: "s2", workspaceId: "a" } }))
      .length,
    0,
  );
});
