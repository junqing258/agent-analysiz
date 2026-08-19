import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadEnv, parseDotEnv } from "../apps/simple-chat/dist/env.js";
import { AnthropicMessagesGateway } from "../apps/simple-chat/dist/anthropic-messages-gateway.js";
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

test("OpenAI Responses gateway sends tools and normalizes streamed function calls", async () => {
  let request;
  const sse = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_read","name":"read","arguments":""}}',
    '',
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\"README.md\\"}"}',
    '',
    'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"path\\":\\"README.md\\"}"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}'
  ].join("\n");
  const gateway = new OpenAIResponsesGateway({
    apiKey: "test-key",
    endpoint: "https://example.test/responses",
    fetch: async (_url, init) => { request = init; return new Response(sse, { status: 200 }); }
  });
  const tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const messages = [
    { id: "user", role: "user", createdAt: "now", content: [{ type: "text", text: "Read README" }] },
    { id: "assistant", role: "assistant", createdAt: "now", content: [{ type: "tool-call", call: { id: "previous_call", name: "read", input: { path: "package.json" } } }] },
    { id: "tool", role: "tool", createdAt: "now", content: [{ type: "tool-result", callId: "previous_call", result: { ok: true, content: [{ type: "text", text: '{"name":"demo"}' }] } }] }
  ];
  const deltas = [];
  for await (const delta of gateway.stream({ messages, tools }, { signal: new AbortController().signal })) deltas.push(delta);
  assert.deepEqual(deltas, [
    { type: "tool-call-delta", id: "call_read", inputTextDelta: '{"path":"README.md"}' },
    { type: "tool-call", id: "call_read", name: "read", input: { path: "README.md" } },
    { type: "usage", inputTokens: 4, outputTokens: 2 },
    { type: "finish", reason: "tool-use" }
  ]);
  const body = JSON.parse(request.body);
  assert.deepEqual(body.tools, [{ type: "function", name: "read", description: "Read a file", parameters: tools[0].inputSchema }]);
  assert.deepEqual(body.input, [
    { role: "user", content: "Read README" },
    { type: "function_call", call_id: "previous_call", name: "read", arguments: '{"path":"package.json"}' },
    { type: "function_call_output", call_id: "previous_call", output: '{"name":"demo"}' }
  ]);
});

test("Anthropic Messages gateway uses the configured base URL and normalizes streaming events", async () => {
  let request;
  const diagnostics = [];
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8}}}',
    '',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}'
  ].join("\n");
  const gateway = new AnthropicMessagesGateway({ baseUrl: "https://gateway.test/v1", authToken: "token", model: "claude-test", diagnosticLogger: (stage, details) => diagnostics.push({ stage, details }), fetch: async (url, init) => { request = { url, init }; return new Response(sse, { status: 200 }); } });
  const deltas = [];
  for await (const delta of gateway.stream({ messages: [{ id: "system", role: "system", createdAt: "now", content: [{ type: "text", text: "Be helpful" }] }, { id: "user", role: "user", createdAt: "now", content: [{ type: "text", text: "Hi" }] }], tools: [], maxOutputTokens: 99 }, { signal: new AbortController().signal })) deltas.push(delta);
  assert.deepEqual(deltas, [{ type: "text-delta", text: "Hello" }, { type: "usage", inputTokens: 8, outputTokens: 2 }, { type: "finish", reason: "length" }]);
  assert.equal(request.url, "https://gateway.test/v1/messages");
  assert.equal(request.init.headers["x-api-key"], "token");
  assert.deepEqual(JSON.parse(request.init.body), { model: "claude-test", max_tokens: 99, stream: true, system: "Be helpful", messages: [{ role: "user", content: "Hi" }] });
  assert.deepEqual(diagnostics.map(({ stage }) => stage), ["anthropic.request.started", "anthropic.response.received", "anthropic.stream.event", "anthropic.stream.event", "anthropic.stream.event", "anthropic.stream.finished"]);
  assert(!JSON.stringify(diagnostics).includes("token"));
  const provider = createModelProvider({ environment: { ANTHROPIC_BASE_URL: "https://gateway.test", ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_MODEL: "claude-test" } });
  assert.equal(provider.provider, "anthropic");
});

test("Anthropic Messages gateway sends tools and normalizes streamed tool use", async () => {
  let request;
  const sse = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_read","name":"read","input":{}}}',
    '',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}',
    '',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}',
    '',
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":6}}}'
  ].join("\n");
  const gateway = new AnthropicMessagesGateway({
    baseUrl: "https://gateway.test",
    authToken: "token",
    model: "claude-test",
    fetch: async (_url, init) => { request = init; return new Response(sse, { status: 200 }); }
  });
  const tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const messages = [
    { id: "user", role: "user", createdAt: "now", content: [{ type: "text", text: "Read README" }] },
    { id: "assistant", role: "assistant", createdAt: "now", content: [{ type: "tool-call", call: { id: "previous_call", name: "read", input: { path: "package.json" } } }] },
    { id: "tool", role: "tool", createdAt: "now", content: [{ type: "tool-result", callId: "previous_call", result: { ok: true, content: [{ type: "text", text: '{"name":"demo"}' }] } }] }
  ];
  const deltas = [];
  for await (const delta of gateway.stream({ messages, tools }, { signal: new AbortController().signal })) deltas.push(delta);
  assert.deepEqual(deltas, [
    { type: "tool-call-delta", id: "toolu_read", inputTextDelta: '{"path":"README.md"}' },
    { type: "tool-call", id: "toolu_read", name: "read", input: { path: "README.md" } },
    { type: "usage", inputTokens: 6, outputTokens: 3 },
    { type: "finish", reason: "tool-use" }
  ]);
  const body = JSON.parse(request.body);
  assert.deepEqual(body.tools, [{ name: "read", description: "Read a file", input_schema: tools[0].inputSchema }]);
  assert.deepEqual(body.messages, [
    { role: "user", content: "Read README" },
    { role: "assistant", content: [{ type: "tool_use", id: "previous_call", name: "read", input: { path: "package.json" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "previous_call", content: '{"name":"demo"}' }] }
  ]);
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
