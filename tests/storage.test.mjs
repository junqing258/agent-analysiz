import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlEventStore, LocalArtifactStore, markInterruptedTools, recoverSession } from "../packages/storage/dist/index.js";

test("JSONL is sequential, replayable, and artifacts are content addressed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-sdk-"));
  const store = new JsonlEventStore(join(root, "events.jsonl"));
  await Promise.all([store.append({ type: "turn.started", turnId: "a", at: new Date().toISOString() }), store.append({ type: "session.state.changed", state: "building-context" })]);
  const entries = [];
  for await (const entry of store.readAfter(0)) entries.push(entry);
  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2]);
  const artifacts = new LocalArtifactStore(join(root, "artifacts"));
  const ref = await artifacts.put("contents", { mediaType: "text/plain" });
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(new TextDecoder().decode(await artifacts.get(ref)), "contents");
  await writeFile(join(root, "artifacts", ref.sha256), "corrupt");
  await assert.rejects(artifacts.get(ref), /integrity/);
});

test("recovery identifies incomplete tools and appends non-retry marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-sdk-recovery-"));
  const store = new JsonlEventStore(join(root, "events.jsonl"));
  await store.append({ type: "tool.requested", call: { id: "unfinished", name: "write", input: {} } });
  const recovered = await recoverSession(store);
  assert.deepEqual(recovered.incompleteCallIds, ["unfinished"]);
  await markInterruptedTools(store, recovered);
  const events = [];
  for await (const entry of store.readAfter(0)) events.push(entry.event);
  assert.equal(events.at(-1).type, "tool.completed");
  assert.equal(events.at(-1).result.error.code, "TOOL_INTERRUPTED");
});
