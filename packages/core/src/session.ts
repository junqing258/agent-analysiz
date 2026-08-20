import { validateJsonSchema } from "@agent-sdk/schema";
import { ContextManager } from "./context.js";
import { DefaultPermissionPolicy } from "./permissions.js";
import { ToolRegistry } from "./tools.js";
import type {
  AgentMessage,
  AgentSessionOptions,
  DurableEvent,
  PermissionDecision,
  PermissionRequest,
  SessionState,
  Tool,
  ToolCall,
  ToolFailure,
  ToolResult,
  TurnExtensionContext,
  TransportEvent,
} from "./types.js";

/** 将生产端推送的事件转换为可异步迭代消费的队列。 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
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

/** 等待外部调用方处理的权限请求。 */
interface PendingPermission {
  resolve(decision: PermissionDecision): void;
  settled: boolean;
}

/**
 * 单会话、事件溯源的 Agent 运行时。
 * 不持久化传输增量，且每个持久化事件都会先写入存储，再暴露给调用方。
 */
export class AgentSession {
  readonly sessionId: string;
  private readonly options: Required<Pick<AgentSessionOptions, "maxSteps" | "toolTimeoutMs" | "maxToolResultChars">> &
    AgentSessionOptions;
  private readonly tools: ToolRegistry;
  private readonly messages: AgentMessage[] = [];
  private readonly contextManager: ContextManager;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly memoryProposalTurns = new Map<string, string>();
  private active = false;
  private sequence = 0;
  state: SessionState = "idle";

  constructor(options: AgentSessionOptions) {
    this.options = {
      ...options,
      maxSteps: options.maxSteps ?? 12,
      toolTimeoutMs: options.toolTimeoutMs ?? 120_000,
      maxToolResultChars: options.maxToolResultChars ?? 8_000,
    };
    this.sessionId = options.sessionId ?? `session_${randomId()}`;
    this.contextManager = new ContextManager(options.model, options.context);
    this.tools = new ToolRegistry(options.tools);
    this.messages.push(...(options.initialMessages ?? []));
    if (options.context?.system && !this.messages.some((existing) => existing.role === "system"))
      this.messages.unshift(message("system", [{ type: "text", text: options.context.system }]));
  }

  /**
   * 启动一个回合，并返回模型增量、工具进度与持久化事件组成的事件流。
   * 单个会话同一时间只能运行一个回合。
   */
  run(input: string | AgentMessage, options: { signal?: AbortSignal } = {}): AsyncIterable<TransportEvent> {
    if (this.active) throw new Error("A session permits only one active run()");
    this.active = true;
    const queue = new AsyncQueue<TransportEvent>();
    void this.drive(input, options.signal, queue).finally(() => {
      this.active = false;
      queue.close();
    });
    return { [Symbol.asyncIterator]: () => ({ next: () => queue.next() }) };
  }

