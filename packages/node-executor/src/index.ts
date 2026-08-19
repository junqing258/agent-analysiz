import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "@agent-sdk/core";

export interface FileState {
  markRead(path: string, content: Uint8Array): void;
  hasRead(path: string): boolean;
}
export class InMemoryFileState implements FileState {
  private readonly readPaths = new Set<string>();
  markRead(path: string): void {
    this.readPaths.add(path);
  }
  hasRead(path: string): boolean {
    return this.readPaths.has(path);
  }
}

export function createNodeTools(workspace: string, fileState: FileState = new InMemoryFileState()): Tool[] {
  const absoluteWorkspace = resolve(workspace);
  const safePath = (requested: string): string => {
    const path = resolve(absoluteWorkspace, requested);
    const rel = relative(absoluteWorkspace, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("PATH_OUTSIDE_WORKSPACE");
    return path;
  };
  return [
    {
      name: "read",
      description: "Read a UTF-8 file inside the workspace.",
      risk: "read",
      inputSchema: {
        type: "object",
        required: ["path"],
        additionalProperties: false,
        properties: { path: { type: "string", minLength: 1 } },
      },
      async execute(input) {
        try {
          const path = safePath((input as { path: string }).path);
          const content = await readFile(path);
          fileState.markRead(path, content);
          return success(new TextDecoder().decode(content));
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "glob",
      description:
        "List direct file and directory names under a workspace-relative directory. This is intentionally non-recursive.",
      risk: "read",
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } } },
      async execute(input) {
        try {
          const path = safePath((input as { path?: string }).path ?? ".");
          return success(JSON.stringify((await readdir(path)).sort()));
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "grep",
      description:
        "Search UTF-8 files under a workspace-relative directory for literal text, returning capped matching lines.",
      risk: "read",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      async execute(input) {
        try {
          const value = input as { query: string; path?: string; maxResults?: number };
          const base = safePath(value.path ?? ".");
          const matches: string[] = [];
          const visit = async (directory: string): Promise<void> => {
            for (const name of await readdir(directory)) {
              if (matches.length >= (value.maxResults ?? 50)) return;
              const path = join(directory, name);
              const info = await stat(path);
              if (info.isFile()) {
                if (info.size > 1_000_000) continue;
                const lines = new TextDecoder().decode(await readFile(path)).split("\n");
                const display = relative(absoluteWorkspace, path);
                lines.forEach((line, index) => {
                  if (matches.length < (value.maxResults ?? 50) && line.includes(value.query))
                    matches.push(`${display}:${index + 1}:${line.slice(0, 500)}`);
                });
              } else await visit(path);
            }
          };
          await visit(base);
          return success(matches.join("\n"));
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "write",
      description: "Create a UTF-8 file, or replace a previously-read UTF-8 file, inside the workspace.",
      risk: "write",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        additionalProperties: false,
        properties: { path: { type: "string", minLength: 1 }, content: { type: "string" } },
      },
      async execute(input) {
        try {
          const path = safePath((input as { path: string }).path);
          if (await fileExists(path) && !fileState.hasRead(path)) return denied(path);
          await writeFile(path, (input as { content: string }).content);
          return success("File written.");
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "edit",
      description: "Perform one exact oldText/newText replacement in a previously-read UTF-8 file.",
      risk: "write",
      inputSchema: {
        type: "object",
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
          oldText: { type: "string" },
          newText: { type: "string" },
        },
      },
      async execute(input) {
        try {
          const value = input as { path: string; oldText: string; newText: string };
          const path = safePath(value.path);
          if (!fileState.hasRead(path)) return denied(path);
          const original = new TextDecoder().decode(await readFile(path));
          const first = original.indexOf(value.oldText);
          if (first < 0)
            return {
              ok: false,
              error: { code: "EDIT_TARGET_NOT_FOUND", message: "oldText was not found", retryable: true },
              content: [{ type: "text", text: "EDIT_TARGET_NOT_FOUND" }],
            };
          if (first !== original.lastIndexOf(value.oldText))
            return {
              ok: false,
              error: { code: "EDIT_TARGET_AMBIGUOUS", message: "oldText occurs more than once", retryable: true },
              content: [{ type: "text", text: "EDIT_TARGET_AMBIGUOUS" }],
            };
          await writeFile(path, original.replace(value.oldText, value.newText));
          return success("File edited.");
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}

export interface BashToolOptions {
  timeoutMs?: number;
  outputLimitBytes?: number;
  environment?: Record<string, string>;
}
/**
 * Execute structured argv only. It intentionally has no shell-string input,
 * shell:false, and no inheritance of the host environment unless provided.
 */
export function createBashTool(workspace: string, options: BashToolOptions = {}): Tool {
  const root = resolve(workspace);
  const limit = options.outputLimitBytes ?? 64 * 1024;
  return {
    name: "bash",
    description: "Run a structured executable and argv in the workspace. Shell syntax is not accepted.",
    risk: "execute",
    idempotency: "never",
    inputSchema: {
      type: "object",
      required: ["executable", "args", "cwd"],
      additionalProperties: false,
      properties: {
        executable: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string", minLength: 1 },
      },
    },
    async execute(input, context) {
      const command = input as { executable: string; args: string[]; cwd: string };
      const cwd = resolve(root, command.cwd);
      const rel = relative(root, cwd);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        return {
          ok: false,
          error: { code: "PATH_OUTSIDE_WORKSPACE", message: "Command cwd is outside the workspace", retryable: false },
          content: [{ type: "text", text: "PATH_OUTSIDE_WORKSPACE" }],
        };
      return new Promise<ToolResult>((resolveResult) => {
        let output = "";
        let truncated = false;
        let settled = false;
        const finish = (result: ToolResult) => {
          if (!settled) {
            settled = true;
            resolveResult(result);
          }
        };
        try {
          const child = spawn(command.executable, command.args, {
            cwd,
            shell: false,
            env: options.environment ?? {},
            stdio: ["ignore", "pipe", "pipe"],
          });
          const capture = (chunk: unknown) => {
            if (truncated) return;
            const text = String(chunk);
            const remaining = limit - output.length;
            output += text.slice(0, Math.max(0, remaining));
            if (text.length > remaining) truncated = true;
          };
          child.stdout.on("data", capture);
          child.stderr.on("data", capture);
          child.on("error", (error: Error) =>
            finish({
              ok: false,
              error: { code: "COMMAND_START_FAILED", message: error.message, retryable: false },
              content: [{ type: "text", text: error.message }],
            }),
          );
          child.on("close", (code: number | null) => {
            if (code === 0)
              finish({
                ok: true,
                content: [{ type: "text", text: output }],
                ...(truncated ? { truncated: { omitted: 1, retrievalHint: "Command output limit reached" } } : {}),
              });
            else
              finish({
                ok: false,
                error: { code: "COMMAND_FAILED", message: `Process exited with ${code}`, retryable: false },
                content: [{ type: "text", text: output }],
              });
          });
          context.signal.addEventListener(
            "abort",
            () => {
              child.kill("SIGTERM");
              finish({
                ok: false,
                error: { code: "COMMAND_ABORTED", message: "Process aborted", retryable: true },
                content: [{ type: "text", text: "COMMAND_ABORTED" }],
              });
            },
            { once: true },
          );
        } catch (error) {
          finish(failure(error));
        }
      });
    },
  };
}

function success(text: string): ToolResult {
  return { ok: true, content: [{ type: "text", text }] };
}
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
function denied(path: string): ToolResult {
  return {
    ok: false,
    error: { code: "FILE_NOT_READ", message: `Read ${path} before modifying it`, retryable: true },
    content: [{ type: "text", text: "FILE_NOT_READ" }],
  };
}
function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : "File operation failed";
  return {
    ok: false,
    error: {
      code: message === "PATH_OUTSIDE_WORKSPACE" ? message : "FILE_OPERATION_FAILED",
      message,
      retryable: false,
    },
    content: [{ type: "text", text: message }],
  };
}
