import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Skill, SkillMetadata, SkillProvider } from "@agent-sdk/core";

/** Filesystem-backed provider for a host-approved skills root. */
export class FileSystemSkillProvider implements SkillProvider {
  private readonly skills = new Map<string, Skill>();
  constructor(private readonly root: string) {}
  async list(): Promise<ReadonlyArray<SkillMetadata>> {
    await this.discover();
    return [...this.skills.values()].map(({ instructions: _instructions, ...metadata }) => metadata);
  }
  async match(input: string, skills: ReadonlyArray<SkillMetadata>): Promise<ReadonlyArray<SkillMetadata>> {
    const explicit = skills.filter((skill) =>
      new RegExp(`(^|\\s)/${escapeRegex(skill.name)}(?=\\s|$)`, "i").test(input),
    );
    if (explicit.length) return explicit;
    const lowered = input.toLocaleLowerCase();
    return skills.filter((skill) => skill.triggers?.some((trigger) => lowered.includes(trigger.toLocaleLowerCase())));
  }
  async load(name: string): Promise<Skill | undefined> {
    await this.discover();
    return this.skills.get(name);
  }
  private async discover(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.includes("..") || entry.includes("/") || entry.includes("\\")) continue;
      const file = resolve(this.root, entry, "SKILL.md");
      if (!inside(this.root, file)) continue;
      try {
        const parsed = parseSkill(new TextDecoder().decode(await readFile(file)), resolve(this.root, entry));
        this.skills.set(parsed.name, parsed);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }
}

export function parseSkill(text: string, root: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (!match) throw new Error("SKILL.md requires YAML frontmatter");
  const fields = parseFrontmatter(match[1] ?? "");
  if (typeof fields.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(fields.name))
    throw new Error("Skill frontmatter requires a valid name");
  if (typeof fields.description !== "string") throw new Error("Skill frontmatter requires description");
  return {
    name: fields.name,
    description: fields.description,
    triggers: stringArray(fields.triggers),
    allowedTools: stringArray(fields.allowedTools),
    version:
      typeof fields.version === "string" || typeof fields.version === "number" ? String(fields.version) : undefined,
    root,
    instructions: match[2] ?? "",
  };
}

function parseFrontmatter(source: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let active: string | undefined;
  for (const line of source.split(/\r?\n/u)) {
    const item = /^\s*-\s*(.+)$/u.exec(line);
    if (item && active) {
      const values = fields[active] as string[];
      values.push(unquote(item[1] ?? ""));
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u.exec(line);
    if (!field) continue;
    const name = field[1];
    if (!name) continue;
    active = name;
    const value = field[2] ?? "";
    fields[name] = value
      ? value.startsWith("[")
        ? value
            .slice(1, -1)
            .split(",")
            .map((part) => unquote(part.trim()))
            .filter(Boolean)
        : unquote(value)
      : [];
  }
  return fields;
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
function unquote(value: string): string {
  return value.replace(/^(?:"|')|(?:"|')$/gu, "");
}
function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), target);
  return rel !== "" && !rel.startsWith("..") && !rel.includes("../");
}
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function missing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"
  );
}
