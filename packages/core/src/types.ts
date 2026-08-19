import type { JsonSchema } from "@agent-sdk/schema";

export type { JsonSchema } from "@agent-sdk/schema";
/** 工具操作可能造成的风险等级，用于权限决策。 */
export type ToolRisk = "read" | "write" | "execute" | "external" | "agent";
/** Agent 会话在一个回合中的运行阶段。 */
export type SessionState =
  | "idle"
  | "building-context"
  | "streaming"
  | "awaiting-permission"
  | "executing-tool"
  | "compacting"
  | "completed"
  | "interrupted"
  | "failed";
/** 已中断回合的可持久化原因。 */
export type InterruptReason = "aborted" | "permission-timeout" | "step-limit" | "turn-timeout";

/** 模型请求执行工具时给出的调用标识、名称和参数。 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
/** 工具结果中可由宿主展示的内容片段。 */
export type ToolContent<T = unknown> = { type: "text"; text: string } | { type: "json"; value: T };
/** 外部工件的内容寻址引用。 */
export interface ArtifactRef {
  id: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
}
/** 工具成功时的标准返回结构。 */
export interface ToolSuccess<T = unknown> {
  ok: true;
  content: ToolContent<T>[];
  artifact?: ArtifactRef;
  truncated?: { omitted: number; retrievalHint: string };
}
/** 工具失败时的标准返回结构。 */
export interface ToolFailure {
  ok: false;
  error: { code: string; message: string; retryable: boolean; hint?: string };
  content: Array<{ type: "text"; text: string }>;
}
/** 工具调用的成功或失败结果。 */
export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

/** 工具执行期间上报给调用方的进度信息。 */
export interface ToolProgressEvent {
  message: string;
  percent?: number;
}
/** 工具执行时可使用的会话上下文和进度上报接口。 */
export interface ToolContext {
  sessionId: string;
  callId: string;
  signal: AbortSignal;
  workspace?: string;
  emit(event: ToolProgressEvent): void;
}
/** 可被模型选择并由会话执行的工具定义。 */
export interface Tool<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  parallelSafe?: boolean;
  idempotency?: "never" | "safe";
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TResult>>;
}
/** 保留工具泛型信息的声明辅助函数。 */
export function defineTool<TInput, TResult>(tool: Tool<TInput, TResult>): Tool<TInput, TResult> {
  return tool;
}

/** 会话历史中支持的内容片段。 */
export type MessageContent =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; callId: string; result: ToolResult };
/** 传递给模型、存储和宿主的统一会话消息。 */
export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent[];
  createdAt: string;
}
/** 提供给模型的、与具体工具实现无关的工具描述。 */
export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}
/** 发起模型流式调用所需的消息、工具和输出预算。 */
export interface ModelRequest {
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
  maxOutputTokens?: number;
}
/** 请求模型或估算器计算上下文 token 数量的输入。 */
export interface TokenEstimateInput {
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
}
/** token 数量及其来源。 */
export interface TokenEstimate {
  tokens: number;
  source: "provider" | "heuristic";
}
/** 模型流中可能出现的文本、工具调用、用量和结束增量。 */
export type ModelDelta =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; id: string; name?: string; inputTextDelta: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: "stop" | "tool-use" | "length" };
/** 模型提供方的流式调用与可选 token 估算接口。 */
export interface ModelGateway {
  stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelDelta>;
  estimateTokens?(input: TokenEstimateInput): Promise<TokenEstimate>;
}

