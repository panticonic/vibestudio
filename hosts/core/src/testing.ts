import type { ClientArtifactStore } from "./artifactCache.js";
import { sha256Integrity } from "./artifactCache.js";

export class MemoryStore implements ClientArtifactStore {
  readonly files = new Map<string, { bytes: Uint8Array; name: string }>();
  writes = 0;
  async has(integrity: string) {
    return this.files.has(integrity);
  }
  async read(integrity: string) {
    return this.files.get(integrity)!.bytes;
  }
  async writeVerified(integrity: string, bytes: Uint8Array, name: string) {
    this.writes += 1;
    this.files.set(integrity, { bytes, name });
  }
  async list() {
    return [...this.files.keys()];
  }
  async remove(integrity: string) {
    this.files.delete(integrity);
  }
  async locate(integrity: string) {
    return `mem://${integrity}/${this.files.get(integrity)!.name}`;
  }
}

export const bytesOf = (text: string) => new TextEncoder().encode(text);
export const integrityOf = (text: string) => sha256Integrity(bytesOf(text));
export const responseOf = (text: string, status = 200) => new Response(bytesOf(text), { status });
