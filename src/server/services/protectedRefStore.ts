/**
 * Semantic-blind protected-main content CAS.
 *
 * One atomic file stores the exact repo→content pointers and durable applied
 * publication evidence. A publication id + digest makes publication-intent replay
 * idempotent without turning content equality into history equality.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import { canonicalJson, compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";

export interface MainRefRecord {
  repoPath: string;
  contentRoot: string;
  updatedAt: number;
}

export interface MainUpdateEntry {
  repoPath: string;
  expectedOld: string | null;
  next: string | null;
}

export interface AppliedPublication {
  publicationId: string;
  previousEventId: string;
  publishedEventId: string;
  hostRefsBasisDigest: string;
  resultHostRefsBasisDigest: string;
  entries: MainUpdateEntry[];
  appliedAt: number;
  /** Durable completion of all host observers; null means replay must deliver. */
  observersAppliedAt: number | null;
  /** Semantic effect acknowledgement; acknowledged non-head evidence is compactible. */
  semanticAcknowledgedAt: number | null;
}

export interface UpdateMainsInput {
  entries: MainUpdateEntry[];
  evidence: {
    publicationId: string;
    previousEventId: string;
    publishedEventId: string;
    hostRefsBasisDigest: string;
  };
  gateContext?: unknown;
}

export interface UpdateMainsResult {
  updated: Array<{ repoPath: string; contentRoot: string | null }>;
  replayed: boolean;
}

export interface RefGateBatchEntry {
  repoPath: string;
  old: string | null;
  next: string | null;
}

export interface RefGateBatch {
  entries: RefGateBatchEntry[];
  publication: {
    publicationId: string;
    previousEventId: string;
    publishedEventId: string;
  };
  gateContext?: unknown;
}

export interface ProtectedRefPublicationChange {
  repoPath: string;
  previousContentRoot: string | null;
  nextContentRoot: string | null;
}

export interface ProtectedRefPublication {
  publicationId: string;
  previousEventId: string;
  publishedEventId: string;
  resultHostRefsBasisDigest: string;
  appliedAt: number;
  changes: ProtectedRefPublicationChange[];
}

export type OnRefsChanged = (publication: ProtectedRefPublication) => void | Promise<void>;
export type RefGate = (batch: RefGateBatch) => Promise<void>;

export interface ProtectedRefStoreDeps {
  statePath: string;
  gate: RefGate;
  assertTreeComplete?: (contentRoot: string) => Promise<void>;
  now?: () => number;
}

export interface ProtectedRefStore {
  readMain(repoPath: string): MainRefRecord | null;
  listMains(): MainRefRecord[];
  updateMains(input: UpdateMainsInput): Promise<UpdateMainsResult>;
  readAppliedPublication(publicationId: string): AppliedPublication | null;
  acknowledgePublication(publicationId: string): void;
  onRefsChanged(listener: OnRefsChanged): () => void;
}

export class RefValidationError extends Error {
  readonly code = "REF_VALIDATION";
}

export interface MainRefConflict {
  repoPath: string;
  expectedOld: string | null;
  actual: string | null;
}

export class RefBatchConflictError extends Error {
  readonly code = "REF_CONFLICT";
  constructor(readonly conflicts: MainRefConflict[]) {
    super(
      `Protected main changed: ${conflicts
        .map(
          (conflict) =>
            `${conflict.repoPath} expected ${conflict.expectedOld ?? "<absent>"}, got ${conflict.actual ?? "<absent>"}`
        )
        .join("; ")}`
    );
  }
}

export class RefBasisConflictError extends Error {
  readonly code = "REF_BASIS_CONFLICT";
  constructor(
    readonly expectedHostRefsBasisDigest: string,
    readonly actualHostRefsBasisDigest: string,
    readonly winningPublicationId: string | null
  ) {
    super(
      `Protected-main aggregate basis changed: expected ${expectedHostRefsBasisDigest}, got ${actualHostRefsBasisDigest}`
    );
  }
}

