import type { DurableEvent, EventStore, StoredEvent } from "@agent-sdk/core";

export interface ExtensionEventQuery {
  afterSequence?: number;
  turnId?: string;
  relatedTurnId?: string;
  types?: DurableEvent["type"][];
}
/** 读取仅用于审计的扩展事件，不修改恢复后的会话历史。 */
export async function queryExtensionEvents(
  store: EventStore,
  options: ExtensionEventQuery = {},
): Promise<StoredEvent[]> {
  const result: StoredEvent[] = [];
  for await (const entry of store.readAfter(options.afterSequence ?? 0)) {
    const event = entry.event as DurableEvent & { turnId?: string; relatedTurnId?: string };
    if (!event.type.startsWith("skill.") && !event.type.startsWith("memory.")) continue;
    if (options.types && !options.types.includes(event.type)) continue;
    if (options.turnId && event.turnId !== options.turnId) continue;
    if (options.relatedTurnId && event.relatedTurnId !== options.relatedTurnId) continue;
    result.push(entry);
  }
  return result;
}
