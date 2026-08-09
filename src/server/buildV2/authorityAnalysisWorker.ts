import { parentPort } from "node:worker_threads";
import {
  createAuthorityCompilerSnapshot,
  type CreateAuthorityCompilerSnapshotInput,
} from "./authorityCompilerSnapshot.js";
import {
  AuthorityAnalysisCache,
  type AuthorityConsumerBaseIdentity,
  type AuthorityIndexIdentity,
  type CachedAuthorityFacts,
} from "./authorityAnalysisCache.js";
import type { AuthorityDependencyIndex } from "./authorityDependencyIndex.js";

type Request =
  | { id: number; kind: "compiler-snapshot"; input: CreateAuthorityCompilerSnapshotInput }
  | {
      id: number;
      kind: "fact-lookups";
      workspaceId: string;
      identities: AuthorityConsumerBaseIdentity[];
    }
  | {
      id: number;
      kind: "cache-commit";
      workspaceId: string;
      identity: AuthorityIndexIdentity;
      index: AuthorityDependencyIndex;
      facts: CachedAuthorityFacts[];
    }
  | {
      id: number;
      kind: "index-lookup";
      workspaceId: string;
      identity: AuthorityIndexIdentity;
      expectedConsumers: Array<
        [string, { effectiveVersion: string; moduleClosureDigest?: string }]
      >;
    };

const port = parentPort;
if (!port) throw new Error("Authority analysis worker requires a parent port");

// One cache instance per workspace for the worker's lifetime. A fresh instance
// per request would re-read the cache file every time and, worse, give two
// overlapping requests independent in-memory copies to write back — a
// read-modify-write race that silently drops facts and index entries.
const caches = new Map<string, AuthorityAnalysisCache>();
function cacheFor(workspaceId: string): AuthorityAnalysisCache {
  const existing = caches.get(workspaceId);
  if (existing) return existing;
  const cache = AuthorityAnalysisCache.forWorkspace(workspaceId);
  caches.set(workspaceId, cache);
  return cache;
}

// Executions are serialized. The compiler pass is CPU-bound on this single
// thread anyway, so overlapping it buys nothing, and serialization is what
// makes the shared cache instance above safe to mutate.
let queue: Promise<void> = Promise.resolve();

port.on("message", (request: Request) => {
  const operation = async (): Promise<unknown> => {
    if (request.kind === "compiler-snapshot") {
      return createAuthorityCompilerSnapshot(request.input);
    }
    const cache = cacheFor(request.workspaceId);
    if (request.kind === "index-lookup") {
      return cache.indexDetailed(request.identity, new Map(request.expectedConsumers));
    }
    if (request.kind === "fact-lookups") {
      const validation = cache.validation();
      return request.identities.map((identity) =>
        cache.factForConsumerDetailed(identity, validation)
      );
    }
    cache.commit(request.identity, request.index, request.facts);
    return true;
  };
  queue = queue.then(() =>
    operation().then(
      (result) => port.postMessage({ id: request.id, result }),
      (error: unknown) =>
        port.postMessage({
          id: request.id,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { name: "Error", message: String(error) },
        })
    )
  );
});
