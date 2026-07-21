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
import {
  loadVersionedJsonFile,
  saveVersionedJsonFile,
  type VersionedJsonCodec,
} from "../hostCore/versionedJsonStore.js";

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
const STORE_VERSION = 6;
/** Historical discriminator of the only production v5 shape. */
const V5_WORKSPACE_SYSTEM_EPOCH = 56;
const STORE_FILE_NAME = "protected-publication-state.json";
const BASIS_DIGEST_RE = /^protected-ref-basis:[0-9a-f]{64}$/;

interface StoredRefStore {
  headPublicationId: string | null;
  mainEventId: string | null;
  mains: MainRefRecord[];
  appliedPublications: AppliedPublication[];
}

const PROTECTED_REF_STORE_CODEC: VersionedJsonCodec<StoredRefStore> = {
  schemaName: "Protected-main store",
  versionKey: "version",
  currentVersion: STORE_VERSION,
  migrations: [
    {
      version: 6,
      name: "decouple-protected-refs-from-workspace-system-epoch",
      migrate(value) {
        const v5 = decodeStoredRefStore(value, 5, V5_WORKSPACE_SYSTEM_EPOCH);
        return encodeStoredRefStore(v5);
      },
    },
  ],
  decodeCurrent: (value) => decodeStoredRefStore(value, 6),
  encode: encodeStoredRefStore,
};

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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<MainRefRecord>;
  return (
    hasExactKeys(row, ["repoPath", "contentRoot", "updatedAt"]) &&
    typeof row.repoPath === "string" &&
    typeof row.contentRoot === "string" &&
    typeof row.updatedAt === "number" &&
    Number.isSafeInteger(row.updatedAt) &&
    row.updatedAt >= 0
  );
}

function isUpdateEntry(value: unknown): value is MainUpdateEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<MainUpdateEntry>;
  return (
    hasExactKeys(row, ["repoPath", "expectedOld", "next"]) &&
    typeof row.repoPath === "string" &&
    (row.expectedOld === null || typeof row.expectedOld === "string") &&
    (row.next === null || typeof row.next === "string")
  );
}

function isAppliedPublication(value: unknown): value is AppliedPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<AppliedPublication>;
  return (
    hasExactKeys(row, [
      "publicationId",
      "previousEventId",
      "publishedEventId",
      "hostRefsBasisDigest",
      "resultHostRefsBasisDigest",
      "entries",
      "appliedAt",
      "observersAppliedAt",
      "semanticAcknowledgedAt",
    ]) &&
    typeof row.publicationId === "string" &&
    row.publicationId.length > 0 &&
    typeof row.previousEventId === "string" &&
    row.previousEventId.length > 0 &&
    typeof row.publishedEventId === "string" &&
    row.publishedEventId.length > 0 &&
    typeof row.hostRefsBasisDigest === "string" &&
    BASIS_DIGEST_RE.test(row.hostRefsBasisDigest) &&
    typeof row.resultHostRefsBasisDigest === "string" &&
    BASIS_DIGEST_RE.test(row.resultHostRefsBasisDigest) &&
    Array.isArray(row.entries) &&
    row.entries.every(isUpdateEntry) &&
    typeof row.appliedAt === "number" &&
    Number.isSafeInteger(row.appliedAt) &&
    row.appliedAt >= 0 &&
    (row.observersAppliedAt === null ||
      (typeof row.observersAppliedAt === "number" &&
        Number.isSafeInteger(row.observersAppliedAt) &&
        row.observersAppliedAt >= 0)) &&
    (row.semanticAcknowledgedAt === null ||
      (typeof row.semanticAcknowledgedAt === "number" &&
        Number.isSafeInteger(row.semanticAcknowledgedAt) &&
        row.semanticAcknowledgedAt >= 0))
  );
}

function emptyStore(): StoredRefStore {
  return {
    headPublicationId: null,
    mainEventId: null,
    mains: [],
    appliedPublications: [],
  };
}