export class RefEventConflictError extends Error {
  readonly code = "REF_EVENT_CONFLICT";
  constructor(
    readonly expectedEventId: string,
    readonly actualEventId: string | null,
    readonly winningPublicationId: string | null
  ) {
    super(
      `Protected-main semantic event changed: expected ${expectedEventId}, got ${actualEventId ?? "<uninitialized>"}`
    );
  }
}

export function isRefConflictError(error: unknown): error is RefBatchConflictError {
  return error instanceof RefBatchConflictError;
}

const REF_VALUE_RE = /^state:[0-9a-f]{64}$/;
const STORE_VERSION = 5;
const STORE_FILE_NAME = "protected-publication-state.json";

interface StoredRefStore {
  version: 5;
  systemEpoch: typeof WORKSPACE_SYSTEM_EPOCH;
  headPublicationId: string | null;
  mainEventId: string | null;
  mains: MainRefRecord[];
  appliedPublications: AppliedPublication[];
}

function validateRepoPath(repoPath: string): void {
  let canonical: string;
  try {
    canonical = normalizeWorkspaceRepoPath(repoPath);
  } catch (error) {
    throw new RefValidationError(
      `Invalid repository path ${JSON.stringify(repoPath)}: ${(error as Error).message}`
    );
  }
  if (canonical !== repoPath) {
    throw new RefValidationError(`Repository path is not canonical: ${JSON.stringify(repoPath)}`);
  }
}

function validateValue(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !REF_VALUE_RE.test(value)) {
    throw new RefValidationError(`Invalid ${label} (want state:<hex64>): ${JSON.stringify(value)}`);
  }
}

function isMainRefRecord(value: unknown): value is MainRefRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<MainRefRecord>;
  return (
    typeof row.repoPath === "string" &&
    typeof row.contentRoot === "string" &&
    typeof row.updatedAt === "number" &&
    Number.isSafeInteger(row.updatedAt) &&
    row.updatedAt >= 0
  );
}

function isUpdateEntry(value: unknown): value is MainUpdateEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<MainUpdateEntry>;
  return (
    typeof row.repoPath === "string" &&
    (row.expectedOld === null || typeof row.expectedOld === "string") &&
    (row.next === null || typeof row.next === "string")
  );
}

function isAppliedPublication(value: unknown): value is AppliedPublication {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AppliedPublication>;
  return (
    typeof row.publicationId === "string" &&
    row.publicationId.length > 0 &&
    typeof row.previousEventId === "string" &&
    row.previousEventId.length > 0 &&
    typeof row.publishedEventId === "string" &&
    row.publishedEventId.length > 0 &&
    typeof row.hostRefsBasisDigest === "string" &&
    row.hostRefsBasisDigest.length > 0 &&
    typeof row.resultHostRefsBasisDigest === "string" &&
    row.resultHostRefsBasisDigest.length > 0 &&
    Array.isArray(row.entries) &&
    row.entries.every(isUpdateEntry) &&
    typeof row.appliedAt === "number" &&
    Number.isSafeInteger(row.appliedAt) &&
    row.appliedAt >= 0 &&
    (row.observersAppliedAt === null ||
      (typeof row.observersAppliedAt === "number" &&
        Number.isSafeInteger(row.observersAppliedAt))) &&
    (row.semanticAcknowledgedAt === null ||
      (typeof row.semanticAcknowledgedAt === "number" &&
        Number.isSafeInteger(row.semanticAcknowledgedAt)))
  );
}

function emptyStore(): StoredRefStore {
  return {
    version: STORE_VERSION,
    systemEpoch: WORKSPACE_SYSTEM_EPOCH,
    headPublicationId: null,
    mainEventId: null,
    mains: [],
    appliedPublications: [],
  };
}

