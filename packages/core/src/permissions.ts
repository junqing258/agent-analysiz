import type { PermissionPolicy, PermissionPolicyResult, PermissionRule, PermissionStore, Tool } from "./types.js";

/** Safe default: reads proceed; every state-changing or external action asks. */
export class DefaultPermissionPolicy implements PermissionPolicy {
  async evaluate({
    tool,
    rules,
  }: {
    tool: Tool;
    call: unknown;
    workspace?: string;
    rules: PermissionRule[];
  }): Promise<PermissionPolicyResult> {
    if (tool.risk === "read") return { type: "allow" };
    const now = Date.now();
    if (rules.some((rule) => rule.tool === tool.name && rule.risk === tool.risk && Date.parse(rule.expiresAt) > now))
      return { type: "allow" };
    return { type: "ask" };
  }
}

/** A deterministic in-memory store useful for CLIs, tests, and embedding hosts. */
export class InMemoryPermissionStore implements PermissionStore {
  private readonly rules = new Map<string, PermissionRule>();
  async createRule(rule: PermissionRule) {
    validatePermissionRule(rule);
    this.rules.set(rule.id, rule);
    return rule;
  }
  async listRules(filter?: { workspace?: string; tool?: string }) {
    const now = Date.now();
    return [...this.rules.values()].filter(
      (rule) =>
        Date.parse(rule.expiresAt) > now &&
        (!filter?.tool || rule.tool === filter.tool) &&
        (!filter?.workspace || rule.scope.workspace === filter.workspace),
    );
  }
  async revokeRule(id: string) {
    this.rules.delete(id);
  }
}

/** Baseline validation adapters should apply before durable rule persistence. */
export function validatePermissionRule(rule: PermissionRule): void {
  if (
    !rule.id ||
    !rule.tool ||
    !Number.isFinite(Date.parse(rule.expiresAt)) ||
    Date.parse(rule.expiresAt) <= Date.now()
  )
    throw new Error("Permission rule must have an identifier, tool, and future expiry");
  const scope = rule.scope;
  const hasNarrowScope = Boolean(scope.pathPrefix || scope.executable || scope.argsPrefix?.length);
  if (!hasNarrowScope) throw new Error("Permission rule requires a path or argv scope");
  if (scope.pathPrefix === "/" || scope.pathPrefix === "*" || scope.executable === "*")
    throw new Error("Permission rule scope is too broad");
  if (scope.argsPrefix?.some((arg) => arg === "*"))
    throw new Error("Permission rule argv scope may not contain wildcards");
}
