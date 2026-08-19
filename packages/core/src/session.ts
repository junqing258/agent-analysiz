import { validateJsonSchema } from "@agent-sdk/schema";
import { ContextManager } from "./context.js";
import { DefaultPermissionPolicy } from "./permissions.js";
import { ToolRegistry } from "./tools.js";
import type { AgentMessage, AgentSessionOptions, DurableEvent, PermissionDecision, PermissionRequest, SessionState, Tool, ToolCall, ToolFailure, ToolResult, TransportEvent } from "./types.js";

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false }); else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined as never, done: true });
  }
  async next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.closed) return { value: undefined as never, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface PendingPermission { resolve(decision: PermissionDecision): void; settled: boolean; }

/**
 * A single-session, event-sourced Agent runtime. It never persists transport
 * deltas; append() always precedes exposing every durable event to the caller.
 */
export class AgentSession {
  readonly sessionId: string;
  private readonly options: Required<Pick<AgentSessionOptions, "maxSteps" | "toolTimeoutMs" | "maxToolResultChars">> & AgentSessionOptions;
  private readonly tools: ToolRegistry;
  private readonly messages: AgentMessage[] = [];
  private readonly contextManager: ContextManager;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private active = false;
  private sequence = 0;
  state: SessionState = "idle";

  constructor(options: AgentSessionOptions) {
    this.options = { ...options, maxSteps: options.maxSteps ?? 12, toolTimeoutMs: options.toolTimeoutMs ?? 120_000, maxToolResultChars: options.maxToolResultChars ?? 8_000 };
    this.sessionId = options.sessionId ?? `session_${randomId()}`;
    this.contextManager = new ContextManager(options.model, options.context);
    this.tools = new ToolRegistry(options.tools);
    this.messages.push(...(options.initialMessages ?? []));
    if (options.context?.system && !this.messages.some((existing) => existing.role === "system")) this.messages.unshift(message("system", [{ type: "text", text: options.context.system }]));
  }

  run(input: string | AgentMessage, options: { signal?: AbortSignal } = {}): AsyncIterable<TransportEvent> {
    if (this.active) throw new Error("A session permits only one active run()");
    this.active = true;
    const queue = new AsyncQueue<TransportEvent>();
    void this.drive(input, options.signal, queue).finally(() => { this.active = false; queue.close(); });
    return { [Symbol.asyncIterator]: () => ({ next: () => queue.next() }) };
  }

  async resolvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.settled) throw new Error(`Permission request is not pending: ${requestId}`);
    pending.settled = true;
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
  }

  getMessages(): readonly AgentMessage[] { return this.messages; }

  private async drive(input: string | AgentMessage, parentSignal: AbortSignal | undefined, queue: AsyncQueue<TransportEvent>): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = this.options.turnTimeoutMs ? setTimeout(() => controller.abort(new Error("turn timeout")), this.options.turnTimeoutMs) : undefined;
    try {
      const turnId = `turn_${randomId()}`;
      await this.persist({ type: "turn.started", turnId, at: now() }, queue);
      await this.setState("building-context", queue);
      const user = typeof input === "string" ? message("user", [{ type: "text", text: input }]) : input;
      this.messages.push(user);
      await this.persist({ type: "message.appended", message: user }, queue);

      for (let step = 0; step < this.options.maxSteps; step += 1) {
        throwIfAborted(controller.signal);
        await this.setState("streaming", queue);
        const response = await this.collectModelResponse(controller.signal, queue);
        if (response.calls.length === 0) {
          if (response.finish !== "stop") {
            await this.interrupt(response.finish === "length" ? "step-limit" : "aborted", queue);
            return;
          }
          const assistant = message("assistant", response.text ? [{ type: "text", text: response.text }] : []);
          this.messages.push(assistant);
          await this.persist({ type: "message.appended", message: assistant }, queue);
          await this.setState("completed", queue);
          await this.persist({ type: "turn.completed", messageId: assistant.id }, queue);
          return;
        }

        const content = [response.text ? { type: "text" as const, text: response.text } : undefined, ...response.calls.map((call) => ({ type: "tool-call" as const, call }))].filter((part): part is NonNullable<typeof part> => Boolean(part));
        const assistant = message("assistant", content);
        this.messages.push(assistant);
        await this.persist({ type: "message.appended", message: assistant }, queue);
        for (const call of response.calls) await this.executeCall(call, controller.signal, queue);
        await this.setState("building-context", queue);
      }
      await this.interrupt("step-limit", queue);
    } catch (error) {
      if (controller.signal.aborted) await this.interrupt(isTurnTimeout(controller.signal.reason) ? "turn-timeout" : "aborted", queue);
      else {
        await this.setState("failed", queue);
        await this.persist({ type: "turn.failed", error: toAgentError(error) }, queue);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  private async collectModelResponse(signal: AbortSignal, queue: AsyncQueue<TransportEvent>): Promise<{ text: string; calls: ToolCall[]; finish?: "stop" | "tool-use" | "length" }> {
    let text = "";
    const calls: ToolCall[] = [];
    let finish: "stop" | "tool-use" | "length" | undefined;
    const tools = this.tools.definitions();
    const prepared = await this.contextManager.prepare(this.messages, tools);
    if (prepared.snapshot) {
      await this.setState("compacting", queue);
      this.messages.splice(0, this.messages.length, ...prepared.messages);
      await this.persist({ type: "context.compacted", snapshot: prepared.snapshot, replacesThroughSequence: this.sequence }, queue);
      await this.setState("streaming", queue);
    }
    const request = { messages: prepared.messages, tools, maxOutputTokens: this.options.context?.maxOutputTokens };
    for await (const delta of this.options.model.stream(request, { signal })) {
      throwIfAborted(signal);
      if (delta.type === "text-delta") { text += delta.text; queue.push({ type: "model.text.delta", text: delta.text }); }
      else if (delta.type === "tool-call-delta") queue.push({ type: "model.tool-call.delta", id: delta.id, inputTextDelta: delta.inputTextDelta });
      else if (delta.type === "tool-call") calls.push({ id: delta.id, name: delta.name, input: delta.input });
      else if (delta.type === "finish") finish = delta.reason;
    }
    return { text, calls, finish };
  }

  private async executeCall(call: ToolCall, signal: AbortSignal, queue: AsyncQueue<TransportEvent>): Promise<void> {
    await this.persist({ type: "tool.requested", call }, queue);
    const tool = this.tools.get(call.name);
    let result: ToolResult;
    if (!tool) result = failure("TOOL_NOT_FOUND", `Unknown tool: ${call.name}`);
    else {
      const validation = validateJsonSchema(tool.inputSchema, call.input);
      result = validation.valid ? await this.executeAuthorized(tool, call, signal, queue) : failure("INVALID_TOOL_INPUT", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    }
    result = await this.controlResult(result);
    await this.persist({ type: "tool.completed", callId: call.id, result }, queue);
    const toolMessage = message("tool", [{ type: "tool-result", callId: call.id, result }]);
    this.messages.push(toolMessage);
    await this.persist({ type: "message.appended", message: toolMessage }, queue);
  }

  private async executeAuthorized(tool: Tool, call: ToolCall, signal: AbortSignal, queue: AsyncQueue<TransportEvent>): Promise<ToolResult> {
    const rules = this.options.permissions?.store ? await this.options.permissions.store.listRules({ workspace: this.options.workspace, tool: tool.name }) : [];
    const policy = this.options.permissions?.policy ?? new DefaultPermissionPolicy();
    const verdict = await policy.evaluate({ tool, call, workspace: this.options.workspace, rules });
    if (verdict.type === "deny") return failure("PERMISSION_DENIED", verdict.reason ?? `Policy denied ${tool.name}`);
    if (verdict.type === "ask") {
      const request: PermissionRequest = { id: `permission_${randomId()}`, tool: tool.name, risk: tool.risk, scope: { workspace: this.options.workspace, ...verdict.scope }, expiresAt: new Date(Date.now() + (this.options.permissions?.permissionTimeoutMs ?? 300_000)).toISOString() };
      await this.setState("awaiting-permission", queue);
      await this.persist({ type: "permission.requested", request }, queue);
      const decision = await this.waitForPermission(request, signal);
      await this.persist({ type: "permission.resolved", requestId: request.id, decision }, queue);
      if (decision.type === "allow-with-rule" && this.options.permissions?.store) await this.options.permissions.store.createRule(decision.rule);
      if (decision.type === "deny") return failure("PERMISSION_DENIED", decision.reason ?? `Permission denied for ${tool.name}`);
    }
    throwIfAborted(signal);
    await this.setState("executing-tool", queue);
    const toolController = new AbortController();
    const onAbort = () => toolController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => toolController.abort(new Error("tool timeout")), this.options.toolTimeoutMs);
    try {
      return await tool.execute(call.input, { sessionId: this.sessionId, callId: call.id, signal: toolController.signal, workspace: this.options.workspace, emit: (event) => queue.push({ type: "tool.progress", callId: call.id, ...event }) });
    } catch (error) {
      return failure(toolController.signal.aborted ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED", error instanceof Error ? error.message : "Tool failed", !toolController.signal.aborted);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async waitForPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const timeoutMs = Math.max(0, Date.parse(request.expiresAt) - Date.now());
    return new Promise<PermissionDecision>((resolve, reject) => {
      const finish = (decision: PermissionDecision) => { cleanup(); resolve(decision); };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new Error("aborted")); };
      const timer = setTimeout(() => finish({ type: "deny", reason: "Permission request timed out" }), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); this.pendingPermissions.delete(request.id); };
      this.pendingPermissions.set(request.id, { settled: false, resolve: finish });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async controlResult(result: ToolResult): Promise<ToolResult> {
    const serialized = JSON.stringify(result);
    if (serialized.length <= this.options.maxToolResultChars) return result;
    const artifact = this.options.artifactStore ? await this.options.artifactStore.put(serialized, { mediaType: "application/json" }) : undefined;
    const preview = serialized.slice(0, this.options.maxToolResultChars);
    const omitted = serialized.length - preview.length;
    if (!result.ok) return { ...result, content: [{ type: "text", text: `${preview}\n[${omitted} characters omitted${artifact ? `; artifact ${artifact.id}` : ""}]` }] };
    return { ok: true, content: [{ type: "text", text: preview }], artifact, truncated: { omitted, retrievalHint: artifact ? `Retrieve artifact ${artifact.id}` : "Result was truncated by the host" } };
  }

  private async interrupt(reason: "aborted" | "permission-timeout" | "step-limit" | "turn-timeout", queue: AsyncQueue<TransportEvent>): Promise<void> {
    await this.setState("interrupted", queue);
    await this.persist({ type: "turn.interrupted", reason }, queue);
  }
  private async setState(state: SessionState, queue: AsyncQueue<TransportEvent>): Promise<void> { this.state = state; await this.persist({ type: "session.state.changed", state }, queue); }
  private async persist(event: DurableEvent, queue: AsyncQueue<TransportEvent>): Promise<void> { const stored = await this.options.eventStore.append(event); this.sequence = stored.sequence; queue.push(event); }
}

function message(role: AgentMessage["role"], content: AgentMessage["content"]): AgentMessage { return { id: `message_${randomId()}`, role, content, createdAt: now() }; }
function failure(code: string, message: string, retryable = false): ToolFailure { return { ok: false, error: { code, message, retryable }, content: [{ type: "text", text: `${code}: ${message}` }] }; }
function randomId(): string { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function now(): string { return new Date().toISOString(); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("aborted"); }
function isTurnTimeout(reason: unknown): boolean { return reason instanceof Error && reason.message === "turn timeout"; }
function toAgentError(error: unknown): { code: string; message: string; cause?: unknown } { return { code: "TURN_FAILED", message: error instanceof Error ? error.message : "Unknown turn failure", cause: error }; }
