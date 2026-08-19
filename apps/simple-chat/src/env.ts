import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cwd, env as processEnv } from "node:process";

export interface EnvLoadOptions { file?: string; startDirectory?: string; target?: Record<string, string | undefined>; }

/** Load the nearest .env without ever overwriting values supplied by the shell. */
export async function loadEnv(options: EnvLoadOptions = {}): Promise<string | undefined> {
  const start = resolve(options.startDirectory ?? cwd());
  const file = options.file ? resolve(start, options.file) : await findEnvFile(start);
  if (!file) return undefined;
  const values = parseDotEnv(new TextDecoder().decode(await readFile(file)));
  const target = options.target ?? processEnv;
  for (const [key, value] of Object.entries(values)) if (target[key] === undefined) target[key] = value;
  return file;
}

export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const equals = normalized.indexOf("=");
    if (equals < 1) throw new Error(`Invalid .env entry: ${rawLine}`);
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid .env key: ${key}`);
    const value = normalized.slice(equals + 1).trim();
    values[key] = unquote(value);
  }
  return values;
}

async function findEnvFile(start: string): Promise<string | undefined> {
  let directory = start;
  while (true) {
    const candidate = join(directory, ".env");
    try { await readFile(candidate); return candidate; }
    catch (error) { if (!isMissing(error)) throw error; }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trimEnd();
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