  /** 提交待处理权限请求的决策，使对应工具调用可以继续或被拒绝。 */
  async resolvePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || pending.settled) throw new Error(`Permission request is not pending: ${requestId}`);
    pending.settled = true;
    this.pendingPermissions.delete(requestId);
    pending.resolve(decision);
  }

  /** Confirms a previously proposed memory and records an audit-only external operation. */
  async confirmMemory(proposalId: string): Promise<void> {
    const memory = this.options.memory;
    if (!memory) throw new Error("Memory is not configured");
    const access = { sessionId: this.sessionId, ...memory.access };
    const record = await memory.store.confirm(proposalId, access);
    if (memory.policy && (await memory.policy.evaluate({ action: "confirm", record, access })) === "deny")
      throw new Error("Memory confirmation denied by policy");
    if (memory.policy && (await memory.policy.evaluate({ action: "save", record, access })) === "deny")
      throw new Error("Memory save denied by policy");
    const saved = await memory.store.upsert(record, access);
    await memory.store.reject(proposalId, access);
    const relatedTurnId = this.memoryProposalTurns.get(proposalId) ?? record.source.sessionId;
    await this.options.eventStore.append({
      type: "memory.confirmed",
      relatedTurnId,
      at: now(),
      operationId: `memory_op_${randomId()}`,
      proposalId,
      memoryId: saved.id,
    });
    await this.options.eventStore.append({
      type: "memory.saved",
      relatedTurnId,
      at: now(),
      operationId: `memory_op_${randomId()}`,
      memoryId: saved.id,
    });
    this.memoryProposalTurns.delete(proposalId);
  }
  async rejectMemory(proposalId: string): Promise<void> {
    const memory = this.options.memory;
    if (!memory) throw new Error("Memory is not configured");
    const relatedTurnId = this.memoryProposalTurns.get(proposalId) ?? this.sessionId;
    await memory.store.reject(proposalId, { sessionId: this.sessionId, ...memory.access });
    await this.options.eventStore.append({
      type: "memory.rejected",
      relatedTurnId,
      at: now(),
      operationId: `memory_op_${randomId()}`,
      proposalId,
    });
    this.memoryProposalTurns.delete(proposalId);
  }
  async deleteMemory(id: string): Promise<void> {
    const memory = this.options.memory;
    if (!memory) throw new Error("Memory is not configured");
    const access = { sessionId: this.sessionId, ...memory.access };
    if (
      memory.policy &&
      (await memory.policy.evaluate({
        action: "delete",
        record: {
          id,
          binding: { scope: "session", sessionId: this.sessionId },
          kind: "fact",
          content: "",
          tags: [],
          source: { sessionId: this.sessionId },
          createdAt: "",
          updatedAt: "",
        },
        access,
      })) === "deny"
    )
      throw new Error("Memory deletion denied by policy");
    await memory.store.delete(id, access);
    await this.options.eventStore.append({
      type: "memory.deleted",
      at: now(),
      operationId: `memory_op_${randomId()}`,
      memoryId: id,
    });
  }

  /** 返回当前会话已累积的消息历史，只读视图不允许替换消息数组。 */
  getMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  /** 驱动完整回合：构建上下文、流式请求模型，并按需执行工具调用。 */
  private async drive(
    input: string | AgentMessage,
    parentSignal: AbortSignal | undefined,
    queue: AsyncQueue<TransportEvent>,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = this.options.turnTimeoutMs
      ? setTimeout(() => controller.abort(new Error("turn timeout")), this.options.turnTimeoutMs)
      : undefined;
    const turnId = `turn_${randomId()}`;
    try {
      await this.persist({ type: "turn.started", turnId, at: now() }, queue);
      await this.setState("building-context", queue);
      const user = typeof input === "string" ? message("user", [{ type: "text", text: input }]) : input;
      this.messages.push(user);
      await this.persist({ type: "message.appended", message: user }, queue);

      const turnContext = await this.resolveExtensions(turnId, user, queue);
      for (let step = 0; step < this.options.maxSteps; step += 1) {
        throwIfAborted(controller.signal);
        await this.setState("streaming", queue);
        const response = await this.collectModelResponse(controller.signal, queue, turnContext);
        if (response.calls.length === 0) {
          if (response.finish !== "stop") {
            await this.interrupt(response.finish === "length" ? "step-limit" : "aborted", queue, turnId);
            return;
          }
          const assistant = message("assistant", response.text ? [{ type: "text", text: response.text }] : []);
          this.messages.push(assistant);
          await this.persist({ type: "message.appended", message: assistant }, queue);
          await this.setState("completed", queue);
          await this.persist({ type: "turn.completed", turnId, messageId: assistant.id }, queue);
          await this.proposeMemories(turnId, queue);
          return;
        }

        const content = [
          response.text ? { type: "text" as const, text: response.text } : undefined,
          ...response.calls.map((call) => ({ type: "tool-call" as const, call })),
        ].filter((part): part is NonNullable<typeof part> => Boolean(part));
        const assistant = message("assistant", content);
        this.messages.push(assistant);
        await this.persist({ type: "message.appended", message: assistant }, queue);
        for (const call of response.calls) await this.executeCall(call, controller.signal, queue, turnContext);
        await this.setState("building-context", queue);
      }
      await this.interrupt("step-limit", queue, turnId);
    } catch (error) {
      if (controller.signal.aborted)
        await this.interrupt(isTurnTimeout(controller.signal.reason) ? "turn-timeout" : "aborted", queue, turnId);
      else {
        await this.setState("failed", queue);
        await this.persist({ type: "turn.failed", turnId, error: toAgentError(error) }, queue);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  /**
   * 流式收集模型响应；文本和工具调用增量立即发送到队列，
   * 完整工具调用则留待本回合后续执行。
   */
  private async collectModelResponse(
    signal: AbortSignal,
    queue: AsyncQueue<TransportEvent>,
    turnContext: TurnExtensionContext,
  ): Promise<{ text: string; calls: ToolCall[]; finish?: "stop" | "tool-use" | "length" }> {
    let text = "";
    const calls: ToolCall[] = [];
    let finish: "stop" | "tool-use" | "length" | undefined;
    const tools = [...turnContext.effectiveTools];
    const prepared = await this.contextManager.prepare(this.messages, turnContext.injectedMessages, tools);
    if (prepared.snapshot) {
      await this.setState("compacting", queue);
      // The prepared request also contains ephemeral extensions; only the compacted
      // conversation snapshot is durable session history.
      this.messages.splice(0, this.messages.length, ...prepared.snapshot.messages);
      await this.persist(
        { type: "context.compacted", snapshot: prepared.snapshot, replacesThroughSequence: this.sequence },
        queue,
      );
      await this.setState("streaming", queue);
    }
    const request = { messages: prepared.messages, tools, maxOutputTokens: this.options.context?.maxOutputTokens };
    for await (const delta of this.options.model.stream(request, { signal })) {
      throwIfAborted(signal);
      if (delta.type === "text-delta") {
        text += delta.text;
        queue.push({ type: "model.text.delta", text: delta.text });
      } else if (delta.type === "tool-call-delta")
        queue.push({ type: "model.tool-call.delta", id: delta.id, inputTextDelta: delta.inputTextDelta });
      else if (delta.type === "tool-call") calls.push({ id: delta.id, name: delta.name, input: delta.input });
      else if (delta.type === "finish") finish = delta.reason;
    }
    return { text, calls, finish };
  }

  /** 记录工具请求、校验参数、执行调用，并把结果追加为工具消息。 */
  private async executeCall(
    call: ToolCall,
    signal: AbortSignal,
    queue: AsyncQueue<TransportEvent>,
    turnContext: TurnExtensionContext,
  ): Promise<void> {
    await this.persist({ type: "tool.requested", call }, queue);
    const tool = this.tools.get(call.name);
    let result: ToolResult;
    if (!tool) result = failure("TOOL_NOT_FOUND", `Unknown tool: ${call.name}`);
    else if (!turnContext.effectiveTools.some((definition) => definition.name === call.name))
      result = failure(
        "TOOL_DISABLED_BY_SKILL",
        `Active skills restrict ${call.name}. Visible tools: ${turnContext.effectiveTools.map((definition) => definition.name).join(", ") || "none"}`,
      );
    else {
      const validation = validateJsonSchema(tool.inputSchema, call.input);
      result = validation.valid
        ? await this.executeAuthorized(tool, call, signal, queue)
        : failure("INVALID_TOOL_INPUT", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    }
    result = await this.controlResult(result);
    await this.persist({ type: "tool.completed", callId: call.id, result }, queue);
    const toolMessage = message("tool", [{ type: "tool-result", callId: call.id, result }]);
    this.messages.push(toolMessage);
    await this.persist({ type: "message.appended", message: toolMessage }, queue);
  }

  /** 根据权限策略处理拒绝、询问或放行后，在超时限制内执行工具。 */
  private async executeAuthorized(
    tool: Tool,
    call: ToolCall,
    signal: AbortSignal,
    queue: AsyncQueue<TransportEvent>,
  ): Promise<ToolResult> {
    const rules = this.options.permissions?.store
      ? await this.options.permissions.store.listRules({ workspace: this.options.workspace, tool: tool.name })
      : [];
    const policy = this.options.permissions?.policy ?? new DefaultPermissionPolicy();
    const verdict = await policy.evaluate({ tool, call, workspace: this.options.workspace, rules });
    if (verdict.type === "deny") return failure("PERMISSION_DENIED", verdict.reason ?? `Policy denied ${tool.name}`);
    if (verdict.type === "ask") {
      const request: PermissionRequest = {
        id: `permission_${randomId()}`,
        tool: tool.name,
        risk: tool.risk,
        scope: { workspace: this.options.workspace, ...verdict.scope },
        expiresAt: new Date(Date.now() + (this.options.permissions?.permissionTimeoutMs ?? 300_000)).toISOString(),
      };
      await this.setState("awaiting-permission", queue);
      await this.persist({ type: "permission.requested", request }, queue);
      const decision = await this.waitForPermission(request, signal);
      await this.persist({ type: "permission.resolved", requestId: request.id, decision }, queue);
      if (decision.type === "allow-with-rule" && this.options.permissions?.store)
        await this.options.permissions.store.createRule(decision.rule);
      if (decision.type === "deny")
        return failure("PERMISSION_DENIED", decision.reason ?? `Permission denied for ${tool.name}`);
    }
    throwIfAborted(signal);
    await this.setState("executing-tool", queue);
    const toolController = new AbortController();
    const onAbort = () => toolController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => toolController.abort(new Error("tool timeout")), this.options.toolTimeoutMs);
    try {
      return await tool.execute(call.input, {
        sessionId: this.sessionId,
        callId: call.id,
        signal: toolController.signal,
        workspace: this.options.workspace,
        emit: (event) => queue.push({ type: "tool.progress", callId: call.id, ...event }),
      });
    } catch (error) {
      return failure(
        toolController.signal.aborted ? "TOOL_TIMEOUT" : "TOOL_EXECUTION_FAILED",
        error instanceof Error ? error.message : "Tool failed",
        !toolController.signal.aborted,
      );
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** 等待外部权限决策；超时或回合取消时清理挂起请求。 */
  private async waitForPermission(request: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const timeoutMs = Math.max(0, Date.parse(request.expiresAt) - Date.now());
    return new Promise<PermissionDecision>((resolve, reject) => {
      const finish = (decision: PermissionDecision) => {
        cleanup();
        resolve(decision);
      };
      const onAbort = () => {
        cleanup();
        reject(signal.reason ?? new Error("aborted"));
      };
      const timer = setTimeout(() => finish({ type: "deny", reason: "Permission request timed out" }), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pendingPermissions.delete(request.id);
      };
      this.pendingPermissions.set(request.id, { settled: false, resolve: finish });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * 限制工具结果的内联长度；超出时可将完整结果存入工件存储，
   * 并返回可展示的预览和检索提示。
   */
  private async controlResult(result: ToolResult): Promise<ToolResult> {
    const serialized = JSON.stringify(result);
    if (serialized.length <= this.options.maxToolResultChars) return result;
    const artifact = this.options.artifactStore
      ? await this.options.artifactStore.put(serialized, { mediaType: "application/json" })
      : undefined;
    const preview = serialized.slice(0, this.options.maxToolResultChars);
    const omitted = serialized.length - preview.length;
    if (!result.ok)
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `${preview}\n[${omitted} characters omitted${artifact ? `; artifact ${artifact.id}` : ""}]`,
          },
        ],
      };
    return {
      ok: true,
      content: [{ type: "text", text: preview }],
      artifact,
      truncated: {
        omitted,
        retrievalHint: artifact ? `Retrieve artifact ${artifact.id}` : "Result was truncated by the host",
      },
    };
  }

  /** Resolves optional skills and memory exactly once at the start of a turn. */
  private async resolveExtensions(
    turnId: string,
    user: AgentMessage,
    queue: AsyncQueue<TransportEvent>,
  ): Promise<TurnExtensionContext> {
    const injectedMessages: TurnExtensionContext["injectedMessages"][number][] = [];
    const activeSkills: TurnExtensionContext["activeSkills"][number][] = [];
    let effectiveTools = this.tools.definitions();
    const query =
      user.role === "user"
        ? user.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim()
        : "";
    if (this.options.skills) {
      const catalog = await this.options.skills.list();
      const maxChars = this.options.context?.skillCatalogMaxChars ?? 4_000;
      let catalogueText = catalog
        .map(
          (skill) =>
            `- ${skill.name}: ${skill.description}${skill.triggers?.length ? ` [${skill.triggers.join(", ")}]` : ""}`,
        )
        .join("\n");
      const catalogTruncated = catalogueText.length > maxChars;
      catalogueText = catalogueText.slice(0, maxChars);
      if (catalogueText)
        injectedMessages.push({ kind: "skill-catalog", role: "user", source: {}, content: catalogueText });
      await this.persist(
        {
          type: "skill.catalog.presented",
          turnId,
          at: now(),
          skills: catalog.map(({ name, version }) => ({ name, version })),
          truncated: catalogTruncated,
        },
        queue,
      );
      const matched = query ? await this.options.skills.match(query, catalog) : [];
      for (const metadata of matched) {
        const explicit = new RegExp(`(^|\\s)/${escapeRegex(metadata.name)}(?=\\s|$)`, "i").test(query);
        await this.persist(
          { type: "skill.matched", turnId, at: now(), name: metadata.name, source: explicit ? "explicit" : "trigger" },
          queue,
        );
        const skill = await this.options.skills.load(metadata.name);
        if (!skill) continue;
        activeSkills.push(skill);
        injectedMessages.push({
          kind: "skill-instructions",
          role: "user",
          source: { skillName: skill.name },
          content: skill.instructions,
        });
        await this.persist(
          {
            type: "skill.loaded",
            turnId,
            at: now(),
            name: skill.name,
            version: skill.version,
            contentHash: simpleHash(skill.instructions),
          },
          queue,
        );
      }
      const limited = activeSkills.filter((skill) => skill.allowedTools !== undefined);
      if (limited.length) {
        const allowed = new Set(limited.flatMap((skill) => skill.allowedTools ?? []));
        effectiveTools = effectiveTools.filter((tool) => allowed.has(tool.name));
      }
    }
    const retrievedMemories: TurnExtensionContext["retrievedMemories"][number][] = [];
    if (this.options.memory && query) {
      const access = { sessionId: this.sessionId, ...this.options.memory.access };
      const scopes = this.options.memory.scopes ?? ["session", "project", "user"];
      const found = await this.options.memory.store.search(query, {
        scopes,
        limit: this.options.memory.searchLimit ?? 8,
        access,
      });
      retrievedMemories.push(...found);
      if (found.length)
        injectedMessages.push({
          kind: "memory",
          role: "user",
          source: { memoryIds: found.map((record) => record.id) },
          content: found
            .map(
              (record) =>
                `Memory ${record.id} (${record.kind}; source session ${record.source.sessionId}): ${record.content}`,
            )
            .join("\n"),
        });
      await this.persist(
        {
          type: "memory.retrieved",
          turnId,
          at: now(),
          queryPresent: true,
          memoryIds: found.map((record) => record.id),
        },
        queue,
      );
    }
    return { activeSkills, retrievedMemories, effectiveTools, injectedMessages };
  }

  private async proposeMemories(turnId: string, queue: AsyncQueue<TransportEvent>): Promise<void> {
    if (!this.options.memory?.extractor) return;
    const access = { sessionId: this.sessionId, ...this.options.memory.access };
    const scopes = this.options.memory.scopes ?? ["session"];
    for (const record of await this.options.memory.extractor.extract({
      turnId,
      messages: this.messages,
      access,
      scopes,
    })) {
      if (
        this.options.memory.policy &&
        (await this.options.memory.policy.evaluate({ action: "propose", record, access })) === "deny"
      )
        continue;
      const proposal = await this.options.memory.store.propose(
        { id: `proposal_${randomId()}`, record, sourceTurnId: turnId, createdAt: now() },
        access,
      );
      this.memoryProposalTurns.set(proposal.id, turnId);
      await this.persist(
        { type: "memory.proposed", turnId, at: now(), proposalId: proposal.id, kind: proposal.record.kind },
        queue,
      );
    }
  }

  /** 将当前回合标记为中断，并持久化中断原因。 */
  private async interrupt(
    reason: "aborted" | "permission-timeout" | "step-limit" | "turn-timeout",
    queue: AsyncQueue<TransportEvent>,
    turnId: string,
  ): Promise<void> {
    await this.setState("interrupted", queue);
    await this.persist({ type: "turn.interrupted", turnId, reason }, queue);
  }
  /** 更新内存状态并写入对应的状态变更事件。 */
  private async setState(state: SessionState, queue: AsyncQueue<TransportEvent>): Promise<void> {
    this.state = state;
    await this.persist({ type: "session.state.changed", state }, queue);
  }
  /** 先追加持久化事件，成功后再推送给订阅者，保证事件顺序。 */
  private async persist(event: DurableEvent, queue: AsyncQueue<TransportEvent>): Promise<void> {
    const stored = await this.options.eventStore.append(event);
    this.sequence = stored.sequence;
    queue.push(event);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function simpleHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 33) ^ value.charCodeAt(i);
  return (hash >>> 0).toString(16);
}

/** 创建带唯一标识和时间戳的会话消息。 */
function message(role: AgentMessage["role"], content: AgentMessage["content"]): AgentMessage {
  return { id: `message_${randomId()}`, role, content, createdAt: now() };
}
/** 将工具失败信息统一转换为标准工具结果。 */
function failure(code: string, message: string, retryable = false): ToolFailure {
  return { ok: false, error: { code, message, retryable }, content: [{ type: "text", text: `${code}: ${message}` }] };
}
/** 生成会话内使用的轻量随机标识符。 */
function randomId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 生成事件和消息使用的 ISO 8601 时间戳。 */
function now(): string {
  return new Date().toISOString();
}
/** 在取消信号触发时立即抛出其原因，终止当前异步流程。 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
}
/** 区分回合超时与其他主动取消原因。 */
function isTurnTimeout(reason: unknown): boolean {
  return reason instanceof Error && reason.message === "turn timeout";
}
/** 将未知异常转换为可持久化的回合错误结构。 */
function toAgentError(error: unknown): { code: string; message: string; cause?: unknown } {
  return {
    code: "TURN_FAILED",
    message: error instanceof Error ? error.message : "Unknown turn failure",
    cause: error,
  };
}