/** 权限规则可限定的工作区、路径或命令参数范围。 */
export interface PermissionScope {
  workspace?: string;
  pathPrefix?: string;
  executable?: string;
  argsPrefix?: string[];
}
/** 可持久化的、具备过期时间的权限授权规则。 */
export interface PermissionRule {
  id: string;
  tool: string;
  risk: ToolRisk;
  scope: PermissionScope;
  expiresAt: string;
}
/** 权限规则的持久化存取接口。 */
export interface PermissionStore {
  createRule(rule: PermissionRule): Promise<PermissionRule>;
  listRules(filter?: { workspace?: string; tool?: string }): Promise<PermissionRule[]>;
  revokeRule(id: string): Promise<void>;
}
/** 需要宿主或用户作出决定的权限请求。 */
export interface PermissionRequest {
  id: string;
  tool: string;
  risk: ToolRisk;
  scope: PermissionScope;
  expiresAt: string;
}
/** 宿主对权限请求给出的一次性允许、持久规则或拒绝决定。 */
export type PermissionDecision =
  { type: "allow-once" } | { type: "allow-with-rule"; rule: PermissionRule } | { type: "deny"; reason?: string };
/** 权限策略针对工具调用给出的判断结果。 */
export type PermissionPolicyResult =
  { type: "allow" } | { type: "deny"; reason?: string } | { type: "ask"; scope?: PermissionScope };
/** 按工具、调用和现有规则评估权限的策略接口。 */
export interface PermissionPolicy {
  evaluate(input: {
    tool: Tool;
    call: ToolCall;
    workspace?: string;
    rules: PermissionRule[];
  }): Promise<PermissionPolicyResult>;
}

/** 可持久化的 Agent 回合失败信息。 */
export interface AgentError {
  code: string;
  message: string;
  cause?: unknown;
}
/** 上下文压缩后保存的摘要、消息和文件状态。 */
export interface ContextSnapshot {
  summary: string;
  messages: AgentMessage[];
  fileState: Record<string, { version: string; ranges: string[] }>;
}
/** 需要写入事件存储以恢复会话的业务事件。 */
export type DurableEvent =
  | { type: "turn.started"; turnId: string; at: string }
  | { type: "message.appended"; message: AgentMessage }
  | { type: "tool.requested"; call: ToolCall }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }
  | { type: "tool.completed"; callId: string; result: ToolResult }
  | { type: "context.compacted"; snapshot: ContextSnapshot; replacesThroughSequence: number }
  | { type: "session.state.changed"; state: SessionState }
  | { type: "turn.completed"; messageId: string }
  | { type: "turn.interrupted"; reason: InterruptReason }
  | { type: "turn.failed"; error: AgentError };
/** 发给调用方的事件，包含持久化事件及不持久化的实时增量。 */
export type TransportEvent =
  | DurableEvent
  | { type: "model.text.delta"; text: string }
  | { type: "model.tool-call.delta"; id: string; inputTextDelta: string }
  | { type: "tool.progress"; callId: string; message: string; percent?: number };
/** 带单调递增序列号的持久化事件记录。 */
export interface StoredEvent {
  sequence: number;
  event: DurableEvent;
}
/** 支持追加和按序读取的会话事件存储。 */
export interface EventStore {
  append(event: DurableEvent): Promise<StoredEvent>;
  readAfter(sequence: number): AsyncIterable<StoredEvent>;
}
/** 存储和读取超大工具结果等二进制工件的接口。 */
export interface ArtifactStore {
  put(value: Uint8Array | string, options: { mediaType: string }): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Uint8Array>;
}

/** 上下文窗口、输出预算和保留消息数的配置。 */
export interface ContextOptions {
  system?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  retainRecentMessages?: number;
}
/**
 * 创建 Agent 会话所需的依赖与运行配置；`model` 和 `eventStore` 为必填，
 * 其余字段用于配置工具、上下文、权限及单轮执行限制。
 */
export interface AgentSessionOptions {
  model: ModelGateway;
  tools?: Tool[];
  context?: ContextOptions;
  permissions?: { policy?: PermissionPolicy; store?: PermissionStore; permissionTimeoutMs?: number };
  eventStore: EventStore;
  artifactStore?: ArtifactStore;
  sessionId?: string;
  /** 宿主在下一次用户回合前恢复的持久化消息。 */
  initialMessages?: AgentMessage[];
  workspace?: string;
  maxSteps?: number;
  toolTimeoutMs?: number;
  turnTimeoutMs?: number;
  maxToolResultChars?: number;
}
