import type { AgentMessage, ContextSnapshot, DurableEvent, EventStore, StoredEvent, ToolResult } from "@agent-sdk/core";

export interface RecoveredSession { snapshot?: ContextSnapshot; messages: AgentMessage[]; lastSequence: number; incompleteCallIds: string[]; }

/** 从最新的压缩检查点回放持久化状态，绝不重新执行工具。 */
export async function recoverSession(store: EventStore): Promise<RecoveredSession> {
  const all: StoredEvent[] = [];
  for await (const event of store.readAfter(0)) all.push(event);
  let checkpoint = -1;
  for (let index = 0; index < all.length; index += 1) if (all[index]?.event.type === "context.compacted") checkpoint = index;
  const snapshot = checkpoint >= 0 && all[checkpoint]?.event.type === "context.compacted" ? (all[checkpoint]?.event as Extract<DurableEvent, { type: "context.compacted" }>).snapshot : undefined;
  const messages = snapshot ? [...snapshot.messages] : [];
  const requested = new Set<string>();
  const completed = new Set<string>();
  for (const stored of all.slice(checkpoint + 1)) {
    const event = stored.event;
    if (event.type === "message.appended") messages.push(event.message);
    if (event.type === "tool.requested") requested.add(event.call.id);
    if (event.type === "tool.completed") completed.add(event.callId);
  }
  return { snapshot, messages, lastSequence: all.at(-1)?.sequence ?? 0, incompleteCallIds: [...requested].filter((id) => !completed.has(id)) };
}

/** 在恢复后的会话返回给模型前，持久化已中断调用的标记。 */
export async function markInterruptedTools(store: EventStore, recovered: RecoveredSession): Promise<void> {
  for (const callId of recovered.incompleteCallIds) {
    const result: ToolResult = { ok: false, error: { code: "TOOL_INTERRUPTED", message: "Tool was interrupted before completion; it was not retried.", retryable: true }, content: [{ type: "text", text: "TOOL_INTERRUPTED: tool was not automatically retried" }] };
    await store.append({ type: "tool.completed", callId, result });
  }
}
