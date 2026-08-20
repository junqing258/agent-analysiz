import type {
  MemoryAccessContext,
  MemoryProposal,
  MemoryRecord,
  MemorySearchOptions,
  MemoryStore,
} from "@agent-sdk/core";

/** 小型、确定性的内存存储；应用可替换为基于 FTS 或向量检索的存储实现。 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly proposals = new Map<string, MemoryProposal>();
  async search(query: string, options: MemorySearchOptions): Promise<ReadonlyArray<MemoryRecord>> {
    const terms = tokenize(query);
    const now = Date.now();
    return [...this.records.values()]
      .filter(
        (record) =>
          options.scopes.includes(record.binding.scope) &&
          allowed(record.binding, options.access) &&
          (!record.expiresAt || Date.parse(record.expiresAt) > now),
      )
      .map((record) => ({ record, score: score(record, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt))
      .slice(0, options.limit)
      .map(({ record }) => clone(record));
  }
  async propose(proposal: MemoryProposal, access: MemoryAccessContext): Promise<MemoryProposal> {
    assertAllowed(proposal.record.binding, access);
    assertSafe(proposal.record.content);
    this.proposals.set(proposal.id, clone(proposal));
    return clone(proposal);
  }
  async confirm(proposalId: string, access: MemoryAccessContext): Promise<MemoryRecord> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Unknown memory proposal: ${proposalId}`);
    assertAllowed(proposal.record.binding, access);
    const stamp = new Date().toISOString();
    return {
      ...clone(proposal.record),
      id: `memory_${proposalId}`,
      createdAt: stamp,
      updatedAt: stamp,
    };
  }
  async reject(proposalId: string, access: MemoryAccessContext): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Unknown memory proposal: ${proposalId}`);
    assertAllowed(proposal.record.binding, access);
    this.proposals.delete(proposalId);
  }
  async upsert(record: MemoryRecord, access: MemoryAccessContext): Promise<MemoryRecord> {
    assertAllowed(record.binding, access);
    assertSafe(record.content);
    const duplicate = [...this.records.values()].find(
      (existing) =>
        sameBinding(existing.binding, record.binding) &&
        existing.kind === record.kind &&
        normalize(existing.content) === normalize(record.content),
    );
    const stored = {
      ...clone(record),
      id: duplicate?.id ?? record.id,
      createdAt: duplicate?.createdAt ?? record.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(stored.id, stored);
    return clone(stored);
  }
  async delete(id: string, access: MemoryAccessContext): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    assertAllowed(record.binding, access);
    this.records.delete(id);
  }
  async deleteScope(scope: MemoryRecord["binding"]["scope"], access: MemoryAccessContext): Promise<number> {
    let count = 0;
    for (const [id, record] of this.records)
      if (record.binding.scope === scope) {
        assertAllowed(record.binding, access);
        this.records.delete(id);
        count += 1;
      }
    return count;
  }
}
function allowed(binding: MemoryRecord["binding"], access: MemoryAccessContext): boolean {
  return binding.scope === "session"
    ? binding.sessionId === access.sessionId
    : binding.scope === "project"
      ? !!access.workspaceId && binding.workspaceId === access.workspaceId
      : !!access.userId && binding.userId === access.userId;
}
function assertAllowed(binding: MemoryRecord["binding"], access: MemoryAccessContext): void {
  if (!allowed(binding, access)) throw new Error("Memory access denied for binding");
}
function sameBinding(a: MemoryRecord["binding"], b: MemoryRecord["binding"]): boolean {
  return (
    a.scope === b.scope &&
    (a.scope === "session"
      ? b.scope === "session" && a.sessionId === b.sessionId
      : a.scope === "project"
        ? b.scope === "project" && a.workspaceId === b.workspaceId
        : b.scope === "user" && a.userId === b.userId)
  );
}
function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 1);
}
function normalize(value: string): string {
  return value.toLocaleLowerCase().trim().replace(/\s+/gu, " ");
}
function score(record: MemoryRecord, terms: string[]): number {
  const haystack = normalize(`${record.content} ${record.tags.join(" ")}`);
  return terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
}
function assertSafe(content: string): void {
  if (!content.trim() || content.length > 8_000)
    throw new Error("Memory content must be non-empty and at most 8000 characters");
  if (/(?:api[_ -]?key|password|access[_ -]?token|secret)\s*[:=]/iu.test(content))
    throw new Error("Memory content appears to contain a credential");
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
