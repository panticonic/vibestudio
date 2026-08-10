import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  AuthorityCompilerSnapshot,
  CreateAuthorityCompilerSnapshotInput,
} from "./authorityCompilerSnapshot.js";
import type {
  AuthorityConsumerBaseIdentity,
  AuthorityFactCacheLookup,
  AuthorityIndexIdentity,
  AuthorityIndexCacheLookup,
  CachedAuthorityFacts,
} from "./authorityAnalysisCache.js";
import type { AuthorityDependencyIndex } from "./authorityDependencyIndex.js";

declare global {
  var __VIBESTUDIO_AUTHORITY_WORKER_ENTRY__: string | undefined;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const WORKER_BOOTSTRAP_RELATIVE_PATH =
  "src/server/buildV2/authorityAnalysisWorkerBootstrap.mjs" as const;

/**
 * Packaged builds resolve the emitted bundle. Running from source, the entry
 * lives beside this module in the server tree — which is not necessarily
 * `appRoot`: that option points at the build dependency workspace and is a
 * temporary directory in tests and embedded hosts. Source processes are
 * launched with the checkout as cwd; packaged processes use the emitted entry
 * injected by build.mjs and never enter this resolver.
 */
export function resolveAuthorityAnalysisWorkerEntry(appRoot: string): string {
  const roots = [appRoot, process.env["VIBESTUDIO_APP_ROOT"], process.cwd()].filter(
    (root): root is string => typeof root === "string" && root.length > 0
  );
  const candidates = roots.map((root) => path.join(root, WORKER_BOOTSTRAP_RELATIVE_PATH));
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (source) return source;
  throw new Error(`Authority analysis worker entry is missing; looked in ${candidates.join(", ")}`);
}

function workerEntry(appRoot: string): { filename: string; execArgv?: string[] } {
  const emitted = globalThis.__VIBESTUDIO_AUTHORITY_WORKER_ENTRY__;
  if (emitted) return { filename: path.resolve(path.dirname(process.argv[1]!), emitted) };
  return { filename: resolveAuthorityAnalysisWorkerEntry(appRoot) };
}

export class AuthorityAnalysisWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly appRoot = process.cwd()) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const entry = workerEntry(this.appRoot);
    const worker = new Worker(entry.filename, { execArgv: entry.execArgv });
    worker.unref();
    worker.on(
      "message",
      (message: {
        id: number;
        result?: unknown;
        error?: { name?: string; message: string; stack?: string };
      }) => {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        // Key off the presence of `error`, not the truthiness of `result`: a
        // legitimately falsy result is a successful response, not an empty one.
        if (message.error) {
          const error = new Error(message.error.message);
          error.name = message.error.name ?? "Error";
          error.stack = message.error.stack;
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    );
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on("error", fail);
    // Any exit ends this worker, including a clean one. Leaving `this.worker`
    // pointing at a dead thread makes every later postMessage a silent no-op,
    // so requests would never settle — and the publication review lifecycle is
    // deliberately clock-free, so nothing would ever time them out.
    worker.on("exit", (code) => {
      fail(new Error(`Authority analysis worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  compilerSnapshot(
    input: CreateAuthorityCompilerSnapshotInput,
    signal?: AbortSignal
  ): Promise<AuthorityCompilerSnapshot> {
    return this.request(
      { kind: "compiler-snapshot", input },
      signal
    ) as Promise<AuthorityCompilerSnapshot>;
  }

  factLookups(
    workspaceId: string,
    identities: AuthorityConsumerBaseIdentity[],
    signal?: AbortSignal
  ): Promise<AuthorityFactCacheLookup[]> {
    return this.request({ kind: "fact-lookups", workspaceId, identities }, signal) as Promise<
      AuthorityFactCacheLookup[]
    >;
  }

  commitCache(
    workspaceId: string,
    identity: AuthorityIndexIdentity,
    index: AuthorityDependencyIndex,
    facts: CachedAuthorityFacts[],
    signal?: AbortSignal
  ): Promise<void> {
    return this.request({ kind: "cache-commit", workspaceId, identity, index, facts }, signal).then(
      () => undefined
    );
  }

  indexLookup(
    workspaceId: string,
    identity: AuthorityIndexIdentity,
    expectedConsumers: ReadonlyMap<
      string,
      { effectiveVersion: string; moduleClosureDigest?: string }
    >,
    signal?: AbortSignal
  ): Promise<AuthorityIndexCacheLookup> {
    return this.request(
      { kind: "index-lookup", workspaceId, identity, expectedConsumers: [...expectedConsumers] },
      signal
    ) as Promise<AuthorityIndexCacheLookup>;
  }

  private request(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        if (this.pending.size === 0 && this.worker === worker) {
          this.worker = null;
          void worker.terminate();
        }
        reject(signal?.reason ?? new Error("Authority analysis cancelled"));
      };
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ id, ...payload });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    // Reject before terminating. The exit handler is scoped to the live worker,
    // so once `this.worker` is cleared it will not settle these itself.
    const closed = new Error("Authority analysis worker closed");
    for (const pending of this.pending.values()) pending.reject(closed);
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}
