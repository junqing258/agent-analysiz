import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeTools } from "../packages/node-executor/dist/index.js";

test("file tools require a same-session read before exact edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-sdk-files-"));
  await writeFile(join(root, "note.txt"), "before");
  const [read, , , write, edit] = createNodeTools(root);
  const ctx = { sessionId: "s", callId: "c", signal: new AbortController().signal, emit() {} };
  const rejected = await edit.execute({ path: "note.txt", oldText: "before", newText: "after" }, ctx);
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, "FILE_NOT_READ");
  const viewed = await read.execute({ path: "note.txt" }, ctx);
  assert.equal(viewed.ok, true);
  const changed = await edit.execute({ path: "note.txt", oldText: "before", newText: "after" }, ctx);
  assert.equal(changed.ok, true);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "after");
  const outside = await write.execute({ path: "../outside", content: "x" }, ctx);
  assert.equal(outside.ok, false); assert.equal(outside.error.code, "PATH_OUTSIDE_WORKSPACE");
  const created = await write.execute({ path: "new-file.txt", content: "created" }, ctx);
  assert.equal(created.ok, true);
  assert.equal(await readFile(join(root, "new-file.txt"), "utf8"), "created");
});
