import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadEnv, parseDotEnv } from "../apps/simple-chat/dist/env.js";
import { OpenAIResponsesGateway } from "../apps/simple-chat/dist/openai-responses-gateway.js";
import { createModelProvider } from "../apps/simple-chat/dist/providers.js";

test("OpenAI Responses gateway converts SSE text and usage to SDK deltas", async () => {
  let request;
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":3}}}'
  ].join("\n");
  const gateway = new OpenAIResponsesGateway({
    apiKey: "test-key",
    model: "test-model",
    endpoint: "https://example.test/responses",
    fetch: async (url, init) => { request = { url, init }; return new Response(sse, { status: 200 }); }
  });
  const deltas = [];
  for await (const delta of gateway.stream({ messages: [{ id: "system", role: "system", createdAt: "now", content: [{ type: "text", text: "Be helpful" }] }, { id: "user", role: "user", createdAt: "now", content: [{ type: "text", text: "Hi" }] }], tools: [], maxOutputTokens: 99 }, { signal: new AbortController().signal })) deltas.push(delta);
  assert.deepEqual(deltas, [{ type: "text-delta", text: "Hello" }, { type: "usage", inputTokens: 11, outputTokens: 3 }, { type: "finish", reason: "stop" }]);
  assert.equal(request.url, "https://example.test/responses");
  assert.equal(request.init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(request.init.body), { model: "test-model", input: [{ role: "system", content: "Be helpful" }, { role: "user", content: "Hi" }], stream: true, store: false, max_output_tokens: 99 });
});

test(".env loader searches upward, parses values, and preserves shell configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-chat-env-"));
  const nested = join(root, "a", "b");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, ".env"), "MODEL_PROVIDER=openai\nOPENAI_API_KEY=file-key\nOPENAI_MODEL=quoted model # comment\nexport OPENAI_BASE_URL='https://gateway.test/v1'\n");
  const target = { OPENAI_API_KEY: "shell-key" };
  assert.equal(await loadEnv({ startDirectory: nested, target }), join(root, ".env"));
  assert.deepEqual(target, { OPENAI_API_KEY: "shell-key", MODEL_PROVIDER: "openai", OPENAI_MODEL: "quoted model", OPENAI_BASE_URL: "https://gateway.test/v1" });
  assert.deepEqual(parseDotEnv("A=1\nB=\"two words\"\n"), { A: "1", B: "two words" });
  const provider = createModelProvider({ environment: target });
  assert.equal(provider.provider, "openai");
  assert.equal(provider.model, "quoted model");
  assert.throws(() => createModelProvider({ provider: "unsupported", environment: {} }), /Unsupported MODEL_PROVIDER/);
});
