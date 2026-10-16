import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClientArtifactStore } from "./artifactCache.js";

const INTEGRITY = /^sha256-[A-Za-z0-9+/]+=*$/u;
const SAFE_NAME = /^[A-Za-z0-9._-]+$/u;

function encode(integrity: string): string {
  if (!INTEGRITY.test(integrity)) throw new Error(`Invalid artifact integrity: ${integrity}`);
  // base64url without padding is filesystem-safe; the prefix stays readable.
  return integrity.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decode(entry: string): string | null {
  const m = /^(sha256)-([A-Za-z0-9_-]+)$/u.exec(entry);
  if (!m) return null;
  const b64 = m[2]!.replace(/-/gu, "+").replace(/_/gu, "/");
  return `sha256-${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`;
}

/**
 * Node filesystem store for the desktop and terminal hosts. One directory per
 * integrity holds the artifact under its own file name (so Node can import an
 * `.mjs` by extension). Directories are 0700, files 0600, and an artifact
 * appears atomically: it is written in a scratch directory and renamed in.
 */
export class NodeArtifactStore implements ClientArtifactStore {
  constructor(private readonly root: string) {}

  private dir(integrity: string): string {
    return path.join(this.root, encode(integrity));
  }

  private async fileIn(dir: string): Promise<string> {
    const [name] = await fs.readdir(dir);
    if (!name) throw new Error(`Artifact directory is empty: ${dir}`);
    return path.join(dir, name);
  }

  async has(integrity: string): Promise<boolean> {
    try {
      await fs.access(this.dir(integrity));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(integrity: string): Promise<Uint8Array> {
    return fs.readFile(await this.locate(integrity));
  }

  async writeVerified(integrity: string, bytes: Uint8Array, name: string): Promise<void> {
    const target = this.dir(integrity);
    const fileName = SAFE_NAME.test(name) && name !== "." && name !== ".." ? name : "artifact";
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const scratch = path.join(this.root, `.tmp-${randomUUID()}`);
    await fs.mkdir(scratch, { mode: 0o700 });
    try {
      await fs.writeFile(path.join(scratch, fileName), bytes, { mode: 0o600 });
      await fs.rename(scratch, target);
    } catch (error) {
      await fs.rm(scratch, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      // A concurrent writer of the same content won the rename.
      if ((code === "ENOTEMPTY" || code === "EEXIST") && (await this.has(integrity))) return;
      throw error;
    }
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries.flatMap((entry) => {
      const integrity = decode(entry);
      return integrity ? [integrity] : [];
    });
  }

  async remove(integrity: string): Promise<void> {
    await fs.rm(this.dir(integrity), { recursive: true, force: true });
  }

  async locate(integrity: string): Promise<string> {
    return this.fileIn(this.dir(integrity));
  }
}