function loadStore(filePath: string): StoredRefStore {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt protected-main store at ${filePath}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error(`Corrupt protected-main store at ${filePath}`);
  const store = parsed as Partial<StoredRefStore>;
  if (store.version !== STORE_VERSION) {
    throw new Error(`Unsupported or corrupt protected-main store at ${filePath}`);
  }
  if (store.systemEpoch !== WORKSPACE_SYSTEM_EPOCH) {
    throw new Error(
      `Protected-main store epoch ${String(store.systemEpoch)} is incompatible with host epoch ${WORKSPACE_SYSTEM_EPOCH}; recreate this pre-release workspace`
    );
  }
  if (
    (store.headPublicationId !== null && typeof store.headPublicationId !== "string") ||
    (store.mainEventId !== null && typeof store.mainEventId !== "string") ||
    !Array.isArray(store.mains) ||
    !store.mains.every(isMainRefRecord) ||
    !Array.isArray(store.appliedPublications) ||
    !store.appliedPublications.every(isAppliedPublication)
  ) {
    throw new Error(`Unsupported or corrupt protected-main store at ${filePath}`);
  }
  for (const main of store.mains) {
    validateRepoPath(main.repoPath);
    validateValue("contentRoot", main.contentRoot);
  }
  if (new Set(store.mains.map((main) => main.repoPath)).size !== store.mains.length) {
    throw new Error(`Corrupt duplicate protected-main repository at ${filePath}`);
  }
  for (const publication of store.appliedPublications) {
    if (
      !publication.publicationId ||
      !publication.hostRefsBasisDigest ||
      !publication.resultHostRefsBasisDigest
    ) {
      throw new Error(`Corrupt applied protected-main publication at ${filePath}`);
    }
    for (const entry of publication.entries) validateEntry(entry);
  }
  if (
    new Set(store.appliedPublications.map((publication) => publication.publicationId)).size !==
    store.appliedPublications.length
  ) {
    throw new Error(`Corrupt duplicate protected-main publication at ${filePath}`);
  }
  if (
    store.headPublicationId !== null &&
    !store.appliedPublications.some(
      (publication) => publication.publicationId === store.headPublicationId
    )
  ) {
    throw new Error(`Corrupt protected-main head publication at ${filePath}`);
  }
  if ((store.headPublicationId === null) !== (store.mainEventId === null)) {
    throw new Error(`Corrupt protected-main event/publication head at ${filePath}`);
  }
  if (store.headPublicationId !== null) {
    const head = store.appliedPublications.find(
      (publication) => publication.publicationId === store.headPublicationId
    );
    if (!head) throw new Error(`Corrupt protected-main head publication at ${filePath}`);
    if (head.publishedEventId !== store.mainEventId) {
      throw new Error(`Corrupt protected-main semantic event head at ${filePath}`);
    }
  }
  return store as StoredRefStore;
}

function validateEntry(entry: MainUpdateEntry): void {
  validateRepoPath(entry.repoPath);
  if (entry.expectedOld !== null) validateValue("expectedOld", entry.expectedOld);
  if (entry.next !== null) validateValue("next", entry.next);
}

function publicationFromEvidence(evidence: AppliedPublication): ProtectedRefPublication {
  return {
    publicationId: evidence.publicationId,
    previousEventId: evidence.previousEventId,
    publishedEventId: evidence.publishedEventId,
    resultHostRefsBasisDigest: evidence.resultHostRefsBasisDigest,
    appliedAt: evidence.appliedAt,
    changes: evidence.entries.map((entry) => ({
      repoPath: entry.repoPath,
      previousContentRoot: entry.expectedOld,
      nextContentRoot: entry.next,
    })),
  };
}

