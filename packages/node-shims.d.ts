declare module "node:fs/promises" {
  export const appendFile: (path: string, data: string, encoding?: string) => Promise<void>;
  export const mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  export const readFile: (path: string) => Promise<Uint8Array>;
  export const readdir: (path: string) => Promise<string[]>;
  export const stat: (path: string) => Promise<{ isFile(): boolean; size: number }>;
  export const writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
}
declare module "node:path" {
  export const dirname: (path: string) => string;
  export const join: (...parts: string[]) => string;
  export const resolve: (...parts: string[]) => string;
  export const relative: (from: string, to: string) => string;
  export const isAbsolute: (path: string) => boolean;
  export const sep: string;
}
declare module "node:crypto" {
  export const createHash: (algorithm: string) => { update(value: Uint8Array | string): { digest(encoding: "hex"): string } };
}
declare module "node:child_process" {
  export const spawn: (command: string, args: string[], options: Record<string, unknown>) => any;
}
declare module "node:process" {
  export const stdin: any;
  export const stdout: any;
  export const stderr: any;
  export const argv: string[];
  export const env: Record<string, string | undefined>;
  export const exitCode: number | undefined;
  export const cwd: () => string;
}
declare module "node:readline/promises" {
  export const createInterface: (options: { input: unknown; output: unknown; terminal?: boolean }) => { question(prompt: string): Promise<string>; close(): void };
}
declare const process: { stdout: { write(value: string): void }; exitCode?: number };
