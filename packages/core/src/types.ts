import type { JsonSchema } from "@agent-sdk/schema";

export type { JsonSchema } from "@agent-sdk/schema";
export type ToolRisk = "read" | "write" | "execute" | "external" | "agent";
export type SessionState = "idle" | "building-context" | "streaming" | "awaiting-permission" | "executing-tool" | "compacting" | "completed" | "interrupted" | "failed";
export type InterruptReason = "aborted" | "permission-timeout" | "step-limit" | "turn-timeout";

export interface ToolCall { id: string; name: string; input: unknown; }
export type ToolContent<T = unknown> = { type: "text"; text: string } | { type: "json"; value: T };
export interface ArtifactRef { id: string; sha256: string; mediaType: string; byteLength: number; }
export interface ToolSuccess<T = unknown> { ok: true; content: ToolContent<T>[]; artifact?: ArtifactRef; truncated?: { omitted: number; retrievalHint: string }; }
export interface ToolFailure { ok: false; error: { code: string; message: string; retryable: boolean; hint?: string }; content: Array<{ type: "text"; text: string }>; }
export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

export interface ToolProgressEvent { message: string; percent?: number; }
export interface ToolContext { sessionId: string; callId: string; signal: AbortSignal; workspace?: string; emit(event: ToolProgressEvent): void; }
export interface Tool<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  parallelSafe?: boolean;
  idempotency?: "never" | "safe";
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TResult>>;
}
export function defineTool<TInput, TResult>(tool: Tool<TInput, TResult>): Tool<TInput, TResult> { return tool; }

export type MessageContent = { type: "text"; text: string } | { type: "tool-call"; call: ToolCall } | { type: "tool-result"; callId: string; result: ToolResult };
export interface AgentMessage { id: string; role: "system" | "user" | "assistant" | "tool"; content: MessageContent[]; createdAt: string; }
export interface ModelToolDefinition { name: string; description: string; inputSchema: JsonSchema; }
export interface ModelRequest { messages: AgentMessage[]; tools: ModelToolDefinition[]; maxOutputTokens?: number; }
export interface TokenEstimateInput { messages: AgentMessage[]; tools: ModelToolDefinition[]; }
export interface TokenEstimate { tokens: number; source: "provider" | "heuristic"; }
export type ModelDelta =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; id: string; name?: string; inputTextDelta: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: "stop" | "tool-use" | "length" };
export interface ModelGateway { stream(request: ModelRequest, options: { signal: AbortSignal }): AsyncIterable<ModelDelta>; estimateTokens?(input: TokenEstimateInput): Promise<TokenEstimate>; }

export interface PermissionScope { workspace?: string; pathPrefix?: string; executable?: string; argsPrefix?: string[]; }
export interface PermissionRule { id: string; tool: string; risk: ToolRisk; scope: PermissionScope; expiresAt: string; }
export interface PermissionStore { createRule(rule: PermissionRule): Promise<PermissionRule>; listRules(filter?: { workspace?: string; tool?: string }): Promise<PermissionRule[]>; revokeRule(id: string): Promise<void>; }
export interface PermissionRequest { id: string; tool: string; risk: ToolRisk; scope: PermissionScope; expiresAt: string; }
export type PermissionDecision = { type: "allow-once" } | { type: "allow-with-rule"; rule: PermissionRule } | { type: "deny"; reason?: string };
export type PermissionPolicyResult = { type: "allow" } | { type: "deny"; reason?: string } | { type: "ask"; scope?: PermissionScope };
export interface PermissionPolicy { evaluate(input: { tool: Tool; call: ToolCall; workspace?: string; rules: PermissionRule[] }): Promise<PermissionPolicyResult>; }

export interface AgentError { code: string; message: string; cause?: unknown; }
export interface ContextSnapshot { summary: string; messages: AgentMessage[]; fileState: Record<string, { version: string; ranges: string[] }>; }
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
export type TransportEvent = DurableEvent | { type: "model.text.delta"; text: string } | { type: "model.tool-call.delta"; id: string; inputTextDelta: string } | { type: "tool.progress"; callId: string; message: string; percent?: number };
export interface StoredEvent { sequence: number; event: DurableEvent; }
export interface EventStore { append(event: DurableEvent): Promise<StoredEvent>; readAfter(sequence: number): AsyncIterable<StoredEvent>; }
export interface ArtifactStore { put(value: Uint8Array | string, options: { mediaType: string }): Promise<ArtifactRef>; get(ref: ArtifactRef): Promise<Uint8Array>; }

export interface ContextOptions { system?: string; contextWindowTokens?: number; maxOutputTokens?: number; retainRecentMessages?: number; }
export interface AgentSessionOptions {
  model: ModelGateway;
  tools?: Tool[];
  context?: ContextOptions;
  permissions?: { policy?: PermissionPolicy; store?: PermissionStore; permissionTimeoutMs?: number };
  eventStore: EventStore;
  artifactStore?: ArtifactStore;
  sessionId?: string;
  /** Durable messages restored by a host before the next user turn. */
  initialMessages?: AgentMessage[];
  workspace?: string;
  maxSteps?: number;
  toolTimeoutMs?: number;
  turnTimeoutMs?: number;
  maxToolResultChars?: number;
}