export function createProtectedRefStore(deps: ProtectedRefStoreDeps): ProtectedRefStore {
  const now = deps.now ?? (() => Date.now());
  const filePath = path.join(deps.statePath, STORE_FILE_NAME);
  const loaded = loadStore(filePath);
  const mains = new Map(loaded.mains.map((record) => [record.repoPath, record]));
  const publications = new Map(
    loaded.appliedPublications.map((publication) => [publication.publicationId, publication])
  );
  let headPublicationId = loaded.headPublicationId;
  let mainEventId = loaded.mainEventId;
  const chains = new Map<string, Promise<unknown>>();
  const listeners = new Set<OnRefsChanged>();

  const persist = (
    nextMains: Map<string, MainRefRecord>,
    nextPublications: Map<string, AppliedPublication>,
    nextHeadPublicationId: string | null,
    nextMainEventId: string | null
  ) => {
    fs.mkdirSync(deps.statePath, { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, {
      version: STORE_VERSION,
      systemEpoch: WORKSPACE_SYSTEM_EPOCH,
      headPublicationId: nextHeadPublicationId,
      mainEventId: nextMainEventId,
      mains: [...nextMains.values()].sort((a, b) => compareUtf16CodeUnits(a.repoPath, b.repoPath)),
      appliedPublications: [...nextPublications.values()].sort((a, b) =>
        compareUtf16CodeUnits(a.publicationId, b.publicationId)
      ),
    } satisfies StoredRefStore);
  };

  const service: ProtectedRefStore = {
    readMain(repoPath) {
      validateRepoPath(repoPath);
      const record = mains.get(repoPath);
      return record ? { ...record } : null;
    },

    listMains() {
      return [...mains.values()]
        .sort((a, b) => compareUtf16CodeUnits(a.repoPath, b.repoPath))
        .map((record) => ({ ...record }));
    },

    readAppliedPublication(publicationId) {
      const publication = publications.get(publicationId);
      return publication
        ? { ...publication, entries: publication.entries.map((entry) => ({ ...entry })) }
        : null;
    },

    acknowledgePublication(publicationId) {
      const publication = publications.get(publicationId);
      if (!publication) return;
      const acknowledged = { ...publication, semanticAcknowledgedAt: now() };
      const nextPublications = new Map(publications).set(publicationId, acknowledged);
      for (const [id, evidence] of nextPublications) {
        if (id !== headPublicationId && evidence.semanticAcknowledgedAt !== null) {
          nextPublications.delete(id);
        }
      }
      persist(mains, nextPublications, headPublicationId, mainEventId);
      publications.clear();
      for (const [id, evidence] of nextPublications) publications.set(id, evidence);
    },

    async updateMains(input) {
      if (
        !input.evidence.publicationId ||
        !input.evidence.previousEventId ||
        !input.evidence.publishedEventId ||
        !input.evidence.hostRefsBasisDigest
      ) {
        throw new RefValidationError("updateMains requires durable publication evidence");
      }
      const seen = new Set<string>();
      for (const entry of input.entries) {
        validateEntry(entry);
        if (seen.has(entry.repoPath)) {
          throw new RefValidationError(`updateMains has duplicate repository ${entry.repoPath}`);
        }
        seen.add(entry.repoPath);
      }
      const entries = [...input.entries].sort((a, b) =>
        compareUtf16CodeUnits(a.repoPath, b.repoPath)
      );
      const run = async (): Promise<{
        result: UpdateMainsResult;
        publication: ProtectedRefPublication | null;
      }> => {
        const actualHostRefsBasisDigest = hostRefBasisDigest(
          [...mains.values()].map(({ repoPath, contentRoot }) => ({ repoPath, contentRoot }))
        );
        const prior = publications.get(input.evidence.publicationId);
        if (prior) {
          if (
            prior.previousEventId !== input.evidence.previousEventId ||
            prior.publishedEventId !== input.evidence.publishedEventId ||
            prior.hostRefsBasisDigest !== input.evidence.hostRefsBasisDigest ||
            canonicalJson(prior.entries) !== canonicalJson(entries)
          ) {
            throw new RefValidationError(
              `Protected-main publication ${input.evidence.publicationId} was reused with different input`
            );
          }
          if (actualHostRefsBasisDigest !== prior.resultHostRefsBasisDigest) {
            throw new RefBasisConflictError(
              prior.resultHostRefsBasisDigest,
              actualHostRefsBasisDigest,
              headPublicationId
            );
          }
          return {
            result: {
              updated: prior.entries.map((entry) => ({
                repoPath: entry.repoPath,
                contentRoot: entry.next,
              })),
              replayed: true,
            },
            publication: prior.observersAppliedAt === null ? publicationFromEvidence(prior) : null,
          };
        }

        if (
          mainEventId !== null ? mainEventId !== input.evidence.previousEventId : mains.size !== 0
        ) {
          throw new RefEventConflictError(
            input.evidence.previousEventId,
            mainEventId,
            headPublicationId
          );
        }

        if (actualHostRefsBasisDigest !== input.evidence.hostRefsBasisDigest) {
          throw new RefBasisConflictError(
            input.evidence.hostRefsBasisDigest,
            actualHostRefsBasisDigest,
            headPublicationId
          );
        }

        const conflicts: MainRefConflict[] = [];
        for (const entry of entries) {
          const actual = mains.get(entry.repoPath)?.contentRoot ?? null;
          if (actual !== entry.expectedOld) {
            conflicts.push({ repoPath: entry.repoPath, expectedOld: entry.expectedOld, actual });
          }
        }
        if (conflicts.length > 0) throw new RefBatchConflictError(conflicts);
        if (deps.assertTreeComplete) {
          for (const entry of entries) {
            if (entry.next !== null) await deps.assertTreeComplete(entry.next);
          }
        }
        // The semantic main event is protected state even when its repository
        // snapshot is content-identical to the current one. Gate every new
        // publication; only an exact durable replay above skips approval.
        await deps.gate({
          entries: entries.map((entry) => ({
            repoPath: entry.repoPath,
            old: entry.expectedOld,
            next: entry.next,
          })),
          publication: {
            publicationId: input.evidence.publicationId,
            previousEventId: input.evidence.previousEventId,
            publishedEventId: input.evidence.publishedEventId,
          },
          ...(input.gateContext !== undefined ? { gateContext: input.gateContext } : {}),
        });

        const appliedAt = now();
        const nextMains = new Map(mains);
        for (const entry of entries) {
          if (entry.next === null) nextMains.delete(entry.repoPath);
          else {
            nextMains.set(entry.repoPath, {
              repoPath: entry.repoPath,
              contentRoot: entry.next,
              updatedAt: appliedAt,
            });
          }
        }
        const evidence: AppliedPublication = {
          publicationId: input.evidence.publicationId,
          previousEventId: input.evidence.previousEventId,
          publishedEventId: input.evidence.publishedEventId,
          hostRefsBasisDigest: input.evidence.hostRefsBasisDigest,
          resultHostRefsBasisDigest: hostRefBasisDigest(
            [...nextMains.values()].map(({ repoPath, contentRoot }) => ({ repoPath, contentRoot }))
          ),
          entries,
          appliedAt,
          observersAppliedAt: null,
          semanticAcknowledgedAt: null,
        };
        const nextPublications = new Map(publications).set(evidence.publicationId, evidence);
        for (const [id, priorEvidence] of nextPublications) {
          if (id !== evidence.publicationId && priorEvidence.semanticAcknowledgedAt !== null) {
            nextPublications.delete(id);
          }
        }
        persist(nextMains, nextPublications, evidence.publicationId, evidence.publishedEventId);
        mains.clear();
        for (const [repoPath, record] of nextMains) mains.set(repoPath, record);
        publications.clear();
        for (const [id, retained] of nextPublications) publications.set(id, retained);
        headPublicationId = evidence.publicationId;
        mainEventId = evidence.publishedEventId;
        return {
          result: {
            updated: entries.map((entry) => ({
              repoPath: entry.repoPath,
              contentRoot: entry.next,
            })),
            replayed: false,
          },
          publication: publicationFromEvidence(evidence),
        };
      };

      // The protected refs and publication evidence share one atomic persisted value. A
      // global serializer is therefore the natural concurrency boundary:
      // disjoint repository batches still contend on the same durable file
      // and must never race into lost updates.
      const outcome = await serializeByKey(chains, "protected-main-store", run);
      if (outcome.publication) {
        const appliedPublication = outcome.publication;
        for (const listener of listeners) {
          await listener(appliedPublication);
        }
        await serializeByKey(chains, "protected-main-store", async () => {
          const evidence = publications.get(appliedPublication.publicationId);
          if (!evidence || evidence.observersAppliedAt !== null) return;
          const observed = { ...evidence, observersAppliedAt: now() };
          const nextPublications = new Map(publications).set(evidence.publicationId, observed);
          persist(mains, nextPublications, headPublicationId, mainEventId);
          publications.set(evidence.publicationId, observed);
        });
      }
      return outcome.result;
    },

    onRefsChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return service;
}