function loadStore(filePath: string): StoredRefStore {
  try {
    return loadVersionedJsonFile(filePath, PROTECTED_REF_STORE_CODEC) ?? emptyStore();
  } catch (error) {
    throw new Error(
      `Protected-main store ${filePath} cannot be loaded without risking data loss: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

function decodeStoredRefStore(
  value: unknown,
  version: number,
  expectedSystemEpoch?: number
): StoredRefStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("protected-main store is not an object");
  }
  const store = value as Record<string, unknown>;
  const expectedKeys = [
    "version",
    ...(expectedSystemEpoch === undefined ? [] : ["systemEpoch"]),
    "headPublicationId",
    "mainEventId",
    "mains",
    "appliedPublications",
  ];
  if (
    !hasExactKeys(store, expectedKeys) ||
    store["version"] !== version ||
    (expectedSystemEpoch !== undefined && store["systemEpoch"] !== expectedSystemEpoch) ||
    (store["headPublicationId"] !== null && typeof store["headPublicationId"] !== "string") ||
    (store["mainEventId"] !== null && typeof store["mainEventId"] !== "string") ||
    !Array.isArray(store["mains"]) ||
    !store["mains"].every(isMainRefRecord) ||
    !Array.isArray(store["appliedPublications"]) ||
    !store["appliedPublications"].every(isAppliedPublication)
  ) {
    throw new Error(`protected-main store version ${version} violates its exact schema`);
  }
  const decoded = store as unknown as StoredRefStore;
  for (const main of decoded.mains) {
    validateRepoPath(main.repoPath);
    validateValue("contentRoot", main.contentRoot);
  }
  if (new Set(decoded.mains.map((main) => main.repoPath)).size !== decoded.mains.length) {
    throw new Error("duplicate protected-main repository");
  }
  for (const publication of decoded.appliedPublications) {
    for (const entry of publication.entries) validateEntry(entry);
    if (
      new Set(publication.entries.map((entry) => entry.repoPath)).size !==
      publication.entries.length
    ) {
      throw new Error(
        `duplicate repository in protected-main publication ${publication.publicationId}`
      );
    }
  }
  if (
    new Set(decoded.appliedPublications.map((publication) => publication.publicationId)).size !==
    decoded.appliedPublications.length
  ) {
    throw new Error("duplicate protected-main publication");
  }
  if (
    decoded.headPublicationId !== null &&
    !decoded.appliedPublications.some(
      (publication) => publication.publicationId === decoded.headPublicationId
    )
  ) {
    throw new Error("unknown protected-main head publication");
  }
  if ((decoded.headPublicationId === null) !== (decoded.mainEventId === null)) {
    throw new Error("protected-main event/publication head disagreement");
  }
  if (decoded.headPublicationId === null && decoded.mains.length > 0) {
    throw new Error("protected-main refs exist without a publication head");
  }
  if (decoded.headPublicationId !== null) {
    const head = decoded.appliedPublications.find(
      (publication) => publication.publicationId === decoded.headPublicationId
    );
    if (!head) throw new Error("unknown protected-main head publication");
    if (head.publishedEventId !== decoded.mainEventId) {
      throw new Error("protected-main semantic event head disagreement");
    }
    const actualBasis = hostRefBasisDigest(
      decoded.mains.map(({ repoPath, contentRoot }) => ({ repoPath, contentRoot }))
    );
    if (head.resultHostRefsBasisDigest !== actualBasis) {
      throw new Error("protected-main head evidence does not match stored refs");
    }
  }
  return decoded;
}

function encodeStoredRefStore(store: StoredRefStore): Record<string, unknown> {
  return {
    headPublicationId: store.headPublicationId,
    mainEventId: store.mainEventId,
    mains: store.mains,
    appliedPublications: store.appliedPublications,
  };
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
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
    saveVersionedJsonFile(
      filePath,
      {
        headPublicationId: nextHeadPublicationId,
        mainEventId: nextMainEventId,
        mains: [...nextMains.values()].sort((a, b) =>
          compareUtf16CodeUnits(a.repoPath, b.repoPath)
        ),
        appliedPublications: [...nextPublications.values()].sort((a, b) =>
          compareUtf16CodeUnits(a.publicationId, b.publicationId)
        ),
      } satisfies StoredRefStore,
      PROTECTED_REF_STORE_CODEC
    );
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
