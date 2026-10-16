import type { ClientArtifactDescriptor } from "@vibestudio/workspace-contracts/clients";
import { ClientLaunchError } from "./errors.js";

/**
 * Where verified artifact bytes live. Desktop and terminal use the Node fs
 * store; mobile adapts its native asset store. `writeVerified` is only ever
 * called with bytes whose digest matched, must be atomic (a reader never sees
 * a partial artifact), and must tolerate a concurrent writer of the same
 * integrity. `name` is the artifact's file name, for hosts whose loader keys
 * on it (Node imports an `.mjs` by extension).
 */
export interface ClientArtifactStore {
  has(integrity: string): Promise<boolean>;
  read(integrity: string): Promise<Uint8Array>;
  writeVerified(integrity: string, bytes: Uint8Array, name: string): Promise<void>;
  list(): Promise<string[]>;
  remove(integrity: string): Promise<void>;
  /** Host-specific handle (a filesystem path, an asset URI) of a stored artifact. */
  locate(integrity: string): Promise<string>;
}

/**
 * Fetch one artifact route over the host's device session (`gateway.fetch`).
 * The gateway descriptor carries no byte-range field, so the whole artifact
 * is fetched; a failed transfer fails the caller and the next launch fetches
 * again.
 */
export type ClientArtifactFetch = (route: string) => Promise<ClientArtifactResponse>;

/** What the cache reads from a fetch: a `Response` satisfies it, as does a decoded RPC stream. */
export interface ClientArtifactResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

/** The gateway route of one file of an immutable client build: `/_a/<buildKey>/<path>`. */
export function clientArtifactRoute(buildKey: string, path: string): string {
  return `/_a/${buildKey}/${path.replace(/^\/+/u, "")}`;
}

/** `sha256-<hex>`, the integrity form the build store seals on every artifact. */
export async function sha256Integrity(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return `sha256-${hex}`;
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function fileName(route: string): string {
  const last = route.split(/[?#]/u)[0]!.split("/").filter(Boolean).pop();
  return last && /^[A-Za-z0-9._-]+$/u.test(last) ? last : "artifact";
}

export class ClientArtifactCache {
  private readonly flights = new Map<string, Promise<string>>();

  constructor(
    private readonly store: ClientArtifactStore,
    private readonly fetchArtifact: ClientArtifactFetch
  ) {}

  /**
   * Ensure the artifact is stored and verified; resolve to its host handle.
   * Concurrent requests for one integrity share a single fetch. A rejected
   * flight is forgotten so a later request fetches again.
   */
  ensure(artifact: Pick<ClientArtifactDescriptor, "path" | "integrity">): Promise<string> {
    const { integrity } = artifact;
    const existing = this.flights.get(integrity);
    if (existing) return existing;
    const flight = this.fill(artifact).finally(() => {
      this.flights.delete(integrity);
    });
    this.flights.set(integrity, flight);
    return flight;
  }

  private async fill(
    artifact: Pick<ClientArtifactDescriptor, "path" | "integrity">
  ): Promise<string> {
    const { integrity, path } = artifact;
    if (!integrity.startsWith("sha256-")) {
      throw new ClientLaunchError(
        "unsupported-integrity",
        `Artifact ${path} declares an unsupported integrity: ${integrity}`
      );
    }
    if (!(await this.store.has(integrity))) {
      const response = await this.fetchArtifact(path);
      if (!response.ok) {
        throw new ClientLaunchError(
          "artifact-fetch-failed",
          `Could not download ${path}: HTTP ${response.status}`
        );
      }
      const bytes = await readAll(response.body);
      const actual = await sha256Integrity(bytes);
      if (actual !== integrity) {
        throw new ClientLaunchError(
          "integrity-mismatch",
          `Downloaded ${path} does not match its declared integrity (${integrity}, got ${actual}).`
        );
      }
      await this.store.writeVerified(integrity, bytes, fileName(path));
    }
    return this.store.locate(integrity);
  }

  /**
   * Drop every stored artifact no retained build refers to. The host calls
   * this after a launch or update with the builds it keeps (the running one
   * and rollback targets); nothing else triggers collection.
   */
  async retain(retained: ReadonlyMap<string, readonly string[]>): Promise<string[]> {
    const keep = new Set<string>();
    for (const integrities of retained.values()) for (const i of integrities) keep.add(i);
    const removed: string[] = [];
    for (const integrity of await this.store.list()) {
      if (keep.has(integrity) || this.flights.has(integrity)) continue;
      await this.store.remove(integrity);
      removed.push(integrity);
    }
    return removed;
  }
}
