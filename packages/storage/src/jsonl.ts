import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DurableEvent, EventStore, StoredEvent } from "@agent-sdk/core";

/** 仅追加、以换行分隔 JSON 的事件存储；序列号分配会被串行化。 */
export class JsonlEventStore implements EventStore {
  private sequence?: number;
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly filePath: string) {}

  async append(event: DurableEvent): Promise<StoredEvent> {
    const result = await this.enqueue(async () => {
      const sequence = await this.nextSequence();
      const stored = { sequence, event } satisfies StoredEvent;
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(stored)}\n`, "utf8");
      return stored;
    });
    return result;
  }

  async *readAfter(sequence: number): AsyncIterable<StoredEvent> {
    let text: string;
    try { text = new TextDecoder().decode(await readFile(this.filePath)); } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as StoredEvent;
      if (entry.sequence > sequence) yield entry;
    }
  }

  private async nextSequence(): Promise<number> {
    if (this.sequence === undefined) {
      let max = 0;
      for await (const event of this.readAfter(0)) max = Math.max(max, event.sequence);
      this.sequence = max;
    }
    this.sequence += 1;
    return this.sequence;
  }
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.writes = this.writes.then(async () => { try { resolveResult(await operation()); } catch (error) { rejectResult(error); } });
    await this.writes;
    return result;
  }
}

export const jsonlEventStore = (filePath: string): JsonlEventStore => new JsonlEventStore(filePath);
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
