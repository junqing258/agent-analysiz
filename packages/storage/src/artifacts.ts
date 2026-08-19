import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRef, ArtifactStore } from "@agent-sdk/core";

/** 按内容寻址的本地工件存储；哈希既是标识符，也是完整性校验。 */
export class LocalArtifactStore implements ArtifactStore {
  constructor(readonly root: string) {}
  async put(value: Uint8Array | string, options: { mediaType: string }): Promise<ArtifactRef> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `sha256-${sha256}`;
    await mkdir(this.root, { recursive: true });
    const location = join(this.root, sha256);
    try { await readFile(location); } catch (error) { if (isMissing(error)) await writeFile(location, bytes); else throw error; }
    return { id, sha256, mediaType: options.mediaType, byteLength: bytes.byteLength };
  }
  async get(ref: ArtifactRef): Promise<Uint8Array> {
    const bytes = await readFile(join(this.root, ref.sha256));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== ref.sha256) throw new Error(`Artifact integrity failure for ${ref.id}`);
    return bytes;
  }
}
export const localArtifactStore = (root: string): LocalArtifactStore => new LocalArtifactStore(root);
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT"; }
