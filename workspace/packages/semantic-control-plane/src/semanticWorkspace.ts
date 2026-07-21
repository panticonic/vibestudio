import { canonicalJson, compareUtf16CodeUnits, sha256Hex } from "@vibestudio/content-addressing";
import {
  VCS_IMPORT_MAX_DESCRIPTOR_BYTES,
  parseVcsSemanticRequest,
  vcsProvenanceEdgeSchema,
  vcsImportDescriptorByteLength,
  vcsTrajectoryRequestRefSchema,
  vcsTrajectorySenderRefSchema,
  type VcsBlameInput,
  type VcsCompareInput,
  type VcsCopyInput,
  type VcsDiscardInput,
  type VcsEditInput,
  type VcsHistoryInput,
  type VcsImportSnapshotInput,
  type VcsInspectInput,
  type VcsIntegrateInput,
  type VcsListFilesInput,
  type VcsMethodName,
  type VcsMoveInput,
  type VcsNeighborsInput,
  type VcsPushInput,
  type VcsReadFileInput,
  type VcsResolveRepositoryInput,
  type VcsResolveRepositoryResult,
  type VcsRevertInput,
  type VcsStateNodeRef,
  type VcsStatusInput,
} from "@vibestudio/service-schemas/vcs";
import {
  NORMALIZATION_PROTOCOL,
  SEMANTIC_PROTOCOL,
  compactId,
  composeFileManifest,
  contentMappingDigest,
  emptyFileManifest,
  fileManifestEntryAt,
  planWorkspaceFactChangeSet,
  workspaceFileStateIdentity,
  workspaceRepositoryStateIdentity,
  type ContentMapping,
  type PersistentRadixNode,
  type StateNodeRef,
  type WorkspaceFactChangeSet,
  type WorkspaceFileState,
  type WorkspaceRepositoryMember,
} from "@workspace/vcs-engine";
import type { SqlStorage } from "@workspace/runtime/worker/durable-base";
import {
  contextMaterializationCommand,
  contextMaterializationReceiptProves,
  type ContextMaterializationCommand,
  type ContextMaterializationReceipt,
  type WorkspaceMaterializationChange,
  type WorkspaceMaterializationRepository,
} from "@vibestudio/shared/vcs/workspaceProjection";
import { assertSemanticVcsPathAdmissible } from "@vibestudio/shared/vcs/pathAdmission";
import {
  SemanticVcsError,
  appliedChangeIdentity,
  applicationIdentity,
  changeIdentity,
  contentEdgeIdentity,
  decisionIdentity,
  internalSemanticIntegrityFailure,
  stateNodeKey,
  workUnitIdentity,
  type ApplicationPersistencePlan,
  type ApplicationRecord,
  type AppliedChangeRecord,
  type AuthoredCopySourceEndpoint,
  type CausalCommandRef,
  type ChangeRecord,
  type ContentEdgeRecord,
  type IntegrationDecisionRecord,
  type SemanticEffect,
  type SemanticStateRecord,
  type SemanticVcsStore,
  type StatePredicateRecord,
  type WorkUnitRecord,
} from "./semanticVcsStore.js";
import { contentMappingFromRow } from "./semanticVcsContentMappingCodec.js";

type Row = Record<string, unknown>;
type PlacedFileState = Extract<WorkspaceFileState, { presence: "placed" }>;
type PresentRepositoryState = Extract<WorkspaceRepositoryMember, { presence: "present" }>;

const MAX_WORKING_APPLICATIONS = 10_000;
const MAX_ANCESTRY_EDGES = 100_000;

const trajectorySenderRef = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Row;
  const parsed = vcsTrajectorySenderRefSchema.safeParse({
    kind: candidate["kind"],
    id: candidate["id"],
    participantId:
      typeof candidate["participantId"] === "string" ? candidate["participantId"] : null,
  });
  return parsed.success ? parsed.data : null;
};

const trajectoryRequestRef = (value: unknown) => {
  const parsed = vcsTrajectoryRequestRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticVcsError(
      "IntegrityFailure",
      "Invalid canonical invocation request reference"
    );
  }
  return parsed.data;
};

export interface SemanticDispatchRequest {
  input: unknown;
  /** Exact trajectory edge, when this command came from an agent tool call. */
  ingress: {
    causalParent: {
      kind: "trajectory-invocation";
      logId: string;
      head: string;
      invocationId: string;
    } | null;
  };
}

export type SemanticDispatchResult =
  | { kind: "complete"; result: unknown }
  | {
      kind: "effects-pending";
      result: unknown;
      effects: readonly SemanticEffect[];
    }
  | { kind: "host-read"; request: Row };

export interface SemanticEffectAcknowledgement {
  effectId: string;
  payloadDigest: string;
  receipt: Row;
}

interface SemanticWorkspaceDeps {
  workspaceId: string;
  sql: SqlStorage;
  store: SemanticVcsStore;
  now(): string;
  transaction<T>(fn: () => T): T;
}

interface FileTransition {
  fileId: string;
  expected: WorkspaceFileState | null;
  result: WorkspaceFileState;
  changeId: string;
  /** This work authors the global file identity, not merely a placement in this state. */
  newFile: boolean;
}

interface RepositoryTransition {
  repositoryId: string;
  expected: WorkspaceRepositoryMember | null;
  /** `undefined` preserves the member while files change; `null` deletes it. */
  resultPath: string | null | undefined;
  changeId: string | null;
  tombstoneChangeId: string | null;
  /** This work authors the global repository identity, not merely membership in this state. */
  newRepository: boolean;
}

type DraftChangeRef =
  | { kind: "authored"; ordinal: number }
  | { kind: "existing"; changeId: string };

interface MutationDraft {
  kind: WorkUnitRecord["kind"];
  intentSummary: string | null;
  externalSnapshot?: {
    sourceKind: VcsImportSnapshotInput["source"]["kind"];
    sourceUri: string;
    snapshotRevision: string;
    snapshotDigest: string;
    targetRepositoryIds: readonly string[];
  };
  incorporatedChangeIds: string[];
  changes: Array<
    Omit<ChangeRecord, "changeId" | "workUnitId" | "effectDigest" | "source"> & {
      source?: AuthoredCopySourceEndpoint;
    }
  >;
  fileResults: Array<{
    fileId: string;
    expected: WorkspaceFileState | null;
    result:
      | Omit<Extract<WorkspaceFileState, { presence: "placed" }>, "fileStateId">
      | {
          fileId: string;
          presence: "deleted";
          priorFileStateId: string;
        };
    /** This work authors the global identity; adopted source identities are never new here. */
    newFile: boolean;
    changeRef: DraftChangeRef;
  }>;
  repositoryResults: Array<{
    repositoryId: string;
    expected: WorkspaceRepositoryMember | null;
    resultPath: string | null;
    /** This work authors the global identity; adopted source identities are never new here. */
    newRepository: boolean;
    changeRef: DraftChangeRef | null;
  }>;
  appliedSourceChanges?: ChangeRecord[];
  contentEdges?: ContentEdgeRecord[];
  decisions?: Array<Omit<IntegrationDecisionRecord, "decisionId" | "workUnitId" | "createdAt">>;
  blobs?: Array<{ contentHash: string; base64: string }>;
}

type ComparedDisposition =
  | { status: "shared" }
  | { status: "already-satisfied"; evidence: StatePredicateRecord[] }
  | {
      status: "actionable";
      applicability: "applicable" | "conflicting" | "blocked";
      prerequisiteChangeIds?: string[];
    }
  | { status: "accounted"; decisionIds: string[] }
  | { status: "historical" };

interface ComparedSourceChange {
  change: ChangeRecord;
  disposition: ComparedDisposition;
}

interface IntegrationComparison {
  targetState: StateNodeRef;
  sourceEventId: string;
  changes: ComparedSourceChange[];
  unaccountedChangeIds: string[];
}

type ChangePrerequisite =
  | { kind: "endpoint"; endpoint: Row }
  | { kind: "repository-present"; repositoryId: string }
  | { kind: "file-path-empty"; repositoryId: string; path: string; exceptFileId: string }
  | { kind: "repository-path-empty"; repoPath: string; exceptRepositoryId: string };

const asState = (value: VcsStateNodeRef): StateNodeRef =>
  value.kind === "event"
    ? { kind: "event", eventId: value.eventId }
    : { kind: "application", applicationId: value.applicationId };

const bytesFromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const base64FromBytes = (value: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < value.length; index += chunk) {
    binary += String.fromCharCode(...value.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const contentBytes = (value: { kind: "text"; text: string } | { kind: "bytes"; base64: string }) =>
  value.kind === "text" ? new TextEncoder().encode(value.text) : bytesFromBase64(value.base64);

const contentDescriptor = (
  value: { kind: "text"; text: string } | { kind: "bytes"; base64: string },
  bytes: Uint8Array
): Pick<PlacedFileState, "contentKind" | "byteLength" | "coordinateExtent"> =>
  value.kind === "text"
    ? { contentKind: "text", byteLength: bytes.length, coordinateExtent: value.text.length }
    : { contentKind: "bytes", byteLength: bytes.length, coordinateExtent: bytes.length };

const coordinateKindForFile = (state: { contentKind: "text" | "bytes" }): "utf16" | "byte" =>
  state.contentKind === "text" ? "utf16" : "byte";

const contentDescriptorFromEndpoint = (
  endpoint: Row
): Pick<PlacedFileState, "contentKind" | "byteLength" | "coordinateExtent"> => {
  const contentKind = endpoint["contentKind"];
  const byteLength = endpoint["byteLength"];
  const coordinateExtent = endpoint["coordinateExtent"];
  if (
    (contentKind !== "text" && contentKind !== "bytes") ||
    !Number.isSafeInteger(byteLength) ||
    Number(byteLength) < 0 ||
    !Number.isSafeInteger(coordinateExtent) ||
    Number(coordinateExtent) < 0 ||
    (contentKind === "bytes" && coordinateExtent !== byteLength)
  ) {
    throw new SemanticVcsError("IntegrityFailure", "File endpoint has invalid coordinate metadata");
  }
  return {
    contentKind,
    byteLength: Number(byteLength),
    coordinateExtent: Number(coordinateExtent),
  };
};

const endpointForFile = (
  state: PlacedFileState,
  repository: Extract<WorkspaceRepositoryMember, { presence: "present" }>
): Row => ({
  kind: "file",
  fileId: state.fileId,
  repositoryId: state.repositoryId,
  repoPath: repository.repoPath,
  path: state.path,
  contentHash: state.contentHash,
  mode: state.mode,
  contentKind: state.contentKind,
  byteLength: state.byteLength,
  coordinateExtent: state.coordinateExtent,
});

const missingEndpoint = (
  state: Pick<PlacedFileState, "fileId" | "repositoryId" | "path">,
  repoPath: string
): Row => ({
  kind: "missing",
  fileId: state.fileId,
  repositoryId: state.repositoryId,
  repoPath,
  path: state.path,
});

const contentMapping = (value: Omit<ContentMapping, "digest">): ContentMapping => ({
  ...value,
  digest: contentMappingDigest(value),
});

const mappingForWholeFile = (input: {
  childContentHash: string;
  parentContentHash: string;
  coordinateKind: "utf16" | "byte";
  coordinateExtent: number;
}): ContentMapping => {
  return contentMapping({
    coordinateKind: input.coordinateKind,
    childContentHash: input.childContentHash,
    childStart: 0,
    childEnd: input.coordinateExtent,
    parentContentHash: input.parentContentHash,
    parentStart: 0,
    parentEnd: input.coordinateExtent,
  });
};

const mappingsForTextEdits = (input: {
  childContentHash: string;
  childExtent: number;
  parentContentHash: string;
  parentExtent: number;
  edits: unknown;
}): ContentMapping[] => {
  if (!Array.isArray(input.edits)) {
    throw new SemanticVcsError("IntegrityFailure", "Text change has no exact edit spans");
  }
  const mappings: ContentMapping[] = [];
  let parentCursor = 0;
  let childCursor = 0;
  for (const candidate of input.edits) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new SemanticVcsError("IntegrityFailure", "Text change has an invalid edit span");
    }
    const edit = candidate as { start?: unknown; end?: unknown; text?: unknown };
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      typeof edit.text !== "string" ||
      Number(edit.start) < parentCursor ||
      Number(edit.end) < Number(edit.start) ||
      Number(edit.end) > input.parentExtent
    ) {
      throw new SemanticVcsError("IntegrityFailure", "Text change has an invalid edit span");
    }
    const start = Number(edit.start);
    const end = Number(edit.end);
    const unchangedLength = start - parentCursor;
    if (unchangedLength > 0) {
      mappings.push(
        contentMapping({
          coordinateKind: "utf16",
          childContentHash: input.childContentHash,
          childStart: childCursor,
          childEnd: childCursor + unchangedLength,
          parentContentHash: input.parentContentHash,
          parentStart: parentCursor,
          parentEnd: start,
        })
      );
    }
    childCursor += unchangedLength + edit.text.length;
    parentCursor = end;
  }
  const tailLength = input.parentExtent - parentCursor;
  if (tailLength > 0) {
    mappings.push(
      contentMapping({
        coordinateKind: "utf16",
        childContentHash: input.childContentHash,
        childStart: childCursor,
        childEnd: childCursor + tailLength,
        parentContentHash: input.parentContentHash,
        parentStart: parentCursor,
        parentEnd: input.parentExtent,
      })
    );
    childCursor += tailLength;
  }
  if (childCursor !== input.childExtent) {
    throw new SemanticVcsError("IntegrityFailure", "Text edit mappings do not cover the result");
  }
  return mappings;
};

const predicateForState = (state: WorkspaceFileState): StatePredicateRecord =>
  state.presence === "placed"
    ? { kind: "file-content", fileId: state.fileId, contentHash: state.contentHash }
    : { kind: "file-absent", fileId: state.fileId };

const inverseChangeKind = (kind: string): string | null => {
  switch (kind) {
    case "file-create":
    case "file-copy":
    case "file-restore":
      return "file-delete";
    case "file-delete":
      return "file-restore";
    case "repo-add":
    case "repo-restore":
      return "repo-delete";
    case "repo-delete":
      return "repo-restore";
    case "text":
    case "file-move":
    case "file-mode":
    case "content-replace":
    case "repo-move":
      return kind;
    default:
      return null;
  }
};

const publicChangeKind = (kind: string): string => {
  switch (kind) {
    case "text":
      return "text-edit";
    case "repo-add":
      return "repository-create";
    case "repo-delete":
      return "repository-delete";
    case "repo-restore":
      return "repository-restore";
    case "repo-move":
      return "repository-move";
    default:
      return kind;
  }
};

type ObservedContentDescriptor = {
  contentKind: "text" | "bytes";
  byteLength: number;
  coordinateExtent: number;
};

const importedSnapshotDigest = (
  repositories: VcsImportSnapshotInput["repositories"],
  observed: ReadonlyMap<string, ObservedContentDescriptor>
): string =>
  compactId(
    "snapshot",
    repositories
      .map((repository) => ({
        repoPath: repository.repoPath,
        files: repository.files
          .map((file) => {
            const descriptor = observed.get(file.contentHash);
            if (!descriptor) {
              throw internalSemanticIntegrityFailure(
                "EffectMismatch",
                `Content observation lacks ${file.contentHash}`,
                { contentHash: file.contentHash, contract: "import-observation" }
              );
            }
            return {
              path: file.path,
              contentHash: file.contentHash,
              mode: file.mode,
              ...descriptor,
            };
          })
          .sort((left, right) => compareUtf16CodeUnits(left.path, right.path)),
      }))
      .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath))
  );

const importedRepositories = (input: VcsImportSnapshotInput) =>
  input.repositories.map((repository, ordinal) => ({
    input: repository,
    repositoryId:
      repository.repositoryId ??
      compactId("repository", {
        commandId: input.commandId,
        ordinal,
        repoPath: repository.repoPath,
      }),
  }));

const changeEffects = (change: Pick<ChangeRecord, "kind" | "base" | "result" | "payload">) => {
  const base = change.base;
  const result = change.result;
  const fileId =
    typeof result?.["fileId"] === "string"
      ? result["fileId"]
      : typeof base?.["fileId"] === "string"
        ? base["fileId"]
        : null;
  if (fileId) {
    const effects: Row[] = [];
    const beforeContentHash =
      base?.["kind"] === "file" && typeof base["contentHash"] === "string"
        ? base["contentHash"]
        : null;
    const afterContentHash =
      result?.["kind"] === "file" && typeof result["contentHash"] === "string"
        ? result["contentHash"]
        : null;
    if (beforeContentHash !== afterContentHash) {
      effects.push({ kind: "content", fileId, beforeContentHash, afterContentHash });
    }
    const placement = (value: Row | null) =>
      value?.["kind"] === "file" &&
      typeof value["repositoryId"] === "string" &&
      typeof value["path"] === "string"
        ? { repositoryId: value["repositoryId"], path: value["path"] }
        : null;
    const before = placement(base);
    const after = placement(result);
    if (canonicalJson(before) !== canonicalJson(after)) {
      effects.push({ kind: "placement", fileId, before, after });
    }
    const beforeMode = base?.["kind"] === "file" ? Number(base["mode"]) : null;
    const afterMode = result?.["kind"] === "file" ? Number(result["mode"]) : null;
    if (beforeMode !== afterMode) {
      effects.push({ kind: "mode", fileId, beforeMode, afterMode });
    }
    if (effects.length > 0) return effects;
  }
  const repositoryId =
    typeof result?.["repositoryId"] === "string"
      ? result["repositoryId"]
      : typeof base?.["repositoryId"] === "string"
        ? base["repositoryId"]
        : null;
  if (repositoryId) {
    return [
      {
        kind: "repository-placement",
        repositoryId,
        beforePath:
          base?.["kind"] === "repository" && typeof base["repoPath"] === "string"
            ? base["repoPath"]
            : null,
        afterPath:
          result?.["kind"] === "repository" && typeof result["repoPath"] === "string"
            ? result["repoPath"]
            : null,
      },
    ];
  }
  throw new SemanticVcsError("IntegrityFailure", `Change ${change.kind} has no public effect`);
};

type SemanticCursorPayload = Readonly<{
  kind: string;
  basis: Row;
  position: Row;
}>;

const semanticCursor = (kind: string, basis: Row, position: Row): string => {
  const bytes = new TextEncoder().encode(canonicalJson({ kind, basis, position }));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `semantic-page-v1.${sha256Hex(bytes)}.${hex}`;
};

const parseSemanticCursor = (cursor: string | undefined, kind: string, basis: Row): Row | null => {
  if (!cursor) return null;
  const match = /^semantic-page-v1\.([0-9a-f]{64})\.([0-9a-f]+)$/u.exec(cursor);
  if (!match || match[2]!.length % 2 !== 0) {
    throw new SemanticVcsError("InvalidReference", `Invalid ${kind} cursor`);
  }
  try {
    const bytes = Uint8Array.from(match[2]!.match(/../gu) ?? [], (pair) =>
      Number.parseInt(pair, 16)
    );
    if (sha256Hex(bytes) !== match[1]) throw new Error("digest mismatch");
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
      | SemanticCursorPayload
      | undefined;
    if (
      !payload ||
      payload.kind !== kind ||
      canonicalJson(payload.basis) !== canonicalJson(basis) ||
      !payload.position ||
      typeof payload.position !== "object"
    ) {
      throw new Error("basis mismatch");
    }
    return payload.position;
  } catch {
    throw new SemanticVcsError("InvalidReference", `${kind} cursor does not match its exact basis`);
  }
};

const cursorOffset = (cursor: string | undefined, basis: Row): number => {
  const position = parseSemanticCursor(cursor, "compare", basis);
  if (!position) return 0;
  const value = position["offset"];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SemanticVcsError("InvalidReference", "Invalid compare cursor position");
  }
  return Number(value);
};

type NeighborPosition = Readonly<{ phase: number; key: string }>;
type PositionedNeighborEdge = Readonly<{ position: NeighborPosition; edge: Row }>;
type PositionedHistoryEntry = Readonly<{ position: NeighborPosition; entry: Row }>;
type NeighborPhaseQuery = Readonly<{
  phase: number;
  edgeKind?: string;
  sql: string;
  params: readonly unknown[];
}>;

const parseNeighborCursor = (
  cursor: string | undefined,
  basis: Row
): Readonly<{ phase: number; key: string | null }> => {
  const position = parseSemanticCursor(cursor, "neighbors", basis);
  if (!position) return { phase: 0, key: null };
  const phase = Number(position["phase"]);
  const key = position["key"];
  if (!Number.isSafeInteger(phase) || phase < 0 || phase > 100) {
    throw new SemanticVcsError("InvalidReference", "Invalid neighbor cursor");
  }
  if (typeof key !== "string")
    throw new SemanticVcsError("InvalidReference", "Invalid neighbor cursor");
  return { phase, key };
};

const neighborCursor = ({ phase, key }: NeighborPosition, basis: Row): string =>
  semanticCursor("neighbors", basis, { phase, key });

const exactProvenanceEdge = (value: Row): Row => {
  const parsed = vcsProvenanceEdgeSchema.safeParse(value);
  if (!parsed.success) {
    throw new SemanticVcsError("IntegrityFailure", "Normalized provenance relation is invalid", {
      relation: value["kind"],
      from: (value["from"] as Row | undefined)?.["kind"],
      to: (value["to"] as Row | undefined)?.["kind"],
    });
  }
  return parsed.data;
};

const parseHistoryCursor = (
  cursor: string | undefined,
  basis: Row
): Readonly<{ phase: number; key: string | null }> => {
  const position = parseSemanticCursor(cursor, "history", basis);
  if (!position) return { phase: 0, key: null };
  const phase = Number(position["phase"]);
  const key = position["key"];
  if (!Number.isSafeInteger(phase) || phase < 0 || phase > MAX_ANCESTRY_EDGES) {
    throw new SemanticVcsError("InvalidReference", "Invalid history cursor");
  }
  if (typeof key !== "string")
    throw new SemanticVcsError("InvalidReference", "Invalid history cursor");
  return { phase, key };
};

const historyCursor = ({ phase, key }: NeighborPosition, basis: Row): string =>
  semanticCursor("history", basis, { phase, key });

const parseBlameCursor = (
  cursor: string | undefined,
  range: { start: number; end: number },
  basis: Row
): number => {
  const position = parseSemanticCursor(cursor, "blame", basis);
  if (!position) return range.start;
  const nextStart = Number(position["nextStart"]);
  if (!Number.isSafeInteger(nextStart) || nextStart! < range.start || nextStart! >= range.end) {
    throw new SemanticVcsError("InvalidReference", "Blame cursor does not match the exact range");
  }
  return nextStart!;
};

const blameCursor = (basis: Row, nextStart: number): string =>
  semanticCursor("blame", basis, { nextStart });

const causalCommandRef = (ingress: SemanticDispatchRequest["ingress"]): CausalCommandRef => ({
  parent: ingress.causalParent
    ? {
        logId: ingress.causalParent.logId,
        head: ingress.causalParent.head,
        invocationId: ingress.causalParent.invocationId,
      }
    : null,
});

export class SemanticWorkspace {
  constructor(private readonly deps: SemanticWorkspaceDeps) {}

  pendingEffects(): SemanticEffect[] {
    return this.deps.store.pendingEffects();
  }

  contentGcRoots(): { contentRoots: string[]; contentHashes: string[] } {
    const contentRoots = new Set<string>();
    const contentHashes = new Set<string>();
    for (const row of this.deps.sql
      .exec(`SELECT DISTINCT content_root FROM gad_materialized_repository_states`)
      .toArray() as Row[]) {
      contentRoots.add(String(row["content_root"]));
    }
    for (const row of this.deps.sql
      .exec(`SELECT DISTINCT content_hash FROM vcs_file_states WHERE content_hash IS NOT NULL`)
      .toArray() as Row[]) {
      contentHashes.add(String(row["content_hash"]));
    }
    // Pending effects are durable semantic roots too. Their self-contained
    // payloads may name content before the corresponding state is receipted.
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        if (/^state:[0-9a-f]{64}$/u.test(value)) contentRoots.add(value);
        else if (/^[0-9a-f]{64}$/u.test(value)) contentHashes.add(value);
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) visit(item);
      }
    };
    for (const effect of this.deps.store.pendingEffects()) visit(effect.payload);
    return {
      contentRoots: [...contentRoots].sort(compareUtf16CodeUnits),
      contentHashes: [...contentHashes].sort(compareUtf16CodeUnits),
    };
  }

  referencesReachable(
    contextIds: readonly string[],
    references: readonly { kind: string; value: unknown }[]
  ): boolean {
    if (contextIds.length === 0) return false;
    return references.every((reference) => {
      if (reference.kind === "state-node") {
        return this.referenceStateReachable(contextIds, reference.value);
      }
      if (reference.kind === "event" && typeof reference.value === "string") {
        return this.referenceStateReachable(contextIds, {
          kind: "event",
          eventId: reference.value,
        });
      }
      if (reference.kind === "node" && reference.value && typeof reference.value === "object") {
        const node = reference.value as Row;
        if (node["kind"] === "event" || node["kind"] === "application") {
          return this.referenceStateReachable(contextIds, node);
        }
        if (node["kind"] === "repository" || node["kind"] === "file") {
          return this.referenceStateReachable(contextIds, node["state"]);
        }
        return this.provenanceNodeReachable(contextIds, node);
      }
      return true;
    });
  }

  private referenceStateReachable(contextIds: readonly string[], value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const state = value as Row;
    const readableEventRoots = new Set<string>();
    for (const contextId of contextIds) {
      const context = this.deps.store.context(contextId);
      if (!context) continue;
      readableEventRoots.add(context.committed.ref.eventId);
      const workingApplicationId =
        context.working.ref.kind === "application" ? context.working.ref.applicationId : null;
      if (state["kind"] === "application" && typeof state["applicationId"] === "string") {
        const applicationId = state["applicationId"];
        if (workingApplicationId) {
          const inWorkingChain = this.deps.sql
            .exec(
              `WITH RECURSIVE chain(application_id, basis_kind, basis_id) AS (
                 SELECT application_id, basis_kind, basis_id
                   FROM gad_work_unit_applications WHERE application_id = ?
                 UNION
                 SELECT parent.application_id, parent.basis_kind, parent.basis_id
                   FROM chain child
                   JOIN gad_work_unit_applications parent
                     ON child.basis_kind = 'application' AND parent.application_id = child.basis_id
               ) SELECT 1 FROM chain WHERE application_id = ? LIMIT 1`,
              workingApplicationId,
              applicationId
            )
            .toArray();
          if (inWorkingChain.length > 0) return true;
        }
      }
    }
    if (readableEventRoots.size === 0) return false;

    // Protected main is the shared collaboration boundary. Publishing makes
    // that exact event and its semantic ancestry readable to every valid
    // context, while unpublished sibling branches remain private. Without
    // this root, status can disclose that main advanced but the caller cannot
    // compare, incrementally integrate, publish against, or walk the history
    // it was explicitly told to reconcile.
    const mainEventId = this.deps.store.mainEventId();
    if (mainEventId) readableEventRoots.add(mainEventId);

    if (state["kind"] === "application" && typeof state["applicationId"] === "string") {
      const committedBy = this.deps.sql
        .exec(
          `SELECT event_id FROM gad_workspace_event_applications WHERE application_id = ?`,
          state["applicationId"]
        )
        .toArray() as Row[];
      return committedBy.some((row) =>
        [...readableEventRoots].some((rootEventId) =>
          this.deps.store.isEventAncestor(String(row["event_id"]), rootEventId, MAX_ANCESTRY_EDGES)
        )
      );
    }
    if (state["kind"] === "event" && typeof state["eventId"] === "string") {
      return [...readableEventRoots].some((rootEventId) =>
        this.deps.store.isEventAncestor(state["eventId"] as string, rootEventId, MAX_ANCESTRY_EDGES)
      );
    }
    return false;
  }

  private provenanceNodeReachable(contextIds: readonly string[], node: Row): boolean {
    const kind = String(node["kind"] ?? "");
    let applicationIds: string[] = [];
    if (kind === "work-unit" && typeof node["workUnitId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT application_id FROM gad_work_unit_applications WHERE work_unit_id = ?`,
            node["workUnitId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "change" && typeof node["changeId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT app.application_id FROM gad_changes change
             JOIN gad_work_unit_applications app ON app.work_unit_id = change.work_unit_id
            WHERE change.change_id = ?`,
            node["changeId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "applied-change" && typeof node["appliedChangeId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT application_id FROM gad_applied_changes WHERE applied_change_id = ?`,
            node["appliedChangeId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "decision" && typeof node["decisionId"] === "string") {
      applicationIds = (
        this.deps.sql
          .exec(
            `SELECT app.application_id FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications app ON app.work_unit_id = decision.work_unit_id
            WHERE decision.decision_id = ?`,
            node["decisionId"]
          )
          .toArray() as Row[]
      ).map((row) => String(row["application_id"]));
    } else if (kind === "command" && typeof node["commandId"] === "string") {
      return this.commandReachable(contextIds, node["commandId"]);
    } else if (
      kind === "trajectory" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command_id FROM vcs_command_journal
            WHERE cause_log_id = ? AND cause_head = ?`,
          node["logId"],
          node["head"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else if (
      kind === "trajectory-invocation" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string" &&
      typeof node["invocationId"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command.command_id
             FROM vcs_command_journal command
             JOIN trajectory_invocations invocation
               ON invocation.log_id = command.cause_log_id
              AND invocation.head = command.cause_head
              AND invocation.invocation_id = command.cause_invocation_id
            WHERE invocation.log_id = ? AND invocation.head = ?
              AND invocation.invocation_id = ?`,
          node["logId"],
          node["head"],
          node["invocationId"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else if (
      kind === "trajectory-turn" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string" &&
      typeof node["turnId"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command.command_id
             FROM vcs_command_journal command
             JOIN trajectory_invocations invocation
               ON invocation.log_id = command.cause_log_id
              AND invocation.head = command.cause_head
              AND invocation.invocation_id = command.cause_invocation_id
             JOIN trajectory_turns turn
               ON turn.log_id = invocation.log_id
              AND turn.head = invocation.head
              AND turn.turn_id = invocation.turn_id
            WHERE turn.log_id = ? AND turn.head = ? AND turn.turn_id = ?`,
          node["logId"],
          node["head"],
          node["turnId"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else if (
      kind === "trajectory-message" &&
      typeof node["logId"] === "string" &&
      typeof node["head"] === "string" &&
      typeof node["messageId"] === "string"
    ) {
      const commands = this.deps.sql
        .exec(
          `SELECT command.command_id
             FROM vcs_command_journal command
             JOIN trajectory_invocations invocation
               ON invocation.log_id = command.cause_log_id
              AND invocation.head = command.cause_head
              AND invocation.invocation_id = command.cause_invocation_id
             JOIN trajectory_turns turn
               ON turn.log_id = invocation.log_id
              AND turn.head = invocation.head
              AND turn.turn_id = invocation.turn_id
             JOIN trajectory_messages message
               ON message.log_id = turn.log_id
              AND message.head = turn.head
              AND message.message_id = turn.trigger_message_id
            WHERE message.log_id = ? AND message.head = ? AND message.message_id = ?`,
          node["logId"],
          node["head"],
          node["messageId"]
        )
        .toArray() as Row[];
      return commands.some((row) => this.commandReachable(contextIds, String(row["command_id"])));
    } else {
      // Trajectory and command roots have their own service authorization;
      // semantic leaf ids without a state association are never accepted as
      // an exact-state authorization root here.
      return false;
    }
    return applicationIds.some((applicationId) =>
      this.referenceStateReachable(contextIds, { kind: "application", applicationId })
    );
  }

  private commandReachable(contextIds: readonly string[], commandId: string): boolean {
    const journal = this.deps.sql
      .exec(`SELECT scope_kind, scope_id FROM vcs_command_journal WHERE command_id = ?`, commandId)
      .toArray()[0] as Row | undefined;
    if (journal?.["scope_kind"] === "context" && contextIds.includes(String(journal["scope_id"]))) {
      return true;
    }
    const events = this.deps.sql
      .exec(`SELECT event_id FROM gad_workspace_events WHERE command_id = ?`, commandId)
      .toArray() as Row[];
    if (
      events.some((row) =>
        this.referenceStateReachable(contextIds, { kind: "event", eventId: row["event_id"] })
      )
    )
      return true;
    const applications = this.deps.sql
      .exec(
        `SELECT app.application_id FROM gad_work_units work
           JOIN gad_work_unit_applications app ON app.work_unit_id = work.work_unit_id
          WHERE work.command_id = ?`,
        commandId
      )
      .toArray() as Row[];
    return applications.some((row) =>
      this.referenceStateReachable(contextIds, {
        kind: "application",
        applicationId: row["application_id"],
      })
    );
  }

  async dispatch(
    method: string,
    request: SemanticDispatchRequest
  ): Promise<SemanticDispatchResult> {
    const canonical = method.startsWith("vcs")
      ? `${method.slice(3, 4).toLowerCase()}${method.slice(4)}`
      : method;
    if (!(canonical in this.publicMethods())) {
      throw new SemanticVcsError("InvalidReference", `Unsupported VCS method ${method}`);
    }
    const name = canonical as VcsMethodName;
    const parsed = parseVcsSemanticRequest(name, request.input).input;
    switch (name) {
      case "edit":
        return this.edit(parsed as VcsEditInput, request);
      case "move":
        return this.move(parsed as VcsMoveInput, request);
      case "copy":
        return this.copy(parsed as VcsCopyInput, request);
      case "integrate":
        return this.integrate(parsed as VcsIntegrateInput, request);
      case "revert":
        return this.revert(parsed as VcsRevertInput, request);
      case "commit":
        return this.commit(
          parsed as import("@vibestudio/service-schemas/vcs").VcsCommitInput,
          request
        );
      case "discard":
        return this.discard(parsed as VcsDiscardInput, request);
      case "importSnapshot":
        return this.importSnapshot(parsed as VcsImportSnapshotInput, request);
      case "push":
        return this.push(parsed as VcsPushInput, request);
      case "status":
        return { kind: "complete", result: this.status(parsed as VcsStatusInput, request) };
      case "compare":
        return { kind: "complete", result: this.compare(parsed as VcsCompareInput, request) };
      case "inspect":
        return { kind: "complete", result: this.inspect(parsed as VcsInspectInput, request) };
      case "neighbors":
        return { kind: "complete", result: this.neighbors(parsed as VcsNeighborsInput, request) };
      case "history":
        return { kind: "complete", result: this.history(parsed as VcsHistoryInput, request) };
      case "blame":
        return { kind: "complete", result: this.blame(parsed as VcsBlameInput, request) };
      case "resolveRepository":
        return {
          kind: "complete",
          result: this.resolveRepository(parsed as VcsResolveRepositoryInput),
        };
      case "readFile":
        return this.readFile(parsed as VcsReadFileInput, request);
      case "listFiles":
        return { kind: "complete", result: this.listFiles(parsed as VcsListFilesInput, request) };
    }
  }

  acknowledgeEffect(input: SemanticEffectAcknowledgement): SemanticDispatchResult {
    const pending = this.deps.store
      .pendingEffects()
      .find((effect) => effect.effectId === input.effectId);
    if (!pending) {
      throw new SemanticVcsError("InvalidReference", `Unknown pending effect ${input.effectId}`);
    }
    if (pending.kind === "observe-content") {
      return this.deps.transaction(() => {
        this.deps.store.acknowledgeEffect({
          ...input,
          deferCommandCompletion: true,
        });
        const method = String(pending.payload["method"]);
        const commandInput = pending.payload["input"] as Row;
        if (method === "importSnapshot") {
          const importInput = parseVcsSemanticRequest("importSnapshot", commandInput)
            .input as VcsImportSnapshotInput;
          const planned = this.planImportSnapshot(importInput, input.receipt);
          const working = this.persistWorkingMutation(
            importInput,
            planned.draft,
            pending.commandId
          );
          const committed = this.deps.store.commit({
            contextId: importInput.contextId,
            expectedWorkingHead: working.workingHead,
            commandId: pending.commandId,
            message: importInput.message ?? `Import ${importInput.source.snapshotRevision}`,
            integratesEventId: null,
            maxApplications: MAX_WORKING_APPLICATIONS,
          });
          const result = {
            contextId: importInput.contextId,
            eventId: committed.event.eventId,
            workUnitId: working.workUnitId,
            importedRepositoryIds: planned.importedRepositoryIds,
          };
          const projection = this.queueMaterialization(
            importInput.contextId,
            pending.commandId,
            asState(importInput.expectedWorkingHead),
            committed.context.working.ref,
            [],
            planned.draft
          );
          this.deps.store.updatePendingCommandResult({
            scopeKind: "context",
            scopeId: importInput.contextId,
            commandId: pending.commandId,
            result,
          });
          this.deps.store.compactAppliedObservation(pending.effectId);
          return { kind: "effects-pending", result, effects: [projection] };
        }
        const draft =
          method === "edit"
            ? this.planEdit(commandInput as unknown as VcsEditInput, input.receipt)
            : null;
        if (!draft) {
          throw new SemanticVcsError("IntegrityFailure", `Observation cannot resume ${method}`);
        }
        const result = this.persistWorkingMutation(
          commandInput as unknown as VcsEditInput,
          draft,
          pending.commandId
        );
        const projection = this.queueMaterialization(
          commandInput["contextId"] as string,
          pending.commandId,
          asState((commandInput as unknown as VcsEditInput).expectedWorkingHead),
          result.workingHead as StateNodeRef,
          draft.blobs ?? [],
          draft
        );
        this.deps.store.updatePendingCommandResult({
          scopeKind: "context",
          scopeId: String(commandInput["contextId"]),
          commandId: pending.commandId,
          result,
        });
        this.deps.store.compactAppliedObservation(pending.effectId);
        return { kind: "effects-pending", result, effects: [projection] };
      });
    }
    if (
      pending.kind === "materialize-context" &&
      !contextMaterializationReceiptProves(
        pending.payload as unknown as ContextMaterializationCommand,
        input.receipt as unknown as ContextMaterializationReceipt
      )
    ) {
      throw internalSemanticIntegrityFailure(
        "EffectMismatch",
        `Receipt does not prove materialization effect ${pending.effectId}`,
        { effectId: pending.effectId, contract: "materialization-receipt" }
      );
    }
    const applied = this.deps.transaction(() => {
      if (pending.kind === "publish-main") {
        const appliedAt = input.receipt["appliedAt"];
        if (typeof appliedAt !== "string" || !appliedAt) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            "Publication receipt lacks its host application time",
            { effectId: pending.effectId, contract: "publication-applied-at" }
          );
        }
        this.deps.store.updatePendingCommandResult({
          scopeKind: pending.scopeKind,
          scopeId: pending.scopeId,
          commandId: pending.commandId,
          result: {
            contextId: pending.payload["contextId"],
            eventId: pending.payload["publishedEventId"],
            mainEventId: pending.payload["publishedEventId"],
            effectId: pending.effectId,
            appliedAt,
          },
        });
      }
      return this.deps.store.acknowledgeEffect(input);
    });
    const command = this.deps.store.command(applied.commandId);
    return {
      kind: "complete",
      result: command?.result ?? { effectId: applied.effectId, receipt: input.receipt },
    };
  }

  ensureContext(
    input: { contextId: string; commandId: string },
    ingress: SemanticDispatchRequest["ingress"]
  ): SemanticDispatchResult {
    return this.deps.transaction(() => {
      const existing = this.deps.store.beginCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        method: "ensure-context",
        requestDigest: compactId("ensure-context-request", input),
        cause: causalCommandRef(ingress),
      });
      if (existing) {
        const context = this.deps.store.context(input.contextId);
        if (!context) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Initialized context ${input.contextId} is missing`
          );
        }
        const effects = this.deps.store.pendingEffects(input.commandId);
        return effects.length > 0
          ? { kind: "effects-pending", result: context, effects }
          : { kind: "complete", result: context };
      }
      // `ensureContext` is also the attachment path for runtime entities. A
      // context may therefore already exist because a lifecycle operation
      // (notably fork/clone/subagent creation) created and materialized its
      // exact frontier first. In that case there is no semantic transition to
      // project: the host verifies the recorded projection after this dispatch
      // and derives an exact-basis repair if the disposable bytes are missing.
      // Queuing another initialize effect here would falsely claim an absent
      // materialization basis and collide with the fork's valid projection.
      const existingContext = this.deps.store.context(input.contextId);
      const context =
        existingContext ?? this.deps.store.ensureContext(input.contextId, input.commandId);
      if (existingContext) {
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result: context,
          effectPending: false,
        });
        return { kind: "complete", result: context };
      }
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        null,
        context.working.ref,
        []
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result: context,
        effectPending: true,
      });
      return { kind: "effects-pending", result: context, effects: [effect] };
    });
  }

  contextMaterializationCommand(
    contextId: string,
    materializedState: StateNodeRef | null
  ): ContextMaterializationCommand {
    const context = this.deps.store.context(contextId);
    if (!context) throw new SemanticVcsError("InvalidReference", `Unknown context ${contextId}`);
    const commandId = compactId("context-materialization-repair", {
      contextId,
      materializedState,
      targetState: context.working.ref,
    });
    return this.buildMaterializationCommand(
      contextId,
      commandId,
      "replace",
      materializedState,
      context.working.ref,
      []
    );
  }

  forkContext(
    input: { sourceContextId: string; targetContextId: string; commandId: string },
    ingress: SemanticDispatchRequest["ingress"]
  ): SemanticDispatchResult {
    return this.deps.transaction(() => {
      const existing = this.deps.store.beginCommand({
        scopeKind: "context",
        scopeId: input.targetContextId,
        commandId: input.commandId,
        method: "fork-context",
        requestDigest: compactId("fork-context-request", input),
        cause: causalCommandRef(ingress),
      });
      if (existing) {
        const effects = this.deps.store.pendingEffects(input.commandId);
        return effects.length > 0
          ? { kind: "effects-pending", result: existing.result, effects }
          : { kind: "complete", result: existing.result };
      }
      const context = this.deps.store.forkContext(input.sourceContextId, input.targetContextId);
      const effect = this.queueMaterialization(
        input.targetContextId,
        input.commandId,
        null,
        context.working.ref,
        []
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.targetContextId,
        commandId: input.commandId,
        result: context,
        effectPending: true,
      });
      return { kind: "effects-pending", result: context, effects: [effect] };
    });
  }

  private publicMethods(): Record<VcsMethodName, true> {
    return {
      edit: true,
      move: true,
      copy: true,
      integrate: true,
      revert: true,
      commit: true,
      discard: true,
      importSnapshot: true,
      push: true,
      status: true,
      compare: true,
      inspect: true,
      neighbors: true,
      history: true,
      blame: true,
      resolveRepository: true,
      readFile: true,
      listFiles: true,
    };
  }

  private mutationReplay<T extends { commandId: string; contextId: string }>(
    method: string,
    input: T,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult | null {
    const requestDigest = compactId(`${method}-request`, input);
    const cause = causalCommandRef(request.ingress);
    if (cause.parent) {
      const invocation = this.deps.sql
        .exec(
          `SELECT 1 FROM trajectory_invocations
            WHERE log_id = ? AND head = ? AND invocation_id = ? LIMIT 1`,
          cause.parent.logId,
          cause.parent.head,
          cause.parent.invocationId
        )
        .toArray()[0];
      if (!invocation) {
        throw new SemanticVcsError(
          "InvalidReference",
          "Semantic mutation cause is not an exact trajectory invocation"
        );
      }
    }
    const existing = this.deps.store.beginCommand({
      scopeKind: "context",
      scopeId: input.contextId,
      commandId: input.commandId,
      method,
      requestDigest,
      cause,
    });
    if (!existing) return null;
    if (existing.status === "pending") {
      throw internalSemanticIntegrityFailure(
        "CommandInProgress",
        `Command ${input.commandId} is pending`,
        { commandId: input.commandId, expectedStatus: "effect-pending-or-complete" }
      );
    }
    const effects = this.deps.store.pendingEffects(input.commandId);
    return effects.length > 0
      ? { kind: "effects-pending", result: existing.result, effects }
      : { kind: "complete", result: existing.result };
  }

  /** Command admission and semantic mutation are one rollback boundary. */
  private runMutation<T extends { commandId: string; contextId: string }>(
    method: string,
    input: T,
    request: SemanticDispatchRequest,
    apply: () => SemanticDispatchResult
  ): SemanticDispatchResult {
    return this.deps.transaction(() => {
      const replay = this.mutationReplay(method, input, request);
      return replay ?? apply();
    });
  }

  private edit(input: VcsEditInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("edit", input, request, () => {
      this.deps.store.assertExpectedWorking(input.contextId, asState(input.expectedWorkingHead));
      const textFiles = input.changes.filter(
        (change): change is Extract<VcsEditInput["changes"][number], { kind: "text-edit" }> =>
          change.kind === "text-edit"
      );
      if (textFiles.length > 0) {
        const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
        const contentHashes = new Set<string>();
        for (const change of textFiles) {
          const point = this.deps.store.facts.file(root, change.fileId);
          if (!point || point.state.presence !== "placed") {
            throw new SemanticVcsError("InvalidReference", `Unknown file ${change.fileId}`);
          }
          contentHashes.add(point.state.contentHash);
        }
        const effect = this.deps.store.queueEffect({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          kind: "observe-content",
          payload: {
            method: "edit",
            representation: "bytes",
            input: input as unknown as Row,
            files: [...contentHashes]
              .sort(compareUtf16CodeUnits)
              .map((contentHash) => ({ contentHash })),
          },
        });
        const result = { contextId: input.contextId, workingHead: input.expectedWorkingHead };
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result,
          effectPending: true,
        });
        return { kind: "effects-pending", result, effects: [effect] };
      }
      const draft = this.planEdit(input, null);
      const result = this.persistWorkingMutation(input, draft, input.commandId);
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        draft.blobs ?? [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private planEdit(input: VcsEditInput, receipt: Row | null): MutationDraft {
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    const observed = new Map<string, Uint8Array>();
    if (receipt) {
      const expectedContentHashes = new Set(
        input.changes
          .filter(
            (change): change is Extract<VcsEditInput["changes"][number], { kind: "text-edit" }> =>
              change.kind === "text-edit"
          )
          .map((change) => {
            const point = this.deps.store.facts.file(root, change.fileId);
            if (!point || point.state.presence !== "placed") {
              throw new SemanticVcsError("InvalidReference", `Unknown file ${change.fileId}`);
            }
            return point.state.contentHash;
          })
      );
      const rows = receipt["files"];
      if (!Array.isArray(rows)) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content observation lacks files",
          { contract: "edit-observation" }
        );
      }
      for (const value of rows) {
        if (!value || typeof value !== "object") {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            "Content observation contains an invalid file",
            { contract: "edit-observation" }
          );
        }
        const record = value as Row;
        const contentHash = String(record["contentHash"] ?? "");
        if (!expectedContentHashes.has(contentHash) || observed.has(contentHash)) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Content observation contains an unexpected or duplicate digest ${contentHash}`,
            { contentHash, contract: "edit-observation" }
          );
        }
        const base64 = String(record["base64"] ?? "");
        const bytes = bytesFromBase64(base64);
        if (sha256Hex(bytes) !== contentHash) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Observed content differs for ${contentHash}`,
            { contentHash, contract: "edit-observation" }
          );
        }
        observed.set(contentHash, bytes);
      }
      if (observed.size !== expectedContentHashes.size) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content observation is incomplete",
          { contract: "edit-observation" }
        );
      }
    }

    const changes: MutationDraft["changes"] = [];
    const fileResults: MutationDraft["fileResults"] = [];
    const repositoryResults: MutationDraft["repositoryResults"] = [];
    const blobs: NonNullable<MutationDraft["blobs"]> = [];
    const touched = new Set<string>();
    input.changes.forEach((change, operation) => {
      if (change.kind === "repository-create") {
        if (this.deps.store.facts.repositoryAtPath(root, change.repoPath)) {
          throw new SemanticVcsError(
            "RevisionChanged",
            `Repository destination ${change.repoPath} is occupied`
          );
        }
        const repositoryId = compactId("repository", {
          commandId: input.commandId,
          operation,
          repoPath: change.repoPath,
        });
        const repositoryChangeIndex = changes.length;
        changes.push({
          operation,
          ordinal: 0,
          kind: "repo-add",
          base: null,
          result: {
            kind: "repository",
            repositoryId,
            repoPath: change.repoPath,
          },
          payload: { repoPath: change.repoPath },
        });
        repositoryResults.push({
          repositoryId,
          expected: null,
          resultPath: change.repoPath,
          newRepository: true,
          changeRef: { kind: "authored", ordinal: repositoryChangeIndex },
        });
        change.files.forEach((file, fileIndex) => {
          assertSemanticVcsPathAdmissible(file.path);
          const bytes = contentBytes(file.content);
          const contentHash = sha256Hex(bytes);
          const fileId = compactId("file", {
            commandId: input.commandId,
            operation,
            repositoryId,
            path: file.path,
          });
          const result = {
            fileId,
            presence: "placed" as const,
            repositoryId,
            path: file.path,
            contentHash,
            mode: file.mode,
            ...contentDescriptor(file.content, bytes),
          };
          const fileChangeIndex = changes.length;
          changes.push({
            operation,
            ordinal: fileIndex + 1,
            kind: "file-create",
            base: missingEndpoint(result, change.repoPath),
            result: { kind: "file", ...result, repoPath: change.repoPath },
            payload: { path: file.path, mode: file.mode },
          });
          fileResults.push({
            fileId,
            expected: null,
            result,
            newFile: true,
            changeRef: { kind: "authored", ordinal: fileChangeIndex },
          });
          blobs.push({ contentHash, base64: base64FromBytes(bytes) });
        });
        return;
      }
      if ("fileId" in change && touched.has(change.fileId)) {
        throw new SemanticVcsError("RevisionChanged", `File ${change.fileId} is edited twice`);
      }
      if ("fileId" in change) touched.add(change.fileId);
      const repository = this.presentRepository(root, change.repositoryId);
      if (change.kind === "file-create") {
        assertSemanticVcsPathAdmissible(change.path);
        if (this.deps.store.facts.fileAtPath(root, change.repositoryId, change.path)) {
          throw new SemanticVcsError("RevisionChanged", `Destination ${change.path} is occupied`);
        }
        const bytes = contentBytes(change.content);
        const contentHash = sha256Hex(bytes);
        const fileId = compactId("file", {
          commandId: input.commandId,
          operation,
          repositoryId: change.repositoryId,
          path: change.path,
        });
        const result = {
          fileId,
          presence: "placed" as const,
          repositoryId: change.repositoryId,
          path: change.path,
          contentHash,
          mode: change.mode,
          ...contentDescriptor(change.content, bytes),
        };
        const resultEndpoint: Row = {
          kind: "file",
          ...result,
          repoPath: repository.repoPath,
        };
        changes.push({
          operation,
          ordinal: 0,
          kind: "file-create",
          base: missingEndpoint(result, repository.repoPath),
          result: resultEndpoint,
          payload: change as unknown as Row,
        });
        fileResults.push({
          fileId,
          expected: null,
          result,
          newFile: true,
          changeRef: { kind: "authored", ordinal: operation },
        });
        blobs.push({ contentHash, base64: base64FromBytes(bytes) });
        return;
      }
      const point = this.placedFile(root, change.repositoryId, change.fileId);
      const base = endpointForFile(point.state, point.repository);
      if (change.kind === "file-delete") {
        changes.push({
          operation,
          ordinal: 0,
          kind: "file-delete",
          base,
          result: missingEndpoint(point.state, repository.repoPath),
          payload: change as unknown as Row,
        });
        fileResults.push({
          fileId: change.fileId,
          expected: point.state,
          result: {
            fileId: change.fileId,
            presence: "deleted",
            priorFileStateId: point.state.fileStateId,
          },
          newFile: false,
          changeRef: { kind: "authored", ordinal: operation },
        });
        return;
      }
      let bytes: Uint8Array | null = null;
      let result: Omit<PlacedFileState, "fileStateId">;
      const { fileStateId: _priorFileStateId, ...prior } = point.state;
      if (change.kind === "file-mode") {
        result = { ...prior, mode: change.mode };
      } else if (change.kind === "binary-replace") {
        bytes = bytesFromBase64(change.base64);
        result = {
          ...prior,
          contentHash: sha256Hex(bytes),
          contentKind: "bytes",
          byteLength: bytes.length,
          coordinateExtent: bytes.length,
        };
      } else {
        if (point.state.contentKind !== "text") {
          throw new SemanticVcsError(
            "RevisionChanged",
            `Text edit requires text content for ${change.fileId}`
          );
        }
        const before = observed.get(point.state.contentHash);
        if (!before)
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Missing content for ${change.fileId}`,
            { fileId: change.fileId, contract: "edit-observation" }
          );
        const text = new TextDecoder("utf-8", { fatal: true }).decode(before);
        const edits = [...change.edits].sort((left, right) => left.start - right.start);
        let cursor = 0;
        let next = "";
        for (const edit of edits) {
          if (edit.start < cursor || edit.end > text.length) {
            throw new SemanticVcsError("RevisionChanged", `Invalid edit span for ${change.fileId}`);
          }
          next += text.slice(cursor, edit.start) + edit.text;
          cursor = edit.end;
        }
        next += text.slice(cursor);
        bytes = new TextEncoder().encode(next);
        result = {
          ...prior,
          contentHash: sha256Hex(bytes),
          contentKind: "text",
          byteLength: bytes.length,
          coordinateExtent: next.length,
        };
      }
      const resultEndpoint = endpointForFile(
        { ...result, fileStateId: "planned" },
        point.repository
      );
      changes.push({
        operation,
        ordinal: 0,
        kind:
          change.kind === "text-edit"
            ? "text"
            : change.kind === "binary-replace"
              ? "content-replace"
              : change.kind,
        base,
        result: resultEndpoint,
        payload: change as unknown as Row,
      });
      fileResults.push({
        fileId: change.fileId,
        expected: point.state,
        result,
        newFile: false,
        changeRef: { kind: "authored", ordinal: operation },
      });
      if (bytes) blobs.push({ contentHash: result.contentHash, base64: base64FromBytes(bytes) });
    });
    return {
      kind: input.changes.some((change) => change.kind === "repository-create")
        ? "lifecycle"
        : "edit",
      intentSummary: input.intentSummary ?? null,
      incorporatedChangeIds: [],
      changes,
      fileResults,
      repositoryResults,
      blobs,
    };
  }

  private move(input: VcsMoveInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("move", input, request, () => {
      const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const changes: MutationDraft["changes"] = [];
      const fileResults: MutationDraft["fileResults"] = [];
      const repositoryResults: MutationDraft["repositoryResults"] = [];
      input.moves.forEach((move, operation) => {
        if (move.kind === "file") {
          const point = this.placedFile(root, move.repositoryId, move.fileId);
          const destination = this.presentRepository(root, move.destinationRepositoryId);
          if (
            this.deps.store.facts.fileAtPath(
              root,
              move.destinationRepositoryId,
              move.destinationPath
            )
          ) {
            throw new SemanticVcsError(
              "RevisionChanged",
              `Destination ${move.destinationPath} is occupied`
            );
          }
          const { fileStateId: _priorFileStateId, ...prior } = point.state;
          const result = {
            ...prior,
            repositoryId: move.destinationRepositoryId,
            path: move.destinationPath,
          };
          changes.push({
            operation,
            ordinal: 0,
            kind: "file-move",
            base: endpointForFile(point.state, point.repository),
            result: endpointForFile({ ...result, fileStateId: "planned" }, destination),
            payload: move as unknown as Row,
          });
          fileResults.push({
            fileId: move.fileId,
            expected: point.state,
            result,
            newFile: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        } else {
          const repository = this.presentRepository(root, move.repositoryId);
          if (this.deps.store.facts.repositoryAtPath(root, move.destinationPath)) {
            throw new SemanticVcsError(
              "RevisionChanged",
              `Repository path ${move.destinationPath} is occupied`
            );
          }
          changes.push({
            operation,
            ordinal: 0,
            kind: "repo-move",
            base: {
              kind: "repository",
              repositoryId: move.repositoryId,
              repoPath: repository.repoPath,
            },
            result: {
              kind: "repository",
              repositoryId: move.repositoryId,
              repoPath: move.destinationPath,
            },
            payload: move as unknown as Row,
          });
          repositoryResults.push({
            repositoryId: move.repositoryId,
            expected: repository,
            resultPath: move.destinationPath,
            newRepository: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        }
      });
      const draft: MutationDraft = {
        kind: "file-transfer",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes,
        fileResults,
        repositoryResults,
      };
      const result = this.persistWorkingMutation(input, draft, input.commandId);
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private copy(input: VcsCopyInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("copy", input, request, () => {
      const targetRoot = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const changes: MutationDraft["changes"] = [];
      const fileResults: MutationDraft["fileResults"] = [];
      input.copies.forEach((copy, operation) => {
        const sourceState = asState(copy.source.state);
        const sourceRoot = this.deps.store.stateRoot(sourceState);
        const source = this.placedFile(sourceRoot, copy.source.repositoryId, copy.source.fileId);
        const destination = this.presentRepository(targetRoot, copy.destination.repositoryId);
        if (
          this.deps.store.facts.fileAtPath(
            targetRoot,
            copy.destination.repositoryId,
            copy.destination.path
          )
        ) {
          throw new SemanticVcsError(
            "RevisionChanged",
            `Destination ${copy.destination.path} is occupied`
          );
        }
        const fileId = compactId("file", {
          commandId: input.commandId,
          operation,
          sourceFileId: copy.source.fileId,
          destination: copy.destination,
        });
        const result = {
          fileId,
          presence: "placed" as const,
          repositoryId: copy.destination.repositoryId,
          path: copy.destination.path,
          contentHash: source.state.contentHash,
          mode: source.state.mode,
          contentKind: source.state.contentKind,
          byteLength: source.state.byteLength,
          coordinateExtent: source.state.coordinateExtent,
        };
        changes.push({
          operation,
          ordinal: 0,
          kind: "file-copy",
          source: {
            kind: "file",
            state: sourceState,
            repositoryId: copy.source.repositoryId,
            repoPath: source.repository.repoPath,
            fileId: copy.source.fileId,
            path: source.state.path,
            contentHash: source.state.contentHash,
            mode: source.state.mode,
            contentKind: source.state.contentKind,
            byteLength: source.state.byteLength,
            coordinateExtent: source.state.coordinateExtent,
          },
          base: missingEndpoint(result, destination.repoPath),
          result: endpointForFile({ ...result, fileStateId: "planned" }, destination),
          payload: { destination: copy.destination },
        });
        fileResults.push({
          fileId,
          expected: null,
          result,
          newFile: true,
          changeRef: { kind: "authored", ordinal: operation },
        });
      });
      const draft: MutationDraft = {
        kind: "file-transfer",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes,
        fileResults,
        repositoryResults: [],
      };
      const result = this.persistWorkingMutation(input, draft, input.commandId);
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private integrate(
    input: VcsIntegrateInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("integrate", input, request, () => {
      if (!this.deps.store.event(input.sourceEventId)) {
        throw new SemanticVcsError(
          "InvalidReference",
          `Unknown source event ${input.sourceEventId}`
        );
      }
      const working = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
      const existingSources = this.integrationSourceEventIds(working.applicationIds);
      if (existingSources.some((sourceEventId) => sourceEventId !== input.sourceEventId)) {
        throw new SemanticVcsError(
          "ConflictPresent",
          "One local commit cannot integrate more than one source event",
          {
            sourceEventIds: [...new Set([...existingSources, input.sourceEventId])].sort(
              compareUtf16CodeUnits
            ),
          }
        );
      }
      const comparison = this.integrationComparison(
        asState(input.expectedWorkingHead),
        input.sourceEventId
      );
      const comparable = new Map(
        comparison.changes.map((entry) => [entry.change.changeId, entry] as const)
      );
      const sourceChanges = input.decision.sourceChangeIds.map((changeId) => {
        const entry = comparable.get(changeId);
        if (!entry) {
          throw new SemanticVcsError(
            "InvalidReference",
            `Change ${changeId} is not effective in source event ${input.sourceEventId}`
          );
        }
        if (
          entry.disposition.status !== "actionable" &&
          entry.disposition.status !== "already-satisfied"
        ) {
          throw new SemanticVcsError(
            "NoEffect",
            `Source change ${changeId} is already ${entry.disposition.status}`
          );
        }
        if (input.decision.kind === "adopted" && entry.disposition.status === "already-satisfied") {
          throw new SemanticVcsError(
            "NoEffect",
            `Source change ${changeId} already holds and must be reconciled, not re-applied`
          );
        }
        return entry.change;
      });
      if (input.decision.kind === "adopted") {
        const blockedBy = input.decision.sourceChangeIds.flatMap((changeId) => {
          const disposition = comparable.get(changeId)!.disposition;
          if (disposition.status !== "actionable" || disposition.applicability !== "blocked") {
            return [];
          }
          return disposition.prerequisiteChangeIds ?? [];
        });
        if (blockedBy.length > 0) {
          throw new SemanticVcsError(
            "DependencyBlocked",
            "Adopt prerequisite changes in an earlier local integration step",
            { blockingChangeIds: [...new Set(blockedBy)].sort(compareUtf16CodeUnits) }
          );
        }
        const conflicting = input.decision.sourceChangeIds.filter((changeId) => {
          const disposition = comparable.get(changeId)!.disposition;
          return disposition.status === "actionable" && disposition.applicability === "conflicting";
        });
        if (conflicting.length > 0) {
          throw new SemanticVcsError("ConflictPresent", "Selected source changes conflict", {
            sourceChangeIds: conflicting,
          });
        }
      }
      const draft: MutationDraft = {
        kind: "integrate",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: sourceChanges.map((change) => change.changeId),
        changes: [],
        fileResults: [],
        repositoryResults: [],
        appliedSourceChanges: input.decision.kind === "adopted" ? sourceChanges : [],
      };
      if (input.decision.kind === "adopted") {
        const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
        for (const change of sourceChanges) {
          const result = change.result;
          if (!result) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Source change ${change.changeId} has no result endpoint`
            );
          }
          if (result["kind"] === "missing" && typeof result["fileId"] === "string") {
            const current = this.deps.store.facts.file(root, result["fileId"]);
            if (!current || current.state.presence !== "placed") {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Applicable source change ${change.changeId} has no placed target file`
              );
            }
            draft.fileResults.push({
              fileId: current.state.fileId,
              expected: current.state,
              result: {
                fileId: current.state.fileId,
                presence: "deleted",
                priorFileStateId: current.state.fileStateId,
              },
              newFile: false,
              changeRef: { kind: "existing", changeId: change.changeId },
            });
            continue;
          }
          if (result["kind"] === "file" && typeof result["fileId"] === "string") {
            const current = this.deps.store.facts.file(root, result["fileId"]);
            draft.fileResults.push({
              fileId: String(result["fileId"]),
              expected: current?.state ?? null,
              result: {
                fileId: String(result["fileId"]),
                presence: "placed",
                repositoryId: String(result["repositoryId"]),
                path: String(result["path"]),
                contentHash: String(result["contentHash"]),
                mode: Number(result["mode"]),
                ...contentDescriptorFromEndpoint(result),
              },
              newFile: false,
              changeRef: { kind: "existing", changeId: change.changeId },
            });
            continue;
          }
          if (result["kind"] === "repository" && typeof result["repositoryId"] === "string") {
            const repositoryId = result["repositoryId"];
            const current = this.deps.store.facts.member(root, repositoryId);
            const deleted = result["presence"] === "deleted";
            if (deleted && (!current || current.presence !== "present")) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Applicable source change ${change.changeId} has no present target repository`
              );
            }
            if (!deleted && typeof result["repoPath"] !== "string") {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository result for ${change.changeId} has no path`
              );
            }
            draft.repositoryResults.push({
              repositoryId,
              expected: current,
              resultPath: deleted ? null : String(result["repoPath"]),
              newRepository: false,
              changeRef: { kind: "existing", changeId: change.changeId },
            });
            continue;
          }
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Source change ${change.changeId} has an unknown result endpoint`
          );
        }
      } else if (input.decision.kind === "reconciled") {
        for (const predicate of input.decision.evidence) {
          if (
            !this.predicateHolds(
              asState(input.expectedWorkingHead),
              predicate as StatePredicateRecord
            )
          ) {
            throw new SemanticVcsError("RevisionChanged", "Reconciliation evidence does not hold");
          }
        }
      }
      const placeholderDecision: Omit<
        IntegrationDecisionRecord,
        "decisionId" | "workUnitId" | "createdAt"
      > = {
        kind: input.decision.kind,
        targetState: asState(input.expectedWorkingHead),
        sourceEventId: input.sourceEventId,
        sourceChangeIds: sourceChanges.map((change) => change.changeId),
        evidencePredicates:
          input.decision.kind === "reconciled"
            ? (input.decision.evidence as StatePredicateRecord[])
            : [],
        rationale: input.decision.kind === "adopted" ? null : input.decision.rationale,
      };
      draft.decisions = [placeholderDecision];
      const result = this.persistWorkingMutation(input, draft, input.commandId);
      const decisionIdValue = result.decisionIds[0];
      if (!decisionIdValue) {
        throw new SemanticVcsError("IntegrityFailure", "Integration did not persist its decision");
      }
      const publicResult = { ...result, decisionId: decisionIdValue };
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result: publicResult,
        effectPending: true,
      });
      return { kind: "effects-pending", result: publicResult, effects: [effect] };
    });
  }

  private revert(input: VcsRevertInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation("revert", input, request, () => {
      const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
      const changes: MutationDraft["changes"] = [];
      const fileResults: MutationDraft["fileResults"] = [];
      const repositoryResults: MutationDraft["repositoryResults"] = [];
      const originals = [...new Set(input.changeIds)].map((changeId) =>
        this.changeRequired(changeId)
      );
      const repositoryDeletes = new Map<
        string,
        { causes: Set<string>; requiresSelectedFileRemoval: boolean }
      >();
      const addRepositoryDelete = (
        repositoryId: string,
        changeId: string,
        requiresSelectedFileRemoval: boolean
      ) => {
        const planned = repositoryDeletes.get(repositoryId) ?? {
          causes: new Set<string>(),
          requiresSelectedFileRemoval: false,
        };
        planned.causes.add(changeId);
        planned.requiresSelectedFileRemoval ||= requiresSelectedFileRemoval;
        repositoryDeletes.set(repositoryId, planned);
      };
      for (const original of originals) {
        if (original.kind === "repo-add" || original.kind === "repo-restore") {
          const repositoryId = original.result?.["repositoryId"];
          if (typeof repositoryId !== "string") {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository change ${original.changeId} has no repository identity`
            );
          }
          addRepositoryDelete(repositoryId, original.changeId, original.kind === "repo-add");
        }
      }

      for (const original of originals) {
        const changeId = original.changeId;
        if (original.kind === "repo-add" || original.kind === "repo-restore") {
          continue;
        }
        const currentResult = original.result;
        const inverseResult = original.base;
        if (
          currentResult &&
          !this.endpointHolds(asState(input.expectedWorkingHead), currentResult)
        ) {
          const blockers = this.revertBlockingChangeIds(
            asState(input.expectedWorkingHead),
            original
          );
          if (blockers.length > 0) {
            throw new SemanticVcsError(
              "DependencyBlocked",
              `Change ${changeId} has later effective changes that must be counteracted first`,
              { blockingChangeIds: blockers }
            );
          }
        }
        const inverseKind = inverseChangeKind(original.kind);
        if (!inverseKind) {
          throw new SemanticVcsError(
            "InvalidReference",
            `Change ${changeId} has no mechanical counteraction`
          );
        }
        if (currentResult?.["kind"] === "repository") {
          const repositoryId = String(currentResult["repositoryId"] ?? "");
          const current = this.deps.store.facts.member(root, repositoryId);
          if (!repositoryId || !current) {
            throw new SemanticVcsError(
              "InvalidReference",
              `Repository change ${changeId} is not present at the target state`
            );
          }
          const operation = changes.length;
          if (inverseKind === "repo-restore") {
            if (current.presence !== "deleted") {
              throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
            }
            const prior = this.deps.store.facts.memberByStateId(current.priorRepositoryStateId);
            if (!prior || prior.presence !== "present") {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository tombstone ${current.repositoryStateId} has no prior state`
              );
            }
            const priorManifestId = inverseResult?.["fileManifestId"];
            if (typeof priorManifestId !== "string") {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository deletion ${changeId} has no prior manifest coordinate`
              );
            }
            const priorFiles = this.deps.store.facts.pageManifest(priorManifestId, {
              limit: 100_000,
            });
            if (priorFiles.next !== null) {
              throw new SemanticVcsError(
                "ScopeTooLarge",
                `Repository ${repositoryId} exceeds the exact revert dependency bound`
              );
            }
            const selectedRestores = new Set(
              fileResults
                .filter(
                  (result) =>
                    result.result.presence === "placed" &&
                    result.result.repositoryId === repositoryId
                )
                .map((result) => result.fileId)
            );
            const blockers = priorFiles.values
              .filter((entry) => !selectedRestores.has(entry.fileId))
              .flatMap((entry) => {
                const blocking = this.latestAppliedChangeForFile(
                  asState(input.expectedWorkingHead),
                  entry.fileId
                );
                return blocking ? [blocking.changeId] : [];
              });
            if (blockers.length > 0) {
              throw new SemanticVcsError(
                "DependencyBlocked",
                `Repository restoration requires its contained file restorations`,
                { blockingChangeIds: [...new Set(blockers)].sort(compareUtf16CodeUnits) }
              );
            }
            if (selectedRestores.size < priorFiles.values.length) {
              throw new SemanticVcsError(
                "IntegrityFailure",
                `Repository ${repositoryId} has a contained file without a provenance dependency`
              );
            }
            const restoredPath = String(inverseResult?.["repoPath"] ?? prior.repoPath);
            repositoryResults.push({
              repositoryId,
              expected: current,
              resultPath: restoredPath,
              newRepository: false,
              changeRef: { kind: "authored", ordinal: operation },
            });
          } else if (inverseKind === "repo-move") {
            if (
              current.presence !== "present" ||
              current.repoPath !== currentResult["repoPath"] ||
              typeof inverseResult?.["repoPath"] !== "string"
            ) {
              throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
            }
            repositoryResults.push({
              repositoryId,
              expected: current,
              resultPath: inverseResult["repoPath"],
              newRepository: false,
              changeRef: { kind: "authored", ordinal: operation },
            });
          } else {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository counteraction ${inverseKind} was not normalized`
            );
          }
          changes.push({
            operation,
            ordinal: 0,
            kind: inverseKind,
            base: currentResult,
            result: inverseResult,
            payload: { counteractsChangeIds: [changeId] },
          });
          continue;
        }

        if (!currentResult || typeof currentResult["fileId"] !== "string") {
          throw new SemanticVcsError(
            "InvalidReference",
            `Change ${changeId} has no counteractable state coordinate`
          );
        }
        const current = this.deps.store.facts.file(root, String(currentResult["fileId"]));
        if (!current) {
          throw new SemanticVcsError(
            "InvalidReference",
            `File change ${changeId} is not present at the target state`
          );
        }
        if (currentResult["kind"] === "file") {
          if (
            current.state.presence !== "placed" ||
            current.state.contentHash !== currentResult["contentHash"] ||
            current.state.path !== currentResult["path"]
          ) {
            throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
          }
        } else if (currentResult["kind"] === "missing" && current.state.presence !== "deleted") {
          throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
        }
        const operation = changes.length;
        changes.push({
          operation,
          ordinal: 0,
          kind: inverseKind,
          base: currentResult,
          result: inverseResult,
          payload: { counteractsChangeIds: [changeId] },
        });
        if (!inverseResult || inverseResult["kind"] === "missing") {
          if (current.state.presence !== "placed") {
            throw new SemanticVcsError("RevisionChanged", `Change ${changeId} no longer holds`);
          }
          fileResults.push({
            fileId: current.state.fileId,
            expected: current.state,
            result: {
              fileId: current.state.fileId,
              presence: "deleted",
              priorFileStateId: current.state.fileStateId,
            },
            newFile: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        } else if (inverseResult["kind"] === "file") {
          fileResults.push({
            fileId: String(inverseResult["fileId"]),
            expected: current?.state ?? null,
            result: {
              fileId: String(inverseResult["fileId"]),
              presence: "placed",
              repositoryId: String(inverseResult["repositoryId"]),
              path: String(inverseResult["path"]),
              contentHash: String(inverseResult["contentHash"]),
              mode: Number(inverseResult["mode"]),
              ...contentDescriptorFromEndpoint(inverseResult),
            },
            newFile: false,
            changeRef: { kind: "authored", ordinal: operation },
          });
        }
      }

      for (const [repositoryId, planned] of [...repositoryDeletes].sort(([left], [right]) =>
        compareUtf16CodeUnits(left, right)
      )) {
        const repository = this.deps.store.facts.member(root, repositoryId);
        if (!repository || repository.presence !== "present") {
          throw new SemanticVcsError(
            "RevisionChanged",
            `Repository ${repositoryId} no longer has the imported result`
          );
        }
        if (planned.requiresSelectedFileRemoval) {
          const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
            limit: 100_000,
          });
          if (page.next !== null) {
            throw new SemanticVcsError(
              "ScopeTooLarge",
              `Repository ${repositoryId} exceeds the exact revert dependency bound`
            );
          }
          const selectedRemovals = new Set(
            fileResults
              .filter(
                (result) =>
                  result.expected?.presence === "placed" &&
                  result.expected.repositoryId === repositoryId &&
                  result.result.presence === "deleted"
              )
              .map((result) => result.fileId)
          );
          const blockers = page.values
            .filter((entry) => !selectedRemovals.has(entry.fileId))
            .flatMap((entry) => {
              const change = this.latestAppliedChangeForFile(
                asState(input.expectedWorkingHead),
                entry.fileId
              );
              return change ? [change.changeId] : [];
            });
          if (blockers.length > 0) {
            throw new SemanticVcsError(
              "DependencyBlocked",
              `Repository creation has live contained-file changes that must be counteracted first`,
              { blockingChangeIds: [...new Set(blockers)].sort(compareUtf16CodeUnits) }
            );
          }
          if (selectedRemovals.size !== page.values.length) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository ${repositoryId} has a contained file without a provenance dependency`
            );
          }
        }
        const operation = changes.length;
        changes.push({
          operation,
          ordinal: 0,
          kind: "repo-delete",
          base: {
            kind: "repository",
            repositoryId,
            repoPath: repository.repoPath,
            fileManifestId: repository.fileManifestId,
          },
          result: { kind: "repository", repositoryId, presence: "deleted" },
          payload: {
            counteractsChangeIds: [...planned.causes].sort(),
          },
        });
        repositoryResults.push({
          repositoryId,
          expected: repository,
          resultPath: null,
          newRepository: false,
          changeRef: { kind: "authored", ordinal: operation },
        });
      }
      const draft: MutationDraft = {
        kind: "revert",
        intentSummary: input.intentSummary ?? null,
        incorporatedChangeIds: [],
        changes,
        fileResults,
        repositoryResults,
      };
      const result = this.persistWorkingMutation(input, draft, input.commandId);
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        result.workingHead,
        [],
        draft
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private commit(
    input: import("@vibestudio/service-schemas/vcs").VcsCommitInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("commit", input, request, () => {
      const before = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
      const derivedSources = this.integrationSourceEventIds(before.applicationIds);
      if (derivedSources.length > 1) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          "The local working chain contains decisions for multiple integration sources"
        );
      }
      const derivedSourceEventId = derivedSources[0] ?? null;
      if (
        input.integratesEventId &&
        derivedSourceEventId &&
        input.integratesEventId !== derivedSourceEventId
      ) {
        throw new SemanticVcsError(
          "InvalidReference",
          `Commit source ${input.integratesEventId} disagrees with integrated source ${derivedSourceEventId}`
        );
      }
      const integrationSourceEventId = derivedSourceEventId ?? input.integratesEventId ?? null;
      const comparison = integrationSourceEventId
        ? this.integrationComparison(asState(input.expectedWorkingHead), integrationSourceEventId)
        : null;
      if (comparison?.unaccountedChangeIds.length) {
        throw new SemanticVcsError(
          "IntegrationIncomplete",
          `Integration of ${integrationSourceEventId} has unaccounted effective changes`,
          {
            sourceEventId: integrationSourceEventId,
            unaccountedChangeIds: comparison.unaccountedChangeIds,
          }
        );
      }
      const committed = this.deps.store.commit({
        contextId: input.contextId,
        expectedWorkingHead: asState(input.expectedWorkingHead),
        commandId: input.commandId,
        message: input.message ?? null,
        integratesEventId: integrationSourceEventId,
        maxApplications: MAX_WORKING_APPLICATIONS,
      });
      const result = {
        contextId: input.contextId,
        event: { kind: "event", eventId: committed.event.eventId },
        committedApplicationIds: before.applicationIds,
        integrationSourceEventId,
      };
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        committed.context.working.ref,
        []
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private discard(
    input: VcsDiscardInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("discard", input, request, () => {
      const chain = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
      const context = this.deps.store.discard(input.contextId, asState(input.expectedWorkingHead));
      const result = {
        contextId: input.contextId,
        workingHead: context.working.ref,
        discardedApplicationIds: chain.applicationIds,
      };
      const effect = this.queueMaterialization(
        input.contextId,
        input.commandId,
        asState(input.expectedWorkingHead),
        context.working.ref,
        [],
        undefined,
        this.deps.store.affectedRepositoryIds(chain.applicationIds)
      );
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private importSnapshot(
    input: VcsImportSnapshotInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    return this.runMutation("importSnapshot", input, request, () => {
      if (input.expectedWorkingHead.kind !== "event") {
        throw new SemanticVcsError("RevisionChanged", "Snapshot import requires a clean context");
      }
      this.deps.store.assertExpectedWorking(input.contextId, asState(input.expectedWorkingHead));
      for (const repository of input.repositories) {
        for (const file of repository.files) assertSemanticVcsPathAdmissible(file.path);
      }
      this.assertImportRepositoryTargets(input);
      const repositories = importedRepositories(input);
      const importedRepositoryIds = repositories.map(({ repositoryId }) => repositoryId);
      const contentHashes = [
        ...new Set(
          input.repositories.flatMap((repository) =>
            repository.files.map((file) => file.contentHash)
          )
        ),
      ].sort(compareUtf16CodeUnits);
      const effect = this.deps.store.queueEffect({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        kind: "observe-content",
        payload: {
          method: "importSnapshot",
          representation: "descriptor",
          input: input as unknown as Row,
          files: contentHashes.map((contentHash) => ({ contentHash })),
        },
      });
      const result = { contextId: input.contextId, importedRepositoryIds };
      this.deps.store.finishCommand({
        scopeKind: "context",
        scopeId: input.contextId,
        commandId: input.commandId,
        result,
        effectPending: true,
      });
      return { kind: "effects-pending", result, effects: [effect] };
    });
  }

  private planImportSnapshot(
    input: VcsImportSnapshotInput,
    receipt: Row
  ): { draft: MutationDraft; importedRepositoryIds: string[] } {
    const rows = receipt["files"];
    if (!Array.isArray(rows)) {
      throw internalSemanticIntegrityFailure("EffectMismatch", "Content observation lacks files", {
        contract: "import-observation",
      });
    }
    const expectedContentHashes = new Set(
      input.repositories.flatMap((repository) => repository.files.map((file) => file.contentHash))
    );
    const observed = new Map<string, ObservedContentDescriptor>();
    for (const value of rows) {
      if (!value || typeof value !== "object") {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          "Content observation contains an invalid file",
          { contract: "import-observation" }
        );
      }
      const record = value as Row;
      const contentHash = String(record["contentHash"] ?? "");
      if (!expectedContentHashes.has(contentHash) || observed.has(contentHash)) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Content observation contains an unexpected or duplicate digest ${contentHash}`,
          { contentHash, contract: "import-observation" }
        );
      }
      const contentKind = record["contentKind"];
      const byteLength = record["byteLength"];
      const coordinateExtent = record["coordinateExtent"];
      if (
        (contentKind !== "text" && contentKind !== "bytes") ||
        !Number.isSafeInteger(byteLength) ||
        Number(byteLength) < 0 ||
        !Number.isSafeInteger(coordinateExtent) ||
        Number(coordinateExtent) < 0 ||
        (contentKind === "bytes" && coordinateExtent !== byteLength) ||
        (contentKind === "text" && Number(coordinateExtent) > Number(byteLength))
      ) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Content observation has an invalid intrinsic descriptor for ${contentHash}`,
          { contentHash, contract: "import-observation" }
        );
      }
      observed.set(contentHash, {
        contentKind,
        byteLength: Number(byteLength),
        coordinateExtent: Number(coordinateExtent),
      });
    }
    if (observed.size !== expectedContentHashes.size) {
      throw internalSemanticIntegrityFailure(
        "EffectMismatch",
        "Content observation is incomplete",
        { contract: "import-observation" }
      );
    }
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    const changes: MutationDraft["changes"] = [];
    const fileResults: MutationDraft["fileResults"] = [];
    const repositoryResults: MutationDraft["repositoryResults"] = [];
    const repositories = importedRepositories(input);
    const existingFiles = this.importExistingFiles(input, root);
    const importedRepositoryIds = repositories.map(({ repositoryId }) => repositoryId);
    const snapshotDigest = importedSnapshotDigest(input.repositories, observed);
    for (const { input: repositoryInput, repositoryId } of repositories) {
      const existing = repositoryInput.repositoryId
        ? this.deps.store.facts.member(root, repositoryId)
        : null;
      if (existing == null) {
        const changeIndex = changes.length;
        changes.push({
          operation: changeIndex,
          ordinal: 0,
          kind: "repo-add",
          base: null,
          result: {
            kind: "repository",
            repositoryId,
            repoPath: repositoryInput.repoPath,
          },
          payload: {},
        });
        repositoryResults.push({
          repositoryId,
          expected: null,
          resultPath: repositoryInput.repoPath,
          newRepository: true,
          changeRef: { kind: "authored", ordinal: changeIndex },
        });
      }
      const expectedByPath = existingFiles.get(repositoryId) ?? new Map<string, PlacedFileState>();
      const importedPaths = new Set(repositoryInput.files.map((file) => file.path));
      for (const [path, prior] of expectedByPath) {
        if (importedPaths.has(path)) continue;
        if (!existing || existing.presence !== "present") {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Imported deletion has no present repository ${repositoryId}`
          );
        }
        const changeIndex = changes.length;
        changes.push({
          operation: changeIndex,
          ordinal: 0,
          kind: "file-delete",
          base: endpointForFile(prior, existing),
          result: missingEndpoint(prior, existing.repoPath),
          payload: {},
        });
        fileResults.push({
          fileId: prior.fileId,
          expected: prior,
          result: {
            fileId: prior.fileId,
            presence: "deleted",
            priorFileStateId: prior.fileStateId,
          },
          newFile: false,
          changeRef: { kind: "authored", ordinal: changeIndex },
        });
      }
      for (const file of repositoryInput.files) {
        const descriptor = observed.get(file.contentHash);
        if (!descriptor) {
          throw internalSemanticIntegrityFailure(
            "EffectMismatch",
            `Content observation lacks ${file.contentHash}`,
            { contentHash: file.contentHash, contract: "import-observation" }
          );
        }
        const prior = expectedByPath.get(file.path) ?? null;
        if (
          prior &&
          prior.contentHash === file.contentHash &&
          prior.mode === file.mode &&
          prior.contentKind === descriptor.contentKind &&
          prior.byteLength === descriptor.byteLength &&
          prior.coordinateExtent === descriptor.coordinateExtent
        ) {
          continue;
        }
        const fileId =
          prior?.fileId ??
          compactId("file", { commandId: input.commandId, repositoryId, path: file.path });
        const result = {
          fileId,
          presence: "placed" as const,
          repositoryId,
          path: file.path,
          contentHash: file.contentHash,
          mode: file.mode,
          ...descriptor,
        };
        const changeIndex = changes.length;
        const resultEndpoint: Row = {
          kind: "file",
          ...result,
          repoPath: repositoryInput.repoPath,
        };
        if (prior) {
          if (!existing || existing.presence !== "present") {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Imported replacement has no present repository ${repositoryId}`
            );
          }
          const contentUnchanged =
            prior.contentHash === file.contentHash &&
            prior.contentKind === descriptor.contentKind &&
            prior.byteLength === descriptor.byteLength &&
            prior.coordinateExtent === descriptor.coordinateExtent;
          changes.push({
            operation: changeIndex,
            ordinal: 0,
            kind: contentUnchanged ? "file-mode" : "content-replace",
            base: endpointForFile(prior, existing),
            result: resultEndpoint,
            payload: contentUnchanged ? { mode: file.mode } : {},
          });
        } else {
          changes.push({
            operation: changeIndex,
            ordinal: 0,
            kind: "file-create",
            base: missingEndpoint(result, repositoryInput.repoPath),
            result: resultEndpoint,
            payload: {},
          });
        }
        fileResults.push({
          fileId,
          expected: prior,
          result,
          newFile: prior == null,
          changeRef: { kind: "authored", ordinal: changeIndex },
        });
      }
    }
    const draft: MutationDraft = {
      kind: "import",
      intentSummary: input.intentSummary ?? input.message ?? null,
      externalSnapshot: {
        sourceKind: input.source.kind,
        sourceUri: input.source.uri,
        snapshotRevision: input.source.snapshotRevision,
        snapshotDigest,
        targetRepositoryIds: [...new Set(importedRepositoryIds)].sort(compareUtf16CodeUnits),
      },
      incorporatedChangeIds: [],
      changes,
      fileResults,
      repositoryResults,
    };
    return { draft, importedRepositoryIds };
  }

  private assertImportRepositoryTargets(input: VcsImportSnapshotInput): void {
    const root = this.deps.store.stateRoot(asState(input.expectedWorkingHead));
    this.importExistingFiles(input, root);
  }

  /**
   * Collect the exact replacement basis while charging it to the same byte
   * budget as the incoming descriptor. A replacement cannot hide unbounded
   * delete work behind a tiny input; new imports pay for every authored file
   * directly in their descriptor.
   */
  private importExistingFiles(
    input: VcsImportSnapshotInput,
    root: string
  ): Map<string, Map<string, PlacedFileState>> {
    const byRepository = new Map<string, Map<string, PlacedFileState>>();
    let admittedBytes = vcsImportDescriptorByteLength(input);
    for (const { input: repositoryInput, repositoryId } of importedRepositories(input)) {
      if (!repositoryInput.repositoryId) continue;
      const existing = this.deps.store.facts.member(root, repositoryId);
      if (!existing || existing.presence !== "present") {
        throw new SemanticVcsError(
          "InvalidReference",
          `Snapshot replacement requires a present repository ${repositoryId}`
        );
      }
      if (existing.repoPath !== repositoryInput.repoPath) {
        throw new SemanticVcsError(
          "InvalidReference",
          `Snapshot import cannot move repository ${repositoryId}; use vcs.move first`
        );
      }
      const files = new Map<string, PlacedFileState>();
      let afterPath: string | undefined;
      do {
        const page = this.deps.store.facts.pageManifest(existing.fileManifestId, {
          ...(afterPath ? { afterPath } : {}),
          limit: 500,
        });
        for (const entry of page.values) {
          const point = this.deps.store.facts.file(root, entry.fileId);
          if (!point || point.state.presence !== "placed") {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Repository ${repositoryId} manifest references an absent file ${entry.fileId}`
            );
          }
          admittedBytes += vcsImportDescriptorByteLength({
            repositoryId,
            path: entry.path,
            state: point.state,
          });
          if (admittedBytes > VCS_IMPORT_MAX_DESCRIPTOR_BYTES) {
            throw new SemanticVcsError(
              "ScopeTooLarge",
              `Snapshot import descriptor and replacement basis exceed ${VCS_IMPORT_MAX_DESCRIPTOR_BYTES} UTF-8 bytes`,
              {
                scope: "import descriptor and replacement basis",
                maximum: VCS_IMPORT_MAX_DESCRIPTOR_BYTES,
              }
            );
          }
          files.set(entry.path, point.state);
        }
        afterPath = page.next ?? undefined;
      } while (afterPath !== undefined);
      byRepository.set(repositoryId, files);
    }
    return byRepository;
  }

  private push(input: VcsPushInput, request: SemanticDispatchRequest): SemanticDispatchResult {
    return this.runMutation(
      "push",
      { ...input, expectedWorkingHead: { kind: "event", eventId: input.expectedCommittedEventId } },
      request,
      () => {
        const context = this.deps.store.contextRequired(input.contextId);
        if (
          context.workingHeadApplicationId ||
          context.committed.ref.eventId !== input.expectedCommittedEventId
        ) {
          throw new SemanticVcsError(
            "RevisionChanged",
            "Push requires the exact clean committed event"
          );
        }
        const main = this.deps.store.mainEventId();
        if (main !== input.expectedMainEventId) {
          throw new SemanticVcsError("RevisionChanged", "Protected main changed");
        }
        if (
          !this.deps.store.isEventAncestor(
            input.expectedMainEventId,
            input.expectedCommittedEventId,
            MAX_ANCESTRY_EDGES
          )
        ) {
          throw new SemanticVcsError("RevisionChanged", "Push is not a semantic fast-forward");
        }
        this.assertIntegrationHistoryValid(
          input.expectedMainEventId,
          input.expectedCommittedEventId
        );
        const effect = this.deps.store.queueEffect({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          kind: "publish-main",
          payload: {
            contextId: input.contextId,
            previousEventId: input.expectedMainEventId,
            publishedEventId: input.expectedCommittedEventId,
            // Protected publication deliberately carries a complete immutable
            // repository snapshot; context working-tree effects are patches.
            repositories: this.publicationRepositories(
              context.committed.workspaceFactRootId
            ) as unknown as Row[],
          },
        });
        const result = {
          contextId: input.contextId,
          eventId: input.expectedCommittedEventId,
          effectId: effect.effectId,
        };
        this.deps.store.finishCommand({
          scopeKind: "context",
          scopeId: input.contextId,
          commandId: input.commandId,
          result,
          effectPending: true,
        });
        return { kind: "effects-pending", result, effects: [effect] };
      }
    );
  }

  private status(input: VcsStatusInput, request: SemanticDispatchRequest): Row {
    const context = this.deps.store.contextRequired(input.contextId);
    const chain = this.deps.store.workingChain(input.contextId, MAX_WORKING_APPLICATIONS);
    const workUnits = new Set(
      chain.applicationIds.map((id) => this.deps.store.application(id)?.workUnitId).filter(Boolean)
    );
    const changes = chain.applicationIds.reduce(
      (count, id) => count + (this.deps.store.application(id)?.appliedChangeIds.length ?? 0),
      0
    );
    const main = this.deps.store.mainEventId();
    return {
      contextId: input.contextId,
      committed: context.committed.ref,
      workingHead: context.working.ref,
      clean: context.workingHeadApplicationId === null,
      mainEventId: main,
      mainRelation:
        main === context.committed.ref.eventId
          ? "at"
          : main &&
              this.deps.store.isEventAncestor(
                main,
                context.committed.ref.eventId,
                MAX_ANCESTRY_EDGES
              )
            ? "ahead"
            : main &&
                this.deps.store.isEventAncestor(
                  context.committed.ref.eventId,
                  main,
                  MAX_ANCESTRY_EDGES
                )
              ? "behind"
              : "diverged",
      workingCounts: {
        applications: chain.applicationIds.length,
        workUnits: workUnits.size,
        changes,
      },
    };
  }

  private compare(input: VcsCompareInput, request: SemanticDispatchRequest): Row {
    const comparison = this.integrationComparison(asState(input.target), input.sourceEventId);
    const selected = input.disposition
      ? comparison.changes.filter(({ disposition }) => disposition.status === input.disposition)
      : comparison.changes;
    const rows = selected.map(({ change, disposition }) => ({
      changeId: change.changeId,
      workUnitId: change.workUnitId,
      kind: publicChangeKind(change.kind),
      summary: publicChangeKind(change.kind),
      disposition,
    }));
    const counts = {
      shared: comparison.changes.filter((row) => row.disposition.status === "shared").length,
      alreadySatisfied: comparison.changes.filter(
        (row) => row.disposition.status === "already-satisfied"
      ).length,
      actionable: comparison.changes.filter((row) => row.disposition.status === "actionable")
        .length,
      conflicting: comparison.changes.filter(
        (row) =>
          row.disposition.status === "actionable" && row.disposition.applicability === "conflicting"
      ).length,
      blocked: comparison.changes.filter(
        (row) =>
          row.disposition.status === "actionable" && row.disposition.applicability === "blocked"
      ).length,
      accounted: comparison.changes.filter((row) => row.disposition.status === "accounted").length,
      historical: comparison.changes.filter((row) => row.disposition.status === "historical")
        .length,
    };
    const cursorBasis = {
      target: input.target,
      sourceEventId: input.sourceEventId,
      view: input.view,
    };
    const offset = cursorOffset(input.cursor, cursorBasis);
    return {
      target: input.target,
      sourceEventId: input.sourceEventId,
      resolution: {
        complete: comparison.unaccountedChangeIds.length === 0,
        remainingChangeCount: comparison.unaccountedChangeIds.length,
      },
      counts,
      changes: input.view === "changes" ? rows.slice(offset, offset + input.limit) : [],
      nextCursor:
        offset + input.limit < rows.length
          ? semanticCursor("compare", cursorBasis, { offset: offset + input.limit })
          : null,
    };
  }

  private inspect(input: VcsInspectInput, request: SemanticDispatchRequest): Row {
    const value = this.inspectNode(input.node as Row);
    const page = this.neighborEdges(input.node as Row, undefined, input.edgeLimit + 1);
    return {
      root: input.node,
      node: value,
      edges: page.slice(0, input.edgeLimit).map(({ edge }) => exactProvenanceEdge(edge)),
      hasMoreEdges: page.length > input.edgeLimit,
    };
  }

  private neighbors(input: VcsNeighborsInput, request: SemanticDispatchRequest): Row {
    const cursorBasis = { root: input.root };
    const edges = this.neighborEdges(input.root as Row, input.cursor, input.limit + 1);
    return {
      root: input.root,
      edges: edges.slice(0, input.limit).map(({ edge }) => exactProvenanceEdge(edge)),
      nextCursor:
        edges.length > input.limit
          ? neighborCursor(edges[input.limit - 1]!.position, cursorBasis)
          : null,
    };
  }

  private history(input: VcsHistoryInput, request: SemanticDispatchRequest): Row {
    const cursorBasis = { root: input.root, direction: input.direction };
    const entries = this.historyEntries(
      input.root as Row,
      input.direction,
      input.cursor,
      input.limit + 1
    );
    return {
      root: input.root,
      entries: entries.slice(0, input.limit).map(({ entry }) => entry),
      nextCursor:
        entries.length > input.limit
          ? historyCursor(entries[input.limit - 1]!.position, cursorBasis)
          : null,
    };
  }

  private blame(input: VcsBlameInput, request: SemanticDispatchRequest): Row {
    const root = this.deps.store.stateRoot(asState(input.state));
    const point = this.deps.store.facts.file(root, input.fileId);
    if (
      !point ||
      point.state.presence !== "placed" ||
      point.state.repositoryId !== input.repositoryId
    ) {
      throw new SemanticVcsError("InvalidReference", `Unknown file ${input.fileId}`);
    }
    if (input.range.end > point.state.coordinateExtent) {
      throw new SemanticVcsError("InvalidReference", "Blame range exceeds the exact file extent");
    }
    if (input.range.start === input.range.end) {
      return {
        state: input.state,
        fileId: input.fileId,
        coordinateKind: coordinateKindForFile(point.state),
        spans: [],
        nextCursor: null,
      };
    }
    const coordinateKind = coordinateKindForFile(point.state);
    const terminal = this.latestAppliedChangeForFile(asState(input.state), input.fileId);
    if (!terminal) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Placed file ${input.fileId} has no originating applied change`
      );
    }
    const cursorBasis = {
      state: input.state,
      repositoryId: input.repositoryId,
      fileId: input.fileId,
      range: input.range,
    };
    const traceStart = parseBlameCursor(input.cursor, input.range, cursorBasis);
    const spans = this.traceBlameRange(
      terminal.appliedChangeId,
      {
        rootStart: traceStart,
        rootEnd: input.range.end,
        currentStart: traceStart,
        currentEnd: input.range.end,
        coordinateKind,
        path: [],
        visited: new Set(),
      },
      input.limit + 1
    );
    const ordered = spans.sort(
      (left, right) =>
        Number(left["start"]) - Number(right["start"]) || Number(left["end"]) - Number(right["end"])
    );
    const page = ordered.slice(0, input.limit);
    const next = ordered[input.limit];
    return {
      state: input.state,
      fileId: input.fileId,
      coordinateKind,
      spans: page,
      nextCursor: next ? blameCursor(cursorBasis, Number(next["start"])) : null,
    };
  }

  private resolveRepository(input: VcsResolveRepositoryInput): VcsResolveRepositoryResult {
    const root = this.deps.store.stateRoot(asState(input.state));
    const repository = this.deps.store.facts.repositoryAtPath(root, input.repoPath);
    if (!repository || repository.presence !== "present") return null;
    return {
      state: input.state,
      repositoryId: repository.repositoryId,
      repoPath: repository.repoPath,
    };
  }

  private readFile(
    input: VcsReadFileInput,
    request: SemanticDispatchRequest
  ): SemanticDispatchResult {
    const root = this.deps.store.stateRoot(asState(input.state));
    const point =
      input.file.kind === "id"
        ? this.deps.store.facts.file(root, input.file.fileId)
        : this.deps.store.facts.fileAtPath(root, input.repositoryId, input.file.path);
    if (
      !point ||
      point.state.presence !== "placed" ||
      point.state.repositoryId !== input.repositoryId ||
      point.repository.presence !== "present" ||
      point.repository.repositoryId !== input.repositoryId
    ) {
      return { kind: "complete", result: null };
    }
    return {
      kind: "host-read",
      request: {
        kind: "read-semantic-blob",
        state: input.state,
        repositoryId: input.repositoryId,
        fileId: point.state.fileId,
        repoPath: point.repository.repoPath,
        path: point.state.path,
        contentHash: point.state.contentHash,
        mode: point.state.mode,
      },
    };
  }

  private listFiles(input: VcsListFilesInput, request: SemanticDispatchRequest): Row {
    const root = this.deps.store.stateRoot(asState(input.state));
    const repository = this.presentRepository(root, input.repositoryId);
    const cursorBasis = {
      state: input.state,
      repositoryId: input.repositoryId,
      prefix: input.prefix ?? null,
    };
    const cursorPosition = parseSemanticCursor(input.cursor, "list-files", cursorBasis);
    const afterPath = cursorPosition?.["path"];
    if (afterPath !== undefined && typeof afterPath !== "string") {
      throw new SemanticVcsError("InvalidReference", "Invalid list-files cursor position");
    }
    const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
      afterPath,
      limit: input.limit,
    });
    const files = page.values
      .filter((value) => !input.prefix || value.path.startsWith(input.prefix))
      .map(({ fileId }) => this.deps.store.facts.file(root, fileId)?.state)
      .filter((state): state is PlacedFileState => state?.presence === "placed")
      .map((state) => ({
        fileId: state.fileId,
        path: state.path,
        contentHash: state.contentHash,
        mode: state.mode,
        contentKind: state.contentKind,
        byteLength: state.byteLength,
        coordinateExtent: state.coordinateExtent,
      }));
    return {
      state: input.state,
      repositoryId: input.repositoryId,
      files,
      nextCursor: page.next ? semanticCursor("list-files", cursorBasis, { path: page.next }) : null,
    };
  }

  private persistWorkingMutation(
    input: { contextId: string; expectedWorkingHead: VcsStateNodeRef; commandId: string },
    draft: MutationDraft,
    commandId: string
  ): {
    commandId: string;
    contextId: string;
    workUnitId: string;
    applicationId: string;
    changeCount: number;
    changeIds: string[];
    incorporatedChangeCount: number;
    incorporatedChangeIds: string[];
    workingHead: StateNodeRef;
    decisionIds: string[];
  } {
    const basis = asState(input.expectedWorkingHead);
    const basisRoot = this.deps.store.stateRoot(basis);
    const createdAt = this.deps.now();
    const workUnitIdValue = workUnitIdentity({
      commandId,
      kind: draft.kind,
      intentSummary: draft.intentSummary,
      externalSnapshot: draft.externalSnapshot ?? null,
    });
    const changes: ChangeRecord[] = draft.changes.map((change) => {
      const withoutIdentity = {
        ...change,
        source: change.source ?? null,
        workUnitId: workUnitIdValue,
      };
      const changeId = changeIdentity(withoutIdentity);
      return {
        ...withoutIdentity,
        changeId,
        effectDigest: compactId("change-effect", {
          kind: change.kind,
          source: change.source ?? null,
          base: change.base,
          result: change.result,
          payload: change.payload,
        }),
      };
    });
    const changeIdAt = (ordinal: number): string => {
      const value = changes[ordinal]?.changeId;
      if (!value)
        throw new SemanticVcsError("IntegrityFailure", `Missing change ordinal ${ordinal}`);
      return value;
    };
    const changeIdFor = (ref: DraftChangeRef): string =>
      ref.kind === "existing" ? ref.changeId : changeIdAt(ref.ordinal);
    const fileTransitions: FileTransition[] = draft.fileResults.map((value) => ({
      fileId: value.fileId,
      expected: value.expected,
      result:
        value.result.presence === "placed"
          ? workspaceFileStateIdentity(value.result)
          : workspaceFileStateIdentity({
              fileId: value.result.fileId,
              presence: "deleted",
              priorFileStateId: value.result.priorFileStateId,
              tombstoneChangeId: changeIdFor(value.changeRef),
            }),
      changeId: changeIdFor(value.changeRef),
      newFile: value.newFile,
    }));
    const repoTransitions: RepositoryTransition[] = draft.repositoryResults.map((value) => ({
      repositoryId: value.repositoryId,
      expected: value.expected,
      resultPath: value.resultPath,
      changeId: value.changeRef === null ? null : changeIdFor(value.changeRef),
      tombstoneChangeId:
        value.resultPath === null && value.changeRef !== null ? changeIdFor(value.changeRef) : null,
      newRepository: value.newRepository,
    }));
    const workspaceChangeSet =
      fileTransitions.length || repoTransitions.length
        ? this.planWorkspaceFacts(basisRoot, fileTransitions, repoTransitions)
        : null;
    const resultRoot = workspaceChangeSet
      ? this.deps.store.facts.compose(workspaceChangeSet).resultRoot.workspaceFactRootId
      : basisRoot;
    const appliedChangeSources = [...changes, ...(draft.appliedSourceChanges ?? [])];
    const predicatesByChangeId = new Map<string, StatePredicateRecord[]>();
    const predicatesFor = (changeId: string): StatePredicateRecord[] => {
      let predicates = predicatesByChangeId.get(changeId);
      if (!predicates) {
        predicates = [];
        predicatesByChangeId.set(changeId, predicates);
      }
      return predicates;
    };
    for (const file of fileTransitions) {
      predicatesFor(file.changeId).push(predicateForState(file.result));
    }
    for (const repository of repoTransitions) {
      if (repository.tombstoneChangeId) {
        predicatesFor(repository.tombstoneChangeId).push({
          kind: "repository-absent",
          repositoryId: repository.repositoryId,
        });
      }
      if (repository.changeId && typeof repository.resultPath === "string") {
        predicatesFor(repository.changeId).push({
          kind: "repository-present",
          repositoryId: repository.repositoryId,
          repoPath: repository.resultPath,
        });
      }
    }
    const appliedDrafts = appliedChangeSources.map((change, ordinal) => {
      return {
        changeId: change.changeId,
        ordinal,
        appliedBase: change.base,
        appliedResult: change.result,
        resultPredicates: predicatesByChangeId.get(change.changeId) ?? [],
      };
    });
    const applicationIdValue = applicationIdentity({
      workUnitId: workUnitIdValue,
      basis,
      resultWorkspaceFactRootId: resultRoot,
      semanticProtocol: SEMANTIC_PROTOCOL,
      changes: appliedDrafts,
    });
    const appliedChanges: AppliedChangeRecord[] = appliedDrafts.map((value) => {
      const withoutIdentity = { ...value, applicationId: applicationIdValue };
      return { ...withoutIdentity, appliedChangeId: appliedChangeIdentity(withoutIdentity) };
    });
    const application: ApplicationRecord = {
      applicationId: applicationIdValue,
      workUnitId: workUnitIdValue,
      basis,
      appliedChangeIds: appliedChanges.map((value) => value.appliedChangeId),
      resultWorkspaceFactRootId: resultRoot,
      semanticProtocol: SEMANTIC_PROTOCOL,
    };
    const newFileChangeIds = new Set(
      fileTransitions
        .filter((transition) => transition.newFile)
        .map((transition) => transition.changeId)
    );
    const derivedContentEdges = appliedChanges.flatMap((appliedChange, ordinal) => {
      const change = appliedChangeSources[ordinal];
      if (!change) return [];
      const child = this.contentEndpoint(change.result) ?? this.contentEndpoint(change.base);
      if (!child) {
        if (change.kind === "file-copy") {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} has no content endpoint`
          );
        }
        return [];
      }
      const copySource = change.kind === "file-copy" ? change.source : null;
      if (change.kind === "file-copy" && !copySource) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Copy change ${change.changeId} has no exact source coordinate`
        );
      }
      if (change.kind !== "file-copy" && newFileChangeIds.has(change.changeId)) return [];
      const parent = copySource
        ? this.latestAppliedChangeForFile(copySource.state, copySource.fileId)
        : this.latestAppliedChangeForFile(basis, child.fileId);
      if (!parent) {
        if (copySource) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} reaches no applied source change`
          );
        }
        return [];
      }
      const parentEndpoint = this.appliedContentEndpoint(parent.appliedChangeId);
      if (!parentEndpoint) {
        if (copySource) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} reaches source without content coordinates`
          );
        }
        return [];
      }
      let relation: ContentEdgeRecord["relation"];
      let mappings: ContentMapping[];
      if (copySource) {
        if (
          child.contentHash !== copySource.contentHash ||
          parentEndpoint.fileId !== copySource.fileId ||
          parentEndpoint.contentHash !== copySource.contentHash ||
          parentEndpoint.coordinateKind !== child.coordinateKind ||
          parentEndpoint.coordinateExtent !== child.coordinateExtent
        ) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Copy change ${change.changeId} does not match its exact source content`
          );
        }
        relation = "copies";
        mappings = [
          mappingForWholeFile({
            childContentHash: child.contentHash,
            parentContentHash: parentEndpoint.contentHash,
            coordinateKind: child.coordinateKind,
            coordinateExtent: child.coordinateExtent,
          }),
        ];
      } else if (
        parentEndpoint.contentHash === child.contentHash &&
        parentEndpoint.coordinateKind === child.coordinateKind &&
        parentEndpoint.coordinateExtent === child.coordinateExtent
      ) {
        relation = "preserves";
        mappings = [
          mappingForWholeFile({
            childContentHash: child.contentHash,
            parentContentHash: parentEndpoint.contentHash,
            coordinateKind: child.coordinateKind,
            coordinateExtent: child.coordinateExtent,
          }),
        ];
      } else if (change.kind === "text") {
        const base = this.contentEndpoint(change.base);
        if (
          !base ||
          base.coordinateKind !== "utf16" ||
          child.coordinateKind !== "utf16" ||
          parentEndpoint.contentHash !== base.contentHash ||
          parentEndpoint.coordinateKind !== base.coordinateKind ||
          parentEndpoint.coordinateExtent !== base.coordinateExtent
        ) {
          return [];
        }
        relation = "incorporates";
        const counteractedChangeIds = this.counteractedChangeIds(change);
        mappings =
          counteractedChangeIds.length > 0
            ? this.invertedCounteractionMappings(counteractedChangeIds, child, parentEndpoint)
            : mappingsForTextEdits({
                childContentHash: child.contentHash,
                childExtent: child.coordinateExtent,
                parentContentHash: parentEndpoint.contentHash,
                parentExtent: parentEndpoint.coordinateExtent,
                edits: change.payload["edits"],
              });
      } else {
        return [];
      }
      const withoutIdentity: Omit<ContentEdgeRecord, "contentEdgeId"> = {
        childAppliedChangeId: appliedChange.appliedChangeId,
        parentAppliedChangeId: parent.appliedChangeId,
        relation,
        mappings,
      };
      return [{ ...withoutIdentity, contentEdgeId: contentEdgeIdentity(withoutIdentity) }];
    });
    const contentEdges = [...(draft.contentEdges ?? []), ...derivedContentEdges].filter(
      (edge, index, values) =>
        values.findIndex((candidate) => candidate.contentEdgeId === edge.contentEdgeId) === index
    );
    const decisions: IntegrationDecisionRecord[] = (draft.decisions ?? []).map((decision) => {
      const complete: Omit<IntegrationDecisionRecord, "decisionId"> = {
        ...decision,
        workUnitId: workUnitIdValue,
        createdAt,
      };
      return { ...complete, decisionId: decisionIdentity(complete) };
    });
    const workUnit: WorkUnitRecord = {
      workUnitId: workUnitIdValue,
      commandId,
      kind: draft.kind,
      authoredChangeIds: changes.map((value) => value.changeId),
      intentSummary: draft.intentSummary,
      externalSnapshot: draft.externalSnapshot ?? null,
      normalizationProtocol: NORMALIZATION_PROTOCOL,
      createdAt,
    };
    const plan: ApplicationPersistencePlan = {
      contextId: input.contextId,
      expectedWorkingHead: basis,
      workUnit,
      changes,
      application,
      appliedChanges,
      contentEdges,
      decisions,
      workspaceChangeSet,
      newRepositories: repoTransitions
        .filter((value) => value.newRepository)
        .map(({ repositoryId }) => ({ repositoryId })),
      newFiles: fileTransitions
        .filter((value) => value.newFile)
        .map((value) => ({
          fileId: value.fileId,
          repositoryId: value.result.presence === "placed" ? value.result.repositoryId : "",
          changeId: value.changeId,
        })),
    };
    const context = this.deps.store.applyApplication(plan);
    return {
      commandId,
      contextId: input.contextId,
      workUnitId: workUnitIdValue,
      applicationId: applicationIdValue,
      changeCount: changes.length,
      changeIds: changes.slice(0, 200).map((value) => value.changeId),
      incorporatedChangeCount: draft.incorporatedChangeIds.length,
      incorporatedChangeIds: draft.incorporatedChangeIds.slice(0, 200),
      workingHead: context.working.ref,
      decisionIds: decisions.map((value) => value.decisionId),
    };
  }

  private planWorkspaceFacts(
    basisRoot: string,
    files: readonly FileTransition[],
    repositories: readonly RepositoryTransition[]
  ): WorkspaceFactChangeSet {
    const repoById = new Map<string, RepositoryTransition>();
    for (const transition of repositories) repoById.set(transition.repositoryId, transition);
    const paths = new Map<
      string,
      Array<{ fileId: string; expectedPath: string | null; resultPath: string | null }>
    >();
    const ensureRepo = (repositoryId: string) => {
      if (!repoById.has(repositoryId)) {
        repoById.set(repositoryId, {
          repositoryId,
          expected: this.deps.store.facts.member(basisRoot, repositoryId),
          resultPath: undefined,
          changeId: null,
          tombstoneChangeId: null,
          newRepository: false,
        });
      }
    };
    for (const file of files) {
      let manifestExpected = file.expected?.presence === "placed" ? file.expected : null;
      if (
        manifestExpected === null &&
        file.expected?.presence === "deleted" &&
        file.result.presence === "placed"
      ) {
        const repositoryTransition = repoById.get(file.result.repositoryId);
        if (
          repositoryTransition?.expected?.presence === "deleted" &&
          repositoryTransition.resultPath !== null &&
          repositoryTransition.resultPath !== undefined
        ) {
          const priorFile = this.deps.store.facts.fileStateById(file.expected.priorFileStateId);
          const priorRepository = this.deps.store.facts.memberByStateId(
            repositoryTransition.expected.priorRepositoryStateId
          );
          if (
            priorFile?.presence === "placed" &&
            priorFile.repositoryId === file.result.repositoryId &&
            priorRepository?.presence === "present"
          ) {
            const entry = fileManifestEntryAt({
              manifest: this.deps.store.facts.manifest(priorRepository.fileManifestId),
              path: priorFile.path,
              readNode: (kind, route, nodeId, prefix) =>
                this.deps.store.facts.node(kind, route, nodeId, prefix),
            });
            if (entry?.fileId === file.fileId) manifestExpected = priorFile;
          }
        }
      }
      const placementUnchanged =
        manifestExpected !== null &&
        file.result.presence === "placed" &&
        manifestExpected.repositoryId === file.result.repositoryId &&
        manifestExpected.path === file.result.path;
      if (manifestExpected !== null && !placementUnchanged) {
        ensureRepo(manifestExpected.repositoryId);
        const values = paths.get(manifestExpected.repositoryId) ?? [];
        values.push({
          fileId: file.fileId,
          expectedPath: manifestExpected.path,
          resultPath:
            file.result.presence === "placed" &&
            file.result.repositoryId === manifestExpected.repositoryId
              ? file.result.path
              : null,
        });
        paths.set(manifestExpected.repositoryId, values);
      }
      if (
        file.result.presence === "placed" &&
        (manifestExpected === null || manifestExpected.repositoryId !== file.result.repositoryId)
      ) {
        ensureRepo(file.result.repositoryId);
        const values = paths.get(file.result.repositoryId) ?? [];
        values.push({ fileId: file.fileId, expectedPath: null, resultPath: file.result.path });
        paths.set(file.result.repositoryId, values);
      }
    }
    const transient = new Map<string, PersistentRadixNode>();
    const manifestUpdates: Array<WorkspaceFactChangeSet["manifestUpdates"][number]> = [];
    const repositoryUpdates: Array<WorkspaceFactChangeSet["repositoryUpdates"][number]> = [];
    for (const transition of [...repoById.values()].sort((a, b) =>
      compareUtf16CodeUnits(a.repositoryId, b.repositoryId)
    )) {
      const expected = transition.expected;
      const currentPath = expected?.presence === "present" ? expected.repoPath : null;
      const desiredPath = transition.resultPath === undefined ? currentPath : transition.resultPath;
      const pathUpdates = paths.get(transition.repositoryId) ?? [];
      const priorPresent =
        expected?.presence === "deleted"
          ? this.deps.store.facts.memberByStateId(expected.priorRepositoryStateId)
          : null;
      if (priorPresent && priorPresent.presence !== "present") {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Repository tombstone ${expected!.repositoryStateId} has no prior manifest`
        );
      }
      let fileManifestId =
        expected?.presence === "present"
          ? expected.fileManifestId
          : priorPresent?.presence === "present"
            ? priorPresent.fileManifestId
            : null;
      if (desiredPath !== null && (pathUpdates.length > 0 || fileManifestId === null)) {
        const empty = fileManifestId ? null : emptyFileManifest(transition.repositoryId);
        if (empty) transient.set(empty.node.nodeId, empty.node);
        const basis = fileManifestId
          ? this.deps.store.facts.manifest(fileManifestId)
          : empty!.manifest;
        const proof =
          pathUpdates.length === 0
            ? null
            : composeFileManifest({
                basis,
                updates: pathUpdates,
                readNode: (kind, route, nodeId, prefix) =>
                  transient.get(nodeId) ?? this.deps.store.facts.node(kind, route, nodeId, prefix),
              });
        proof?.createdNodes.forEach((node) => transient.set(node.nodeId, node));
        const resultManifest = proof?.resultManifest ?? basis;
        fileManifestId = resultManifest.fileManifestId;
        manifestUpdates.push({
          repositoryId: transition.repositoryId,
          expectedFileManifestId: expected?.presence === "present" ? expected.fileManifestId : null,
          resultManifest,
          pathUpdates: proof?.updates ?? [],
        });
      }
      const result = desiredPath
        ? workspaceRepositoryStateIdentity({
            repositoryId: transition.repositoryId,
            presence: "present",
            repoPath: desiredPath,
            fileManifestId: fileManifestId!,
          })
        : workspaceRepositoryStateIdentity({
            repositoryId: transition.repositoryId,
            presence: "deleted",
            priorRepositoryStateId: expected!.repositoryStateId,
            tombstoneChangeId: transition.tombstoneChangeId!,
          });
      repositoryUpdates.push({ repositoryId: transition.repositoryId, expected, result });
    }
    const planned = planWorkspaceFactChangeSet({
      basisWorkspaceFactRootId: basisRoot,
      repositoryUpdates,
      manifestUpdates,
      fileUpdates: files.map((file) => ({
        fileId: file.fileId,
        expected: file.expected,
        result: file.result,
      })),
    });
    if (planned.kind === "refused") {
      throw new SemanticVcsError("IntegrityFailure", planned.failure.message, {
        handles: planned.failure.handles,
      });
    }
    return planned.changeSet;
  }

  private queueMaterialization(
    contextId: string,
    commandId: string,
    previousState: StateNodeRef | null,
    targetState: StateNodeRef,
    blobs: readonly { contentHash: string; base64: string }[],
    draft?: MutationDraft,
    affectedRepositoryIds?: readonly string[]
  ): SemanticEffect {
    const command = this.buildMaterializationCommand(
      contextId,
      commandId,
      previousState === null ? "initialize" : "patch",
      previousState,
      targetState,
      blobs,
      draft,
      affectedRepositoryIds
    );
    return this.deps.store.queueEffect({
      scopeKind: "context",
      scopeId: contextId,
      commandId,
      kind: "materialize-context",
      effectId: command.materializationId,
      payloadDigest: command.payloadDigest,
      payload: command as unknown as Row,
    });
  }

  private buildMaterializationCommand(
    contextId: string,
    commandId: string,
    mode: ContextMaterializationCommand["mode"],
    previousState: StateNodeRef | null,
    targetState: StateNodeRef,
    blobs: readonly { contentHash: string; base64: string }[],
    draft?: MutationDraft,
    affectedRepositoryIds?: readonly string[]
  ): ContextMaterializationCommand {
    const root = this.deps.store.stateRoot(targetState);
    const previousRoot = previousState ? this.deps.store.stateRoot(previousState) : null;
    const repositories = this.contextMaterializationRepositories(
      root,
      previousRoot,
      draft,
      affectedRepositoryIds,
      mode !== "patch"
    );
    return contextMaterializationCommand({
      contextId,
      commandId,
      mode,
      previousState,
      targetState,
      repositories,
      blobs,
    });
  }

  private contextMaterializationRepositories(
    root: string,
    previousRoot: string | null,
    draft?: MutationDraft,
    explicitlyAffected?: readonly string[],
    fullReplacement = previousRoot === null
  ): WorkspaceMaterializationRepository[] {
    const repositoryIds = fullReplacement
      ? this.deps.store.facts.entries(root, "repository").map(({ key }) => key)
      : explicitlyAffected
        ? [...new Set(explicitlyAffected)]
        : draft
          ? this.materializationDraftRepositoryIds(draft)
          : [];
    return repositoryIds
      .sort(compareUtf16CodeUnits)
      .flatMap((key): WorkspaceMaterializationRepository[] => {
        const member = this.deps.store.facts.member(root, key);
        const previous = previousRoot ? this.deps.store.facts.member(previousRoot, key) : null;
        if (!member) {
          if (previousRoot !== null && previous?.presence === "present") {
            return [
              {
                repositoryId: key,
                presence: "deleted",
                repoPath: previous.repoPath,
              },
            ];
          }
          if (previousRoot !== null && previous?.presence === "deleted") return [];
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Materialization repository ${key} is absent from target facts`
          );
        }
        if (member.presence === "present") {
          const exactRoot = this.deps.store.materializedRepositoryContentRoot(root, key);
          if (exactRoot) {
            return [
              {
                repositoryId: key,
                presence: "present",
                repoPath: member.repoPath,
                fileManifestId: member.fileManifestId,
                source: { kind: "content-root", contentRoot: exactRoot },
              },
            ];
          }
          if (previous?.presence === "present" && previousRoot !== null && draft) {
            const basisRoot = this.deps.store.materializedRepositoryContentRoot(previousRoot, key);
            if (basisRoot) {
              const changes = this.materializationChanges(draft, key);
              if (changes.length === 0 && member.fileManifestId !== previous.fileManifestId) {
                throw new SemanticVcsError(
                  "IntegrityFailure",
                  `Repository ${key} changed manifest without file changes`
                );
              }
              return [
                {
                  repositoryId: key,
                  presence: "present",
                  repoPath: member.repoPath,
                  fileManifestId: member.fileManifestId,
                  source:
                    changes.length === 0
                      ? { kind: "content-root", contentRoot: basisRoot }
                      : { kind: "delta", basisContentRoot: basisRoot, changes },
                },
              ];
            }
          }
          return [
            {
              repositoryId: key,
              presence: "present",
              repoPath: member.repoPath,
              fileManifestId: member.fileManifestId,
              source: {
                kind: "snapshot",
                files: this.materializationSnapshotAt(root, member),
              },
            },
          ];
        }
        if (previousRoot === null) return [];
        return [
          {
            repositoryId: key,
            presence: "deleted",
            repoPath: this.lastRepositoryPath(member.priorRepositoryStateId),
          },
        ];
      });
  }

  private materializationDraftRepositoryIds(draft: MutationDraft): string[] {
    const repositoryIds = new Set(draft.repositoryResults.map(({ repositoryId }) => repositoryId));
    for (const file of draft.fileResults) {
      if (file.expected?.presence === "placed") repositoryIds.add(file.expected.repositoryId);
      if (file.result.presence === "placed") repositoryIds.add(file.result.repositoryId);
    }
    return [...repositoryIds];
  }

  private publicationRepositories(root: string): WorkspaceMaterializationRepository[] {
    return this.contextMaterializationRepositories(root, null);
  }

  private materializationChanges(
    draft: MutationDraft,
    repositoryId: string
  ): WorkspaceMaterializationChange[] {
    const changes = new Map<string, WorkspaceMaterializationChange>();
    for (const file of draft.fileResults) {
      if (file.expected?.presence === "placed" && file.expected.repositoryId === repositoryId) {
        changes.set(file.expected.path, {
          path: file.expected.path,
          expected: {
            contentHash: file.expected.contentHash,
            mode: file.expected.mode,
          },
          result: null,
        });
      }
      if (file.result.presence === "placed" && file.result.repositoryId === repositoryId) {
        const existing = changes.get(file.result.path);
        changes.set(file.result.path, {
          path: file.result.path,
          expected: existing?.expected ?? null,
          result: {
            contentHash: file.result.contentHash,
            mode: file.result.mode,
          },
        });
      }
    }
    return [...changes.values()]
      .filter((change) => canonicalJson(change.expected) !== canonicalJson(change.result))
      .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  }

  /** Exact, paged repository snapshot used only when no sparse host receipt is
   * available for a reusable target or delta basis. This keeps ordinary edits
   * incremental without multiplying receipt rows by every unaffected repo. */
  private materializationSnapshotAt(
    root: string,
    repository: PresentRepositoryState
  ): Array<{ path: string; contentHash: string; mode: number }> {
    const files: Array<{ path: string; contentHash: string; mode: number }> = [];
    let afterPath: string | undefined;
    do {
      const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
        ...(afterPath ? { afterPath } : {}),
        limit: 500,
      });
      for (const { fileId, path } of page.values) {
        const state = this.deps.store.facts.file(root, fileId)?.state;
        if (
          !state ||
          state.presence !== "placed" ||
          state.repositoryId !== repository.repositoryId ||
          state.path !== path
        ) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Manifest ${repository.fileManifestId} has no exact file state for ${fileId}`
          );
        }
        files.push({ path, contentHash: state.contentHash, mode: state.mode });
      }
      afterPath = page.next ?? undefined;
    } while (afterPath !== undefined);
    return files;
  }

  private lastRepositoryPath(repositoryStateId: string): string {
    const row = this.deps.sql
      .exec(
        `WITH RECURSIVE history(repository_state_id, presence, repo_path,
                                prior_repository_state_id, depth) AS (
           SELECT repository_state_id, presence, repo_path,
                  prior_repository_state_id, 0
             FROM vcs_repository_states WHERE repository_state_id = ?
           UNION ALL
           SELECT prior.repository_state_id, prior.presence, prior.repo_path,
                  prior.prior_repository_state_id, history.depth + 1
             FROM history
             JOIN vcs_repository_states prior
               ON prior.repository_state_id = history.prior_repository_state_id
            WHERE history.depth < ?
         )
         SELECT repo_path FROM history
          WHERE presence = 'present' ORDER BY depth LIMIT 1`,
        repositoryStateId,
        MAX_WORKING_APPLICATIONS
      )
      .toArray()[0] as Row | undefined;
    if (!row || typeof row["repo_path"] !== "string") {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Deleted repository state ${repositoryStateId} has no prior path`
      );
    }
    return row["repo_path"];
  }

  private presentRepository(root: string, repositoryId: string) {
    const repository = this.deps.store.facts.member(root, repositoryId);
    if (!repository || repository.presence !== "present") {
      throw new SemanticVcsError("InvalidReference", `Unknown repository ${repositoryId}`);
    }
    return repository;
  }

  private filesInRepositoryState(
    root: string,
    repository: PresentRepositoryState
  ): PlacedFileState[] {
    const page = this.deps.store.facts.pageManifest(repository.fileManifestId, {
      limit: 100_000,
    });
    if (page.next !== null) {
      throw new SemanticVcsError(
        "ScopeTooLarge",
        `Repository ${repository.repositoryId} exceeds the exact revert bound`
      );
    }
    return page.values.map(({ fileId, path }) => {
      const observed = this.deps.store.facts.file(root, fileId)?.state;
      const state =
        observed?.presence === "deleted"
          ? this.deps.store.facts.fileStateById(observed.priorFileStateId)
          : observed;
      if (
        !state ||
        state.presence !== "placed" ||
        state.repositoryId !== repository.repositoryId ||
        state.path !== path
      ) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Manifest ${repository.fileManifestId} has no exact file state for ${fileId}`
        );
      }
      return state;
    });
  }

  private placedFile(root: string, repositoryId: string, fileId: string) {
    const point = this.deps.store.facts.file(root, fileId);
    if (
      !point ||
      point.state.presence !== "placed" ||
      point.state.repositoryId !== repositoryId ||
      point.repository.presence !== "present"
    ) {
      throw new SemanticVcsError("InvalidReference", `Unknown file ${fileId}`);
    }
    return { state: point.state, repository: point.repository };
  }

  private changeRequired(changeId: string): ChangeRecord {
    const row = this.deps.sql
      .exec(`SELECT * FROM gad_changes WHERE change_id = ?`, changeId)
      .toArray()[0] as Row | undefined;
    if (!row) throw new SemanticVcsError("InvalidReference", `Unknown change ${changeId}`);
    return {
      changeId,
      workUnitId: String(row["work_unit_id"]),
      operation: Number(row["operation"]),
      ordinal: Number(row["ordinal"]),
      kind: String(row["kind"]),
      source:
        row["source_json"] == null
          ? null
          : (JSON.parse(String(row["source_json"])) as AuthoredCopySourceEndpoint),
      base: row["base_json"] == null ? null : JSON.parse(String(row["base_json"])),
      result: row["result_json"] == null ? null : JSON.parse(String(row["result_json"])),
      payload: JSON.parse(String(row["payload_json"])),
      effectDigest: String(row["effect_digest"]),
    };
  }

  private publicChange(change: ChangeRecord): Row {
    const counteracts = change.payload["counteractsChangeIds"];
    return {
      changeId: change.changeId,
      authoredByWorkUnitId: change.workUnitId,
      operation: change.operation,
      kind: publicChangeKind(change.kind),
      effects: changeEffects(change),
      counteractsChangeIds: Array.isArray(counteracts)
        ? counteracts.filter((value): value is string => typeof value === "string")
        : [],
      effectDigest: change.effectDigest,
      normalizationProtocol: NORMALIZATION_PROTOCOL,
    };
  }

  private publicDecision(row: Row): Row {
    const decisionId = String(row["decision_id"]);
    const ids = (sql: string, ...params: unknown[]): string[] =>
      (this.deps.sql.exec(sql, ...params).toArray() as Row[]).map((value) => String(value["id"]));
    const sourceChangeIds = ids(
      `SELECT change_id AS id
         FROM gad_decision_source_changes
        WHERE decision_id = ? ORDER BY change_id`,
      decisionId
    );
    const base = {
      decisionId,
      sourceState: { kind: "event", eventId: String(row["source_event_id"]) },
      targetBasis:
        row["target_state_kind"] === "event"
          ? { kind: "event", eventId: String(row["target_state_id"]) }
          : { kind: "application", applicationId: String(row["target_state_id"]) },
      sourceChangeIds,
    };
    if (row["kind"] === "adopted") {
      return {
        kind: "adopted",
        ...base,
        resultAppliedChangeIds: ids(
          `SELECT applied.applied_change_id AS id
             FROM gad_work_unit_applications application
             JOIN gad_applied_changes applied
               ON applied.application_id = application.application_id
            WHERE application.work_unit_id = ?
            ORDER BY applied.ordinal, applied.applied_change_id`,
          String(row["work_unit_id"])
        ),
      };
    }
    if (row["kind"] === "reconciled") {
      return {
        kind: "reconciled",
        ...base,
        evidence: JSON.parse(String(row["evidence_predicates_json"])),
        rationale: String(row["rationale"]),
      };
    }
    return { kind: "declined", ...base, rationale: String(row["rationale"]) };
  }

  /** One bounded first-parent view powers comparison, decision admission,
   * integration commits, and publication revalidation. Second parents carry
   * ancestry/story only; content enters this view solely through applications
   * on the first-parent line. */
  private integrationComparison(
    targetState: StateNodeRef,
    sourceEventId: string
  ): IntegrationComparison {
    if (!this.deps.store.event(sourceEventId)) {
      throw new SemanticVcsError("InvalidReference", `Unknown event ${sourceEventId}`);
    }
    const target = this.firstParentLineage(targetState);
    const targetEvents = new Set(target.eventIds);
    const sourceStoryReverse: string[] = [];
    let current: string | null = sourceEventId;
    while (current) {
      if (targetEvents.has(current)) {
        break;
      }
      if (sourceStoryReverse.length >= MAX_ANCESTRY_EDGES) {
        throw new SemanticVcsError(
          "ScopeTooLarge",
          "Integration comparison exceeds its event bound",
          {
            maximum: MAX_ANCESTRY_EDGES,
          }
        );
      }
      sourceStoryReverse.push(current);
      const event = this.deps.store.event(current);
      if (!event) {
        throw new SemanticVcsError("IntegrityFailure", `Missing source event ${current}`);
      }
      current = event.parentEventIds[0] ?? null;
    }
    const sourceEventIds = sourceStoryReverse.reverse();
    const sourceApplicationIds = sourceEventIds.flatMap(
      (eventId) => this.deps.store.event(eventId)?.applicationIds ?? []
    );
    const sourceChanges = this.changesInApplications(sourceApplicationIds);
    const targetChanges = this.changesInApplications(target.applicationIds);
    const sourceActiveChangeIds = this.activeChangeIds(sourceChanges);
    const targetActiveChangeIds = this.activeChangeIds(targetChanges);
    const targetCounteractions = new Set(
      targetChanges
        .filter((change) => targetActiveChangeIds.has(change.changeId))
        .flatMap((change) => this.counteractedChangeIds(change))
    );
    const decisions = this.reachableDecisionsBySourceChange(target.applicationIds);
    const changes = sourceChanges.map((change): ComparedSourceChange => {
      let disposition: ComparedDisposition;
      const counteracts = this.counteractedChangeIds(change);
      if (
        !sourceActiveChangeIds.has(change.changeId) ||
        targetCounteractions.has(change.changeId)
      ) {
        disposition = { status: "historical" };
      } else if (targetActiveChangeIds.has(change.changeId)) {
        disposition = { status: "shared" };
      } else if ((decisions.get(change.changeId)?.length ?? 0) > 0) {
        disposition = {
          status: "accounted",
          decisionIds: decisions.get(change.changeId)!,
        };
      } else if (
        counteracts.length > 0 &&
        !counteracts.some((changeId) => targetActiveChangeIds.has(changeId))
      ) {
        disposition = { status: "historical" };
      } else {
        const evidence = this.resultEvidence(change).filter((predicate) =>
          this.predicateHolds(targetState, predicate)
        );
        if (this.changeResultHolds(targetState, change) && evidence.length > 0) {
          disposition = { status: "already-satisfied", evidence };
        } else {
          disposition = {
            status: "actionable",
            applicability: "applicable",
          };
        }
      }
      return { change, disposition };
    });
    const prior: ComparedSourceChange[] = [];
    for (const entry of changes) {
      if (entry.disposition.status === "actionable") {
        const unmet = this.changePrerequisites(entry.change).filter(
          (condition) => !this.prerequisiteHolds(targetState, condition)
        );
        const prerequisiteChangeIds: string[] = [];
        let unresolved = false;
        for (const condition of unmet) {
          const prerequisite = [...prior]
            .reverse()
            .find((candidate) => this.changeEstablishes(candidate.change, condition));
          if (prerequisite?.disposition.status === "actionable") {
            prerequisiteChangeIds.push(prerequisite.change.changeId);
          } else {
            unresolved = true;
          }
        }
        if (unmet.length === 0) {
          entry.disposition = { status: "actionable", applicability: "applicable" };
        } else if (!unresolved && prerequisiteChangeIds.length > 0) {
          entry.disposition = {
            status: "actionable",
            applicability: "blocked",
            prerequisiteChangeIds: [...new Set(prerequisiteChangeIds)].sort(compareUtf16CodeUnits),
          };
        } else {
          entry.disposition = { status: "actionable", applicability: "conflicting" };
        }
      }
      prior.push(entry);
    }
    return {
      targetState,
      sourceEventId,
      changes,
      unaccountedChangeIds: changes
        .filter(
          ({ disposition }) =>
            disposition.status === "actionable" || disposition.status === "already-satisfied"
        )
        .map(({ change }) => change.changeId),
    };
  }

  private assertIntegrationHistoryValid(mainEventId: string, publishedEventId: string): void {
    const stack = [publishedEventId];
    const seen = new Set<string>();
    let traversedEdges = 0;
    while (stack.length > 0) {
      const eventId = stack.pop()!;
      if (seen.has(eventId) || eventId === mainEventId) continue;
      seen.add(eventId);
      const event = this.deps.store.event(eventId);
      if (!event) throw new SemanticVcsError("IntegrityFailure", `Missing event ${eventId}`);
      if (event.kind === "integration-commit") {
        const sourceEventId = event.parentEventIds[1];
        if (!sourceEventId) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Integration event ${eventId} has no source parent`
          );
        }
        const comparison = this.integrationComparison({ kind: "event", eventId }, sourceEventId);
        if (comparison.unaccountedChangeIds.length > 0) {
          throw new SemanticVcsError(
            "IntegrationIncomplete",
            `Integration event ${eventId} no longer validates`,
            {
              sourceEventId,
              unaccountedChangeIds: comparison.unaccountedChangeIds,
            }
          );
        }
      }
      traversedEdges += event.parentEventIds.length;
      if (traversedEdges > MAX_ANCESTRY_EDGES) {
        throw new SemanticVcsError("ScopeTooLarge", "Publication history exceeds its edge bound", {
          maximum: MAX_ANCESTRY_EDGES,
        });
      }
      stack.push(...event.parentEventIds);
    }
  }

  private firstParentLineage(state: StateNodeRef): {
    eventIds: string[];
    workingApplicationIds: string[];
    applicationIds: string[];
  } {
    const workingApplicationIds =
      state.kind === "application"
        ? readApplicationChain(this.deps.sql, state.applicationId, MAX_WORKING_APPLICATIONS)
        : [];
    let eventId = state.kind === "event" ? state.eventId : null;
    if (!eventId) {
      const first = workingApplicationIds[0];
      const basis = first
        ? (this.deps.sql
            .exec(
              `SELECT basis_kind, basis_id FROM gad_work_unit_applications
                WHERE application_id = ?`,
              first
            )
            .toArray()[0] as Row | undefined)
        : undefined;
      if (!basis || basis["basis_kind"] !== "event") {
        throw new SemanticVcsError("IntegrityFailure", "Working chain has no event basis");
      }
      eventId = String(basis["basis_id"]);
    }
    const reverse: string[] = [];
    while (eventId) {
      if (reverse.length >= MAX_ANCESTRY_EDGES) {
        throw new SemanticVcsError("ScopeTooLarge", "First-parent history exceeds its bound", {
          maximum: MAX_ANCESTRY_EDGES,
        });
      }
      const event = this.deps.store.event(eventId);
      if (!event) throw new SemanticVcsError("IntegrityFailure", `Missing event ${eventId}`);
      reverse.push(eventId);
      eventId = event.parentEventIds[0] ?? null;
    }
    const eventIds = reverse.reverse();
    const applicationIds = [
      ...eventIds.flatMap((id) => this.deps.store.event(id)?.applicationIds ?? []),
      ...workingApplicationIds,
    ];
    if (applicationIds.length > MAX_WORKING_APPLICATIONS) {
      throw new SemanticVcsError("ScopeTooLarge", "State history exceeds its application bound", {
        maximum: MAX_WORKING_APPLICATIONS,
      });
    }
    return { eventIds, workingApplicationIds, applicationIds };
  }

  private changesInApplications(applicationIds: readonly string[]): ChangeRecord[] {
    if (applicationIds.length === 0) return [];
    const rows = this.deps.sql
      .exec(
        `SELECT change.change_id
           FROM json_each(?) selected
           JOIN gad_applied_changes applied
             ON applied.application_id = CAST(selected.value AS TEXT)
           JOIN gad_changes change ON change.change_id = applied.change_id
          ORDER BY CAST(selected.key AS INTEGER), applied.ordinal, change.change_id`,
        canonicalJson(applicationIds)
      )
      .toArray() as Row[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const changeId = String(row["change_id"]);
      if (seen.has(changeId)) return [];
      seen.add(changeId);
      return [this.changeRequired(changeId)];
    });
  }

  private reachableDecisionsBySourceChange(
    applicationIds: readonly string[]
  ): Map<string, string[]> {
    if (applicationIds.length === 0) return new Map();
    const rows = this.deps.sql
      .exec(
        `SELECT source.change_id, decision.decision_id
           FROM gad_integration_decisions decision
           JOIN gad_decision_source_changes source
             ON source.decision_id = decision.decision_id
          WHERE decision.work_unit_id IN (
            SELECT application.work_unit_id
              FROM gad_work_unit_applications application
              JOIN json_each(?) selected
                ON application.application_id = CAST(selected.value AS TEXT)
          )
          ORDER BY source.change_id, decision.decision_id`,
        canonicalJson(applicationIds)
      )
      .toArray() as Row[];
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const changeId = String(row["change_id"]);
      result.set(changeId, [...(result.get(changeId) ?? []), String(row["decision_id"])]);
    }
    return result;
  }

  private decisionIdsInApplications(applicationIds: readonly string[]): string[] {
    if (applicationIds.length === 0) return [];
    return (
      this.deps.sql
        .exec(
          `SELECT DISTINCT decision.decision_id
             FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications application
               ON application.work_unit_id = decision.work_unit_id
             JOIN json_each(?) selected
               ON application.application_id = CAST(selected.value AS TEXT)
            ORDER BY decision.decision_id`,
          canonicalJson(applicationIds)
        )
        .toArray() as Row[]
    ).map((row) => String(row["decision_id"]));
  }

  private integrationSourceEventIds(applicationIds: readonly string[]): string[] {
    if (applicationIds.length === 0) return [];
    return (
      this.deps.sql
        .exec(
          `SELECT DISTINCT decision.source_event_id
             FROM gad_integration_decisions decision
             JOIN gad_work_unit_applications application
               ON application.work_unit_id = decision.work_unit_id
             JOIN json_each(?) selected
               ON application.application_id = CAST(selected.value AS TEXT)
            ORDER BY decision.source_event_id`,
          canonicalJson(applicationIds)
        )
        .toArray() as Row[]
    ).map((row) => String(row["source_event_id"]));
  }

  private counteractedChangeIds(change: ChangeRecord): string[] {
    const values = change.payload["counteractsChangeIds"];
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === "string")
      : [];
  }

  /** Derive the live semantic changes at one exact first-parent state.
   *
   * Counteractions are ordinary changes and can themselves be counteracted.
   * Walking backwards means only a counteraction that is still live suppresses
   * its targets. This is deliberately a projection over the application chain,
   * never a stored dependency/counteraction closure. */
  private activeChangeIds(changes: readonly ChangeRecord[]): Set<string> {
    const active = new Set<string>();
    const suppressed = new Set<string>();
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index]!;
      if (suppressed.has(change.changeId)) continue;
      active.add(change.changeId);
      for (const counteractedId of this.counteractedChangeIds(change)) {
        suppressed.add(counteractedId);
      }
    }
    return active;
  }

  private changeCoordinate(change: ChangeRecord): string | null {
    const endpoint = change.result ?? change.base;
    if (typeof endpoint?.["fileId"] === "string") return `file:${endpoint["fileId"]}`;
    if (typeof endpoint?.["repositoryId"] === "string") {
      return `repository:${endpoint["repositoryId"]}`;
    }
    return null;
  }

  private changeResultHolds(state: StateNodeRef, change: ChangeRecord): boolean {
    return !!change.result && this.endpointHolds(state, change.result);
  }

  private changePrerequisites(change: ChangeRecord): ChangePrerequisite[] {
    const prerequisites: ChangePrerequisite[] = [];
    // A copy's base names the provenance source, not a target predecessor.
    // Every other base is the exact state the target coordinate must still have.
    if (change.base && change.kind !== "file-copy") {
      prerequisites.push({ kind: "endpoint", endpoint: change.base });
    }
    const result = change.result;
    if (result?.["kind"] === "file" && typeof result["fileId"] === "string") {
      const repositoryId = String(result["repositoryId"] ?? "");
      const path = String(result["path"] ?? "");
      if (repositoryId) {
        prerequisites.push({ kind: "repository-present", repositoryId });
      }
      if (
        path &&
        (!change.base ||
          change.base["kind"] !== "file" ||
          change.base["repositoryId"] !== repositoryId ||
          change.base["path"] !== path)
      ) {
        prerequisites.push({
          kind: "file-path-empty",
          repositoryId,
          path,
          exceptFileId: result["fileId"],
        });
      }
    }
    if (
      result?.["kind"] === "repository" &&
      typeof result["repositoryId"] === "string" &&
      typeof result["repoPath"] === "string" &&
      (!change.base || change.base["repoPath"] !== result["repoPath"])
    ) {
      prerequisites.push({
        kind: "repository-path-empty",
        repoPath: result["repoPath"],
        exceptRepositoryId: result["repositoryId"],
      });
    }
    return prerequisites;
  }

  private prerequisiteHolds(state: StateNodeRef, condition: ChangePrerequisite): boolean {
    if (condition.kind === "endpoint") return this.endpointHolds(state, condition.endpoint);
    const root = this.deps.store.stateRoot(state);
    if (condition.kind === "repository-present") {
      return this.deps.store.facts.member(root, condition.repositoryId)?.presence === "present";
    }
    if (condition.kind === "file-path-empty") {
      const point = this.deps.store.facts.fileAtPath(root, condition.repositoryId, condition.path);
      return !point || point.state.fileId === condition.exceptFileId;
    }
    const member = this.deps.store.facts.repositoryAtPath(root, condition.repoPath);
    return !member || member.repositoryId === condition.exceptRepositoryId;
  }

  private changeEstablishes(change: ChangeRecord, condition: ChangePrerequisite): boolean {
    if (condition.kind === "endpoint") {
      return !!change.result && canonicalJson(change.result) === canonicalJson(condition.endpoint);
    }
    if (condition.kind === "repository-present") {
      return (
        change.result?.["kind"] === "repository" &&
        change.result["repositoryId"] === condition.repositoryId &&
        change.result["presence"] !== "deleted"
      );
    }
    if (condition.kind === "file-path-empty") {
      return (
        change.base?.["kind"] === "file" &&
        change.base["repositoryId"] === condition.repositoryId &&
        change.base["path"] === condition.path &&
        (change.result?.["kind"] !== "file" ||
          change.result["repositoryId"] !== condition.repositoryId ||
          change.result["path"] !== condition.path)
      );
    }
    return (
      change.base?.["kind"] === "repository" &&
      change.base["repoPath"] === condition.repoPath &&
      (change.result?.["kind"] !== "repository" ||
        change.result["presence"] === "deleted" ||
        change.result["repoPath"] !== condition.repoPath)
    );
  }

  private revertBlockingChangeIds(state: StateNodeRef, original: ChangeRecord): string[] {
    const changes = this.changesInApplications(this.firstParentLineage(state).applicationIds);
    const originalIndex = changes.findIndex((change) => change.changeId === original.changeId);
    const coordinate = this.changeCoordinate(original);
    if (originalIndex < 0 || !coordinate) return [];
    return changes
      .slice(originalIndex + 1)
      .filter(
        (change) =>
          this.changeCoordinate(change) === coordinate && this.changeResultHolds(state, change)
      )
      .map((change) => change.changeId)
      .sort(compareUtf16CodeUnits);
  }

  private endpointHolds(state: StateNodeRef, endpoint: Row): boolean {
    const root = this.deps.store.stateRoot(state);
    if (endpoint["kind"] === "file" && typeof endpoint["fileId"] === "string") {
      const point = this.deps.store.facts.file(root, endpoint["fileId"]);
      if (!point || point.state.presence !== "placed") return false;
      const expected = endpoint;
      const repository = this.deps.store.facts.member(root, point.state.repositoryId);
      return (
        repository?.presence === "present" &&
        point.state.repositoryId === expected["repositoryId"] &&
        point.state.path === expected["path"] &&
        point.state.contentHash === expected["contentHash"] &&
        point.state.mode === expected["mode"] &&
        point.state.contentKind === expected["contentKind"] &&
        point.state.byteLength === expected["byteLength"] &&
        point.state.coordinateExtent === expected["coordinateExtent"]
      );
    }
    if (endpoint["kind"] === "missing" && typeof endpoint["fileId"] === "string") {
      const point = this.deps.store.facts.file(root, endpoint["fileId"]);
      return !point || point.state.presence === "deleted";
    }
    if (endpoint["kind"] === "repository" && typeof endpoint["repositoryId"] === "string") {
      const member = this.deps.store.facts.member(root, endpoint["repositoryId"]);
      if (endpoint["presence"] === "deleted") return !member || member.presence === "deleted";
      return (
        member?.presence === "present" &&
        (typeof endpoint["repoPath"] !== "string" || member.repoPath === endpoint["repoPath"])
      );
    }
    return false;
  }

  private resultEvidence(change: ChangeRecord): StatePredicateRecord[] {
    const result = change.result;
    if (!result) return [];
    if (result["kind"] === "file" && typeof result["fileId"] === "string") {
      return typeof result["contentHash"] === "string"
        ? [
            {
              kind: "file-content",
              fileId: result["fileId"],
              contentHash: result["contentHash"],
            },
          ]
        : [];
    }
    if (result["kind"] === "missing" && typeof result["fileId"] === "string") {
      return [{ kind: "file-absent", fileId: result["fileId"] }];
    }
    if (result["kind"] === "repository" && typeof result["repositoryId"] === "string") {
      return result["presence"] === "deleted"
        ? [{ kind: "repository-absent", repositoryId: result["repositoryId"] }]
        : typeof result["repoPath"] === "string"
          ? [
              {
                kind: "repository-present",
                repositoryId: result["repositoryId"],
                repoPath: result["repoPath"],
              },
            ]
          : [];
    }
    return [];
  }

  private assertChangeReachableFromEvent(changeId: string, eventId: string): void {
    const row = this.deps.sql
      .exec(
        `SELECT 1 FROM gad_workspace_event_applications event_application
          JOIN gad_applied_changes applied ON applied.application_id = event_application.application_id
         WHERE event_application.event_id = ? AND applied.change_id = ? LIMIT 1`,
        eventId,
        changeId
      )
      .toArray();
    if (row.length === 0) {
      throw new SemanticVcsError(
        "InvalidReference",
        `Change ${changeId} is not in event ${eventId}`
      );
    }
  }

  private changesAtEvent(eventId: string): ChangeRecord[] {
    if (!this.deps.store.event(eventId))
      throw new SemanticVcsError("InvalidReference", `Unknown event ${eventId}`);
    const rows = this.deps.sql
      .exec(
        `SELECT DISTINCT change_id FROM gad_applied_changes
          WHERE application_id IN (
            SELECT application_id FROM gad_workspace_event_applications WHERE event_id = ?
          ) ORDER BY change_id`,
        eventId
      )
      .toArray() as Row[];
    return rows.map((row) => this.changeRequired(String(row["change_id"])));
  }

  private changesAtState(state: StateNodeRef): Set<string> {
    if (state.kind === "event")
      return new Set(this.changesAtEvent(state.eventId).map((value) => value.changeId));
    const chain = readApplicationChain(
      this.deps.sql,
      state.applicationId,
      MAX_WORKING_APPLICATIONS
    );
    return new Set(
      (
        this.deps.sql
          .exec(
            `SELECT DISTINCT change_id FROM gad_applied_changes
            WHERE application_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
            canonicalJson(chain)
          )
          .toArray() as Row[]
      ).map((row) => String(row["change_id"]))
    );
  }

  private predicateHolds(state: StateNodeRef, predicate: StatePredicateRecord): boolean {
    const root = this.deps.store.stateRoot(state);
    const fileId = typeof predicate["fileId"] === "string" ? predicate["fileId"] : null;
    const file = fileId ? this.deps.store.facts.file(root, fileId) : null;
    switch (predicate.kind) {
      case "file-content":
        return (
          file?.state.presence === "placed" && file.state.contentHash === predicate["contentHash"]
        );
      case "file-placement":
        return (
          file?.state.presence === "placed" &&
          file.state.repositoryId === predicate["repositoryId"] &&
          file.state.path === predicate["path"]
        );
      case "file-absent":
        return !file || file.state.presence === "deleted";
      case "repository-present": {
        const repository = this.deps.store.facts.member(root, String(predicate["repositoryId"]));
        return repository?.presence === "present" && repository.repoPath === predicate["repoPath"];
      }
      case "repository-absent": {
        const repository = this.deps.store.facts.member(root, String(predicate["repositoryId"]));
        return !repository || repository.presence === "deleted";
      }
      default:
        return false;
    }
  }

  private publicAppliedChange(row: Row): Row {
    const appliedChangeId = String(row["applied_change_id"]);
    const change = this.changeRequired(String(row["change_id"]));
    const predicates = this.deps.sql
      .exec(
        `SELECT predicate_json FROM gad_applied_change_predicates
          WHERE applied_change_id = ? ORDER BY ordinal`,
        appliedChangeId
      )
      .toArray() as Row[];
    return {
      appliedChangeId,
      applicationId: String(row["application_id"]),
      changeId: change.changeId,
      ordinal: Number(row["ordinal"]),
      appliedEffects: changeEffects({
        ...change,
        base:
          row["applied_base_json"] == null
            ? null
            : (JSON.parse(String(row["applied_base_json"])) as Row),
        result:
          row["applied_result_json"] == null
            ? null
            : (JSON.parse(String(row["applied_result_json"])) as Row),
      }),
      resultPredicate:
        predicates.length === 0
          ? null
          : (JSON.parse(String(predicates[0]!["predicate_json"])) as Row),
    };
  }

  private inspectNode(node: Row): Row {
    switch (node["kind"]) {
      case "event": {
        const event = this.deps.store.event(String(node["eventId"]));
        if (!event) throw new SemanticVcsError("InvalidReference", "Unknown event");
        return {
          kind: "event",
          value: {
            eventId: event.eventId,
            workspaceId: this.deps.workspaceId,
            commandId: event.commandId,
            kind: event.kind,
            workspaceFactRootId: event.resultWorkspaceFactRootId,
            parentEventIds: event.parentEventIds,
            applicationIds: event.applicationIds,
            decisionIds: this.decisionIdsInApplications(event.applicationIds),
            message: event.message,
            semanticProtocol: SEMANTIC_PROTOCOL,
            createdAt: event.createdAt,
          },
        };
      }
      case "application": {
        const application = this.deps.store.application(String(node["applicationId"]));
        if (!application) throw new SemanticVcsError("InvalidReference", "Unknown application");
        const appliedChanges = (
          this.deps.sql
            .exec(
              `SELECT * FROM gad_applied_changes
                WHERE application_id = ? ORDER BY ordinal LIMIT 200`,
              application.applicationId
            )
            .toArray() as Row[]
        ).map((row) => this.publicAppliedChange(row));
        return {
          kind: "application",
          value: {
            applicationId: application.applicationId,
            workUnitId: application.workUnitId,
            basis: application.basis,
            appliedChangeCount: application.appliedChangeIds.length,
            appliedChanges,
            resultWorkspaceFactRootId: application.resultWorkspaceFactRootId,
            semanticProtocol: application.semanticProtocol,
          },
        };
      }
      case "applied-change": {
        const row = this.deps.sql
          .exec(
            `SELECT * FROM gad_applied_changes WHERE applied_change_id = ?`,
            String(node["appliedChangeId"])
          )
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown applied change");
        return { kind: "applied-change", value: this.publicAppliedChange(row) };
      }
      case "change":
        return {
          kind: "change",
          value: this.publicChange(this.changeRequired(String(node["changeId"]))),
        };
      case "work-unit": {
        const row = this.deps.sql
          .exec(`SELECT * FROM gad_work_units WHERE work_unit_id = ?`, String(node["workUnitId"]))
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown work unit");
        const workUnitId = String(row["work_unit_id"]);
        const ids = (sql: string): string[] =>
          (this.deps.sql.exec(sql, workUnitId).toArray() as Row[]).map((value) =>
            String(value["id"])
          );
        const count = (table: string): number =>
          Number(
            (
              this.deps.sql
                .exec(`SELECT COUNT(*) AS count FROM ${table} WHERE work_unit_id = ?`, workUnitId)
                .toArray()[0] as Row
            )["count"]
          );
        const storedExternalSnapshot =
          row["external_snapshot_json"] == null
            ? null
            : (JSON.parse(String(row["external_snapshot_json"])) as Row);
        const targetRepositoryIds = Array.isArray(storedExternalSnapshot?.["targetRepositoryIds"])
          ? storedExternalSnapshot["targetRepositoryIds"].filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        return {
          kind: "work-unit",
          value: {
            workUnitId,
            commandId: String(row["command_id"]),
            kind: String(row["kind"]),
            authoredChangeCount: count("gad_changes"),
            authoredChangeIds: ids(
              `SELECT change_id AS id FROM gad_changes
                WHERE work_unit_id = ? ORDER BY operation, ordinal LIMIT 200`
            ),
            incorporatedChangeCount: Number(
              (
                this.deps.sql
                  .exec(
                    `SELECT COUNT(*) AS count
                       FROM gad_integration_decisions decision
                       JOIN gad_decision_source_changes source
                         ON source.decision_id = decision.decision_id
                      WHERE decision.work_unit_id = ?`,
                    workUnitId
                  )
                  .toArray()[0] as Row
              )["count"]
            ),
            incorporatedChangeIds: ids(
              `SELECT source.change_id AS id
                 FROM gad_integration_decisions decision
                 JOIN gad_decision_source_changes source
                   ON source.decision_id = decision.decision_id
                WHERE decision.work_unit_id = ?
                ORDER BY source.change_id LIMIT 200`
            ),
            decisionCount: count("gad_integration_decisions"),
            decisionIds: ids(
              `SELECT decision_id AS id FROM gad_integration_decisions
                WHERE work_unit_id = ? ORDER BY created_at, decision_id LIMIT 200`
            ),
            intentSummary: row["intent_summary"] == null ? null : String(row["intent_summary"]),
            externalSnapshot:
              storedExternalSnapshot == null
                ? null
                : {
                    sourceKind: storedExternalSnapshot["sourceKind"],
                    sourceUri: storedExternalSnapshot["sourceUri"],
                    snapshotRevision: storedExternalSnapshot["snapshotRevision"],
                    snapshotDigest: storedExternalSnapshot["snapshotDigest"],
                    targetRepositoryIds,
                  },
            normalizationProtocol: String(row["normalization_protocol"]),
            createdAt: String(row["created_at"]),
          },
        };
      }
      case "decision": {
        const row = this.deps.sql
          .exec(
            `SELECT * FROM gad_integration_decisions WHERE decision_id = ?`,
            String(node["decisionId"])
          )
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown decision");
        return { kind: "decision", value: this.publicDecision(row) };
      }
      case "command": {
        const row = this.deps.sql
          .exec(
            `SELECT * FROM vcs_command_journal WHERE command_id = ? LIMIT 2`,
            String(node["commandId"])
          )
          .toArray()[0] as Row | undefined;
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown command");
        const result = row["result_json"] == null ? null : JSON.parse(String(row["result_json"]));
        const resultNode =
          result && typeof result === "object" && typeof result["workUnitId"] === "string"
            ? { kind: "work-unit", workUnitId: result["workUnitId"] }
            : result && typeof result === "object" && typeof result["eventId"] === "string"
              ? { kind: "event", eventId: result["eventId"] }
              : null;
        return {
          kind: "command",
          value: {
            commandId: String(row["command_id"]),
            workspaceId: this.deps.workspaceId,
            contextId: row["scope_kind"] === "context" ? String(row["scope_id"]) : null,
            method: String(row["method"]),
            status:
              row["status"] === "pending"
                ? "applying"
                : row["status"] === "effect-pending"
                  ? "effect-pending"
                  : row["status"],
            result: resultNode,
            createdAt: String(row["created_at"]),
            completedAt: row["completed_at"] == null ? null : String(row["completed_at"]),
          },
        };
      }
      case "file": {
        const state = node["state"] as StateNodeRef;
        const point = this.deps.store.facts.file(
          this.deps.store.stateRoot(state),
          String(node["fileId"])
        );
        if (!point) throw new SemanticVcsError("InvalidReference", "Unknown file");
        return {
          kind: "file",
          state,
          value:
            point.state.presence === "placed"
              ? {
                  kind: "placed",
                  fileId: point.state.fileId,
                  repositoryId: point.state.repositoryId,
                  path: point.state.path,
                  contentHash: point.state.contentHash,
                  mode: point.state.mode,
                  contentKind: point.state.contentKind,
                  byteLength: point.state.byteLength,
                  coordinateExtent: point.state.coordinateExtent,
                }
              : {
                  kind: "tombstone",
                  fileId: point.state.fileId,
                  priorPlacedStateId: point.state.priorFileStateId,
                  tombstoneChangeId: point.state.tombstoneChangeId,
                },
        };
      }
      case "repository": {
        const state = node["state"] as StateNodeRef;
        const value = this.deps.store.facts.member(
          this.deps.store.stateRoot(state),
          String(node["repositoryId"])
        );
        if (!value) throw new SemanticVcsError("InvalidReference", "Unknown repository");
        return {
          kind: "repository",
          state,
          value:
            value.presence === "present"
              ? {
                  kind: "present",
                  repositoryId: value.repositoryId,
                  repoPath: value.repoPath,
                  manifestId: value.fileManifestId,
                }
              : {
                  kind: "tombstone",
                  repositoryId: value.repositoryId,
                  priorPresentStateId: value.priorRepositoryStateId,
                  tombstoneChangeId: value.tombstoneChangeId,
                },
        };
      }
      case "trajectory":
        return { kind: "trajectory", value: node };
      case "trajectory-invocation": {
        const row = this.deps.sql
          .exec(
            `SELECT turn_id, kind, status, terminal_outcome, request_ref_json,
                    started_event_id, completed_event_id
               FROM trajectory_invocations
              WHERE log_id = ? AND head = ? AND invocation_id = ? LIMIT 1`,
            String(node["logId"]),
            String(node["head"]),
            String(node["invocationId"])
          )
          .toArray()[0];
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown trajectory invocation");
        return {
          kind: "trajectory-invocation",
          value: {
            logId: String(node["logId"]),
            head: String(node["head"]),
            invocationId: String(node["invocationId"]),
            turnId: row["turn_id"] == null ? null : String(row["turn_id"]),
            name: row["kind"] == null ? null : String(row["kind"]),
            status: String(row["status"]),
            terminalOutcome:
              row["terminal_outcome"] == null ? null : String(row["terminal_outcome"]),
            requestRef:
              row["request_ref_json"] == null
                ? null
                : trajectoryRequestRef(JSON.parse(String(row["request_ref_json"]))),
            startedEventId:
              row["started_event_id"] == null ? null : String(row["started_event_id"]),
            completedEventId:
              row["completed_event_id"] == null ? null : String(row["completed_event_id"]),
          },
        };
      }
      case "trajectory-turn": {
        const row = this.deps.sql
          .exec(
            `SELECT trigger_message_id, opened_at, closed_at, summary, ordinal
               FROM trajectory_turns
              WHERE log_id = ? AND head = ? AND turn_id = ? LIMIT 1`,
            String(node["logId"]),
            String(node["head"]),
            String(node["turnId"])
          )
          .toArray()[0];
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown trajectory turn");
        return {
          kind: "trajectory-turn",
          value: {
            logId: String(node["logId"]),
            head: String(node["head"]),
            turnId: String(node["turnId"]),
            triggerMessageId:
              row["trigger_message_id"] == null ? null : String(row["trigger_message_id"]),
            openedAt: row["opened_at"] == null ? null : String(row["opened_at"]),
            closedAt: row["closed_at"] == null ? null : String(row["closed_at"]),
            summary: row["summary"] == null ? null : String(row["summary"]),
            ordinal: row["ordinal"] == null ? null : Number(row["ordinal"]),
          },
        };
      }
      case "trajectory-message": {
        const row = this.deps.sql
          .exec(
            `SELECT turn_id, role, status, started_event_id, completed_event_id
               FROM trajectory_messages
              WHERE log_id = ? AND head = ? AND message_id = ? LIMIT 1`,
            String(node["logId"]),
            String(node["head"]),
            String(node["messageId"])
          )
          .toArray()[0];
        if (!row) throw new SemanticVcsError("InvalidReference", "Unknown trajectory message");
        const payloadEventId = row["completed_event_id"] ?? row["started_event_id"];
        const payloadRow =
          payloadEventId == null
            ? undefined
            : this.deps.sql
                .exec(
                  `SELECT actor_json, payload_ref_json FROM log_events
                    WHERE log_id = ? AND head = ? AND envelope_id = ? LIMIT 1`,
                  String(node["logId"]),
                  String(node["head"]),
                  String(payloadEventId)
                )
                .toArray()[0];
        const payload = payloadRow
          ? (JSON.parse(String(payloadRow["payload_ref_json"])) as Row)
          : {};
        const eventActor = payloadRow ? JSON.parse(String(payloadRow["actor_json"])) : null;
        const senderRef = trajectorySenderRef(payload["senderRef"] ?? eventActor);
        const textBlocks = (Array.isArray(payload["blocks"]) ? payload["blocks"] : []).flatMap(
          (value, index) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return [];
            const block = value as Row;
            if (block["type"] !== "text" || typeof block["content"] !== "string") return [];
            return [
              {
                blockId:
                  typeof block["blockId"] === "string"
                    ? block["blockId"]
                    : `${String(node["messageId"])}:block:${index}`,
                content: block["content"],
              },
            ];
          }
        );
        return {
          kind: "trajectory-message",
          value: {
            logId: String(node["logId"]),
            head: String(node["head"]),
            messageId: String(node["messageId"]),
            turnId: row["turn_id"] == null ? null : String(row["turn_id"]),
            role: String(row["role"]),
            status: String(row["status"]),
            startedEventId:
              row["started_event_id"] == null ? null : String(row["started_event_id"]),
            completedEventId:
              row["completed_event_id"] == null ? null : String(row["completed_event_id"]),
            sourceMessageId:
              typeof payload["sourceMessageId"] === "string" ? payload["sourceMessageId"] : null,
            senderRef,
            textBlocks,
          },
        };
      }
      default:
        throw new SemanticVcsError("InvalidReference", `Unknown node kind ${String(node["kind"])}`);
    }
  }

  private eventNeighborEdges(
    node: Row,
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number
  ): PositionedNeighborEdge[] {
    const eventId = String(node["eventId"]);
    const event = this.deps.sql
      .exec(`SELECT 1 FROM gad_workspace_events WHERE event_id = ?`, eventId)
      .toArray()[0];
    if (!event) throw new SemanticVcsError("InvalidReference", `Unknown event ${eventId}`);
    const rows = this.pageNeighborPhases(after, limit, [
      {
        phase: 0,
        edgeKind: "caused-by",
        sql: `SELECT '' AS sort_key, command_id AS target_id
                FROM gad_workspace_events
               WHERE event_id = ? AND (? IS NULL OR '' > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 1,
        edgeKind: "parent-out",
        sql: `SELECT printf('%020d:', ordinal) || parent_event_id AS sort_key,
                     parent_event_id AS target_id
                FROM gad_workspace_event_parents
               WHERE event_id = ?
                 AND (? IS NULL OR printf('%020d:', ordinal) || parent_event_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 2,
        edgeKind: "parent-in",
        sql: `SELECT event_id AS sort_key, event_id AS target_id
                FROM gad_workspace_event_parents
               WHERE parent_event_id = ? AND (? IS NULL OR event_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 3,
        edgeKind: "committed-by",
        sql: `SELECT printf('%020d:', ordinal) || application_id AS sort_key,
                     application_id AS target_id
                FROM gad_workspace_event_applications
               WHERE event_id = ?
                 AND (? IS NULL OR printf('%020d:', ordinal) || application_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
      {
        phase: 4,
        edgeKind: "basis-state",
        sql: `SELECT application_id AS sort_key, application_id AS target_id
                FROM gad_work_unit_applications
               WHERE basis_kind = 'event' AND basis_id = ?
                 AND (? IS NULL OR application_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [eventId],
      },
    ]);
    const state = { kind: "event", eventId } as const;
    const edges = rows.map((row): PositionedNeighborEdge => {
      const edgeKind = String(row["edge_kind"]);
      const targetId = String(row["target_id"]);
      return {
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge:
          edgeKind === "caused-by"
            ? {
                kind: edgeKind,
                from: state,
                to: { kind: "command", commandId: targetId },
              }
            : edgeKind === "parent-out"
              ? {
                  kind: "parent-event",
                  from: state,
                  to: { kind: "event", eventId: targetId },
                }
              : edgeKind === "parent-in"
                ? {
                    kind: "parent-event",
                    from: { kind: "event", eventId: targetId },
                    to: state,
                  }
                : edgeKind === "committed-by"
                  ? {
                      kind: "committed-by",
                      from: state,
                      to: { kind: "application", applicationId: targetId },
                    }
                  : {
                      kind: "basis-state",
                      from: { kind: "application", applicationId: targetId },
                      to: state,
                    },
      };
    });
    return this.appendStateMemberEdges(
      state,
      this.deps.store.stateRoot(state),
      after,
      5,
      6,
      limit,
      edges
    );
  }

  /**
   * Pages typed adjacency as the graph models it: one independently keyset-paged
   * query per ordered edge phase. A node may grow new edge kinds without turning
   * its adjacency into one deployment-limited compound SELECT.
   *
   * Every phase query returns `sort_key` plus its edge-specific columns and
   * accepts `(afterKey, afterKey, remainingLimit)` after its declared params.
   */
  private pageNeighborPhases(
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number,
    phases: readonly NeighborPhaseQuery[]
  ): Row[] {
    const rows: Row[] = [];
    for (const phase of phases) {
      if (rows.length >= limit) break;
      if (after.phase > phase.phase) continue;
      const afterKey = after.phase === phase.phase ? after.key : null;
      const phaseRows = this.deps.sql
        .exec(phase.sql, ...phase.params, afterKey, afterKey, limit - rows.length)
        .toArray() as Row[];
      rows.push(
        ...phaseRows.map((row) => ({
          ...row,
          edge_group: phase.phase,
          ...(phase.edgeKind === undefined ? {} : { edge_kind: phase.edgeKind }),
        }))
      );
    }
    return rows;
  }

  private applicationNeighborEdges(
    node: Row,
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number
  ): PositionedNeighborEdge[] {
    const applicationId = String(node["applicationId"]);
    const application = this.deps.sql
      .exec(`SELECT 1 FROM gad_work_unit_applications WHERE application_id = ?`, applicationId)
      .toArray()[0];
    if (!application) {
      throw new SemanticVcsError("InvalidReference", `Unknown application ${applicationId}`);
    }
    const rows = this.pageNeighborPhases(after, limit, [
      {
        phase: 0,
        edgeKind: "basis-state",
        sql: `SELECT '' AS sort_key, basis_kind AS target_kind, basis_id AS target_id
                FROM gad_work_unit_applications
               WHERE application_id = ? AND (? IS NULL OR '' > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 1,
        edgeKind: "basis-state-in",
        sql: `SELECT application_id AS sort_key, 'application' AS target_kind,
                     application_id AS target_id
                FROM gad_work_unit_applications
               WHERE basis_kind = 'application' AND basis_id = ?
                 AND (? IS NULL OR application_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 2,
        edgeKind: "committed-by",
        sql: `SELECT event_id AS sort_key, 'event' AS target_kind, event_id AS target_id
                FROM gad_workspace_event_applications
               WHERE application_id = ? AND (? IS NULL OR event_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 3,
        edgeKind: "applies-work",
        sql: `SELECT '' AS sort_key, 'work-unit' AS target_kind, work_unit_id AS target_id
                FROM gad_work_unit_applications
               WHERE application_id = ? AND (? IS NULL OR '' > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
      {
        phase: 4,
        edgeKind: "applies-change",
        sql: `SELECT printf('%020d:', ordinal) || applied_change_id AS sort_key,
                     'applied-change' AS target_kind, applied_change_id AS target_id
                FROM gad_applied_changes
               WHERE application_id = ?
                 AND (? IS NULL OR printf('%020d:', ordinal) || applied_change_id > ?)
               ORDER BY sort_key, target_id LIMIT ?`,
        params: [applicationId],
      },
    ]);
    const state = { kind: "application", applicationId } as const;
    const edges = rows.map((row): PositionedNeighborEdge => {
      const edgeKind = String(row["edge_kind"]);
      const targetId = String(row["target_id"]);
      return {
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge:
          edgeKind === "basis-state"
            ? {
                kind: edgeKind,
                from: state,
                to:
                  row["target_kind"] === "event"
                    ? { kind: "event", eventId: targetId }
                    : { kind: "application", applicationId: targetId },
              }
            : edgeKind === "basis-state-in"
              ? {
                  kind: "basis-state",
                  from: { kind: "application", applicationId: targetId },
                  to: state,
                }
              : edgeKind === "committed-by"
                ? {
                    kind: edgeKind,
                    from: { kind: "event", eventId: targetId },
                    to: state,
                  }
                : edgeKind === "applies-work"
                  ? {
                      kind: edgeKind,
                      from: state,
                      to: { kind: "work-unit", workUnitId: targetId },
                    }
                  : {
                      kind: "applies-change",
                      from: state,
                      to: { kind: "applied-change", appliedChangeId: targetId },
                    },
      };
    });
    return this.appendStateMemberEdges(
      state,
      this.deps.store.stateRoot(state),
      after,
      5,
      6,
      limit,
      edges
    );
  }

  private appendStateMemberEdges(
    state: StateNodeRef,
    root: string,
    phase: Readonly<{ phase: number; key: string | null }>,
    repositoryPhase: number,
    filePhase: number,
    limit: number,
    edges: PositionedNeighborEdge[]
  ): PositionedNeighborEdge[] {
    const result = [...edges];
    if (result.length < limit && phase.phase <= repositoryPhase) {
      const repositories = this.deps.store.facts.page(root, "repository", {
        ...(phase.phase === repositoryPhase && phase.key !== null ? { afterKey: phase.key } : {}),
        limit: limit - result.length,
      });
      result.push(
        ...repositories.values.map(({ key: repositoryId }) => ({
          position: { phase: repositoryPhase, key: repositoryId },
          edge: {
            kind: "contains-repository",
            from: state,
            to: { kind: "repository", state, repositoryId },
          },
        }))
      );
    }
    if (result.length >= limit || phase.phase > filePhase) return result;

    let afterFileId = phase.phase === filePhase ? (phase.key ?? undefined) : undefined;
    while (result.length < limit) {
      const files = this.deps.store.facts.page(root, "file", {
        ...(afterFileId ? { afterKey: afterFileId } : {}),
        limit: Math.max(limit - result.length, 100),
      });
      for (const { key: fileId } of files.values) {
        const point = this.deps.store.facts.file(root, fileId);
        if (!point || point.state.presence !== "placed") continue;
        result.push({
          position: { phase: filePhase, key: fileId },
          edge: {
            kind: "places-file",
            from: state,
            to: { kind: "file", state, repositoryId: point.state.repositoryId, fileId },
          },
        });
        if (result.length >= limit) break;
      }
      if (result.length >= limit || files.next === null) break;
      afterFileId = files.next;
    }
    return result;
  }

  private appliedChangeNeighborEdges(
    node: Row,
    after: Readonly<{ phase: number; key: string | null }>,
    limit: number
  ): PositionedNeighborEdge[] {
    const appliedChangeId = String(node["appliedChangeId"]);
    const exists = this.deps.sql
      .exec(`SELECT 1 FROM gad_applied_changes WHERE applied_change_id = ?`, appliedChangeId)
      .toArray()[0];
    if (!exists) {
      throw new SemanticVcsError("InvalidReference", `Unknown applied change ${appliedChangeId}`);
    }
    const rows = this.deps.sql
      .exec(
        `SELECT edge_group, sort_key, edge_kind, source_id, target_id FROM (
           SELECT 0 AS edge_group, '' AS sort_key, 'applies-change' AS edge_kind,
                  application_id AS source_id, applied_change_id AS target_id
             FROM gad_applied_changes WHERE applied_change_id = ?
           UNION ALL
           SELECT 1, '', 'realizes-change', applied_change_id, change_id
             FROM gad_applied_changes WHERE applied_change_id = ?
           UNION ALL
           SELECT 2, content_edge_id,
                  CASE relation
                    WHEN 'incorporates' THEN 'incorporates-content'
                    WHEN 'copies' THEN 'copies-content'
                    ELSE 'preserves-content'
                  END,
                  child_applied_change_id, parent_applied_change_id
             FROM gad_content_edges
            WHERE child_applied_change_id = ? OR parent_applied_change_id = ?
         ) adjacency
         WHERE edge_group > ?
            OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
         ORDER BY edge_group, sort_key, target_id
         LIMIT ?`,
        appliedChangeId,
        appliedChangeId,
        appliedChangeId,
        appliedChangeId,
        after.phase,
        after.phase,
        after.key,
        after.key,
        limit
      )
      .toArray() as Row[];
    return rows.map((row) => {
      const edgeKind = String(row["edge_kind"]);
      const sourceId = String(row["source_id"]);
      const targetId = String(row["target_id"]);
      return {
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge:
          edgeKind === "applies-change"
            ? {
                kind: edgeKind,
                from: { kind: "application", applicationId: sourceId },
                to: { kind: "applied-change", appliedChangeId: targetId },
              }
            : edgeKind === "realizes-change"
              ? {
                  kind: edgeKind,
                  from: { kind: "applied-change", appliedChangeId: sourceId },
                  to: { kind: "change", changeId: targetId },
                }
              : {
                  kind: edgeKind,
                  from: { kind: "applied-change", appliedChangeId: sourceId },
                  to: { kind: "applied-change", appliedChangeId: targetId },
                },
      };
    });
  }

  private neighborEdges(
    node: Row,
    cursor: string | undefined,
    limit: number
  ): PositionedNeighborEdge[] {
    const kind = String(node["kind"]);
    const after = parseNeighborCursor(cursor, { root: node });
    if (kind === "event") return this.eventNeighborEdges(node, after, limit);
    if (kind === "application") return this.applicationNeighborEdges(node, after, limit);
    if (kind === "applied-change") return this.appliedChangeNeighborEdges(node, after, limit);
    if (kind === "work-unit") {
      const workUnitId = String(node["workUnitId"]);
      const exists = this.deps.sql
        .exec(`SELECT 1 FROM gad_work_units WHERE work_unit_id = ?`, workUnitId)
        .toArray();
      if (exists.length === 0) {
        throw new SemanticVcsError("InvalidReference", `Unknown work unit ${workUnitId}`);
      }
      const rows = this.pageNeighborPhases(after, limit, [
        {
          phase: 0,
          edgeKind: "caused-by",
          sql: `SELECT '' AS sort_key, command_id AS target_id, NULL AS state_id
                  FROM gad_work_units
                 WHERE work_unit_id = ? AND (? IS NULL OR '' > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 1,
          edgeKind: "applies-work",
          sql: `SELECT application_id AS sort_key, application_id AS target_id, NULL AS state_id
                  FROM gad_work_unit_applications
                 WHERE work_unit_id = ? AND (? IS NULL OR application_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 2,
          edgeKind: "authored-change",
          sql: `SELECT printf('%020d:%020d', operation, ordinal) AS sort_key,
                       change_id AS target_id, NULL AS state_id
                  FROM gad_changes
                 WHERE work_unit_id = ?
                   AND (? IS NULL OR printf('%020d:%020d', operation, ordinal) > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 3,
          edgeKind: "incorporates-change",
          sql: `SELECT source.change_id AS sort_key,
                       source.change_id AS target_id, NULL AS state_id
                  FROM gad_integration_decisions decision
                  JOIN gad_decision_source_changes source
                    ON source.decision_id = decision.decision_id
                 WHERE decision.work_unit_id = ? AND (? IS NULL OR source.change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 4,
          edgeKind: "records-decision",
          sql: `SELECT created_at || ':' || decision_id AS sort_key,
                       decision_id AS target_id, NULL AS state_id
                  FROM gad_integration_decisions
                 WHERE work_unit_id = ?
                   AND (? IS NULL OR created_at || ':' || decision_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
        {
          phase: 5,
          edgeKind: "imports-repository",
          sql: `SELECT application.application_id || ':' || CAST(target.key AS TEXT) AS sort_key,
                       CAST(target.value AS TEXT) AS target_id,
                       application.application_id AS state_id
                  FROM gad_work_units work
                  JOIN gad_work_unit_applications application
                    ON application.work_unit_id = work.work_unit_id
                  JOIN json_each(work.external_snapshot_json, '$.targetRepositoryIds') target
                 WHERE work.work_unit_id = ?
                   AND (? IS NULL OR application.application_id || ':' || CAST(target.key AS TEXT) > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [workUnitId],
        },
      ]);
      const workUnitEdges = rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        if (edgeKind === "caused-by") {
          return {
            kind: edgeKind,
            from: { kind: "work-unit", workUnitId },
            to: { kind: "command", commandId: targetId },
          };
        }
        if (edgeKind === "applies-work") {
          return {
            kind: edgeKind,
            from: { kind: "application", applicationId: targetId },
            to: { kind: "work-unit", workUnitId },
          };
        }
        if (edgeKind === "authored-change" || edgeKind === "incorporates-change") {
          return {
            kind: edgeKind,
            from: { kind: "work-unit", workUnitId },
            to: { kind: "change", changeId: targetId },
          };
        }
        if (edgeKind === "imports-repository") {
          return {
            kind: edgeKind,
            from: { kind: "work-unit", workUnitId },
            to: {
              kind: "repository",
              state: { kind: "application", applicationId: String(row["state_id"]) },
              repositoryId: targetId,
            },
          };
        }
        return {
          kind: "records-decision",
          from: { kind: "work-unit", workUnitId },
          to: { kind: "decision", decisionId: targetId },
        };
      });
      return workUnitEdges.map((edge, index) => ({
        position: {
          phase: Number(rows[index]!["edge_group"]),
          key: String(rows[index]!["sort_key"]),
        },
        edge,
      }));
    } else if (kind === "change") {
      const changeId = String(node["changeId"]);
      const change = this.changeRequired(changeId);
      const rows = this.pageNeighborPhases(after, limit, [
        {
          phase: 0,
          edgeKind: "authored-change",
          sql: `SELECT '' AS sort_key, work_unit_id AS source_id, change_id AS target_id,
                       NULL AS source_state_kind, NULL AS source_state_id,
                       NULL AS source_repository_id, NULL AS source_file_id
                  FROM gad_changes
                 WHERE change_id = ? AND (? IS NULL OR '' > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 1,
          edgeKind: "realizes-change",
          sql: `SELECT applied_change_id AS sort_key, applied_change_id AS source_id,
                       change_id AS target_id, NULL AS source_state_kind,
                       NULL AS source_state_id, NULL AS source_repository_id,
                       NULL AS source_file_id
                  FROM gad_applied_changes
                 WHERE change_id = ? AND (? IS NULL OR applied_change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 2,
          edgeKind: "decides-change",
          sql: `SELECT decision_id AS sort_key, decision_id AS source_id,
                       change_id AS target_id, NULL AS source_state_kind,
                       NULL AS source_state_id, NULL AS source_repository_id,
                       NULL AS source_file_id
                  FROM gad_decision_source_changes
                 WHERE change_id = ? AND (? IS NULL OR decision_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 3,
          edgeKind: "incorporates-change",
          sql: `SELECT decision.work_unit_id AS sort_key,
                       decision.work_unit_id AS source_id, source.change_id AS target_id,
                       NULL AS source_json
                  FROM gad_decision_source_changes source
                  JOIN gad_integration_decisions decision
                    ON decision.decision_id = source.decision_id
                 WHERE source.change_id = ?
                   AND (? IS NULL OR decision.work_unit_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 4,
          edgeKind: "counteracts",
          sql: `SELECT counteracted_change_id AS sort_key, change_id AS source_id,
                       counteracted_change_id AS target_id, NULL AS source_state_kind,
                       NULL AS source_state_id, NULL AS source_repository_id,
                       NULL AS source_file_id
                  FROM gad_change_counteractions
                 WHERE change_id = ? AND (? IS NULL OR counteracted_change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
        {
          phase: 5,
          edgeKind: "counteracts",
          sql: `SELECT change_id AS sort_key, change_id AS source_id, ? AS target_id,
                       NULL AS source_state_kind, NULL AS source_state_id,
                       NULL AS source_repository_id, NULL AS source_file_id
                  FROM gad_change_counteractions
                 WHERE counteracted_change_id = ? AND (? IS NULL OR change_id > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId, changeId],
        },
        {
          phase: 6,
          edgeKind: "authored-copy-source",
          sql: `SELECT '' AS sort_key, change_id AS source_id,
                       change_id AS target_id, source_json
                  FROM gad_changes
                 WHERE change_id = ? AND source_json IS NOT NULL
                   AND (? IS NULL OR '' > ?)
                 ORDER BY sort_key, target_id LIMIT ?`,
          params: [changeId],
        },
      ]);
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const sourceId = String(row["source_id"]);
        const targetId = String(row["target_id"]);
        const edge: Row =
          edgeKind === "authored-change"
            ? {
                kind: edgeKind,
                from: { kind: "work-unit", workUnitId: change.workUnitId },
                to: { kind: "change", changeId },
              }
            : edgeKind === "realizes-change"
              ? {
                  kind: edgeKind,
                  from: { kind: "applied-change", appliedChangeId: sourceId },
                  to: { kind: "change", changeId },
                }
              : edgeKind === "decides-change"
                ? {
                    kind: edgeKind,
                    from: { kind: "decision", decisionId: sourceId },
                    to: { kind: "change", changeId },
                  }
                : edgeKind === "incorporates-change"
                  ? {
                      kind: edgeKind,
                      from: { kind: "work-unit", workUnitId: sourceId },
                      to: { kind: "change", changeId },
                    }
                  : edgeKind === "authored-copy-source"
                    ? (() => {
                        const source = JSON.parse(
                          String(row["source_json"])
                        ) as AuthoredCopySourceEndpoint;
                        return {
                          kind: edgeKind,
                          from: { kind: "change", changeId },
                          to: {
                            kind: "file",
                            state: source.state,
                            repositoryId: source.repositoryId,
                            fileId: source.fileId,
                          },
                        };
                      })()
                    : {
                        kind: edgeKind,
                        from: { kind: "change", changeId: sourceId },
                        to: { kind: "change", changeId: targetId },
                      };
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge,
        };
      });
    } else if (kind === "decision") {
      const decisionId = String(node["decisionId"]);
      const decision = this.deps.sql
        .exec(
          `SELECT work_unit_id FROM gad_integration_decisions WHERE decision_id = ?`,
          decisionId
        )
        .toArray()[0] as Row | undefined;
      if (!decision) {
        throw new SemanticVcsError("InvalidReference", `Unknown decision ${decisionId}`);
      }
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'records-decision' AS edge_kind,
                    work_unit_id AS target_id
               FROM gad_integration_decisions WHERE decision_id = ?
             UNION ALL
             SELECT 1, change_id, 'decides-change', change_id
               FROM gad_decision_source_changes WHERE decision_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          decisionId,
          decisionId,
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "records-decision"
              ? {
                  kind: edgeKind,
                  from: { kind: "work-unit", workUnitId: targetId },
                  to: { kind: "decision", decisionId },
                }
              : {
                  kind: edgeKind,
                  from: { kind: "decision", decisionId },
                  to: { kind: "change", changeId: targetId },
                },
        };
      });
    } else if (kind === "command") {
      const commandId = String(node["commandId"]);
      const command = this.deps.sql
        .exec(
          `SELECT cause_log_id, cause_head, cause_invocation_id
             FROM vcs_command_journal WHERE command_id = ? LIMIT 1`,
          commandId
        )
        .toArray()[0] as Row | undefined;
      if (!command) throw new SemanticVcsError("InvalidReference", `Unknown command ${commandId}`);
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id,
                  cause_log_id, cause_head, cause_invocation_id FROM (
             SELECT 0 AS edge_group, work_unit_id AS sort_key, 'work-unit' AS edge_kind,
                    work_unit_id AS target_id, NULL AS cause_log_id, NULL AS cause_head,
                    NULL AS cause_invocation_id
               FROM gad_work_units WHERE command_id = ?
             UNION ALL
             SELECT 1, event_id, 'event', event_id, NULL, NULL, NULL
               FROM gad_workspace_events WHERE command_id = ?
             UNION ALL
             SELECT 2, cause_log_id || ':' || cause_head || ':' || cause_invocation_id,
                    'trajectory-invocation', cause_invocation_id,
                    cause_log_id, cause_head, cause_invocation_id
               FROM vcs_command_journal
              WHERE command_id = ? AND cause_invocation_id IS NOT NULL
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          commandId,
          commandId,
          commandId,
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const targetKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            targetKind === "work-unit"
              ? {
                  kind: "caused-by",
                  from: { kind: "work-unit", workUnitId: targetId },
                  to: { kind: "command", commandId },
                }
              : targetKind === "event"
                ? {
                    kind: "caused-by",
                    from: { kind: "event", eventId: targetId },
                    to: { kind: "command", commandId },
                  }
                : {
                    kind: "caused-by",
                    from: { kind: "command", commandId },
                    to: {
                      kind: "trajectory-invocation",
                      logId: String(row["cause_log_id"]),
                      head: String(row["cause_head"]),
                      invocationId: String(row["cause_invocation_id"]),
                    },
                  },
        };
      });
    } else if (kind === "trajectory-invocation") {
      const invocation = {
        kind: "trajectory-invocation",
        logId: node["logId"],
        head: node["head"],
        invocationId: node["invocationId"],
      };
      const invocationRow = this.deps.sql
        .exec(
          `SELECT turn_id FROM trajectory_invocations
            WHERE log_id = ? AND head = ? AND invocation_id = ? LIMIT 1`,
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"])
        )
        .toArray()[0] as Row | undefined;
      if (!invocationRow) {
        throw new SemanticVcsError("InvalidReference", "Unknown trajectory invocation");
      }
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'part-of-trajectory' AS edge_kind,
                    invocation_id AS target_id
               FROM trajectory_invocations
              WHERE log_id = ? AND head = ? AND invocation_id = ?
             UNION ALL
             SELECT 1, turn_id, 'part-of-turn', turn_id
               FROM trajectory_invocations
              WHERE log_id = ? AND head = ? AND invocation_id = ? AND turn_id IS NOT NULL
             UNION ALL
             SELECT 2, command_id, 'caused-by', command_id
               FROM vcs_command_journal
              WHERE cause_log_id = ? AND cause_head = ? AND cause_invocation_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["invocationId"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "part-of-trajectory"
              ? {
                  kind: edgeKind,
                  from: invocation,
                  to: { kind: "trajectory", logId: node["logId"], head: node["head"] },
                }
              : edgeKind === "part-of-turn"
                ? {
                    kind: edgeKind,
                    from: invocation,
                    to: {
                      kind: "trajectory-turn",
                      logId: node["logId"],
                      head: node["head"],
                      turnId: targetId,
                    },
                  }
                : {
                    kind: edgeKind,
                    from: { kind: "command", commandId: targetId },
                    to: invocation,
                  },
        };
      });
    } else if (kind === "trajectory-turn") {
      const turn = {
        kind: "trajectory-turn",
        logId: node["logId"],
        head: node["head"],
        turnId: node["turnId"],
      };
      const turnRow = this.deps.sql
        .exec(
          `SELECT trigger_message_id FROM trajectory_turns
            WHERE log_id = ? AND head = ? AND turn_id = ? LIMIT 1`,
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"])
        )
        .toArray()[0] as Row | undefined;
      if (!turnRow) throw new SemanticVcsError("InvalidReference", "Unknown trajectory turn");
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'part-of-trajectory' AS edge_kind,
                    turn_id AS target_id
               FROM trajectory_turns WHERE log_id = ? AND head = ? AND turn_id = ?
             UNION ALL
             SELECT 1, trigger_message_id, 'triggered-by', trigger_message_id
               FROM trajectory_turns
              WHERE log_id = ? AND head = ? AND turn_id = ? AND trigger_message_id IS NOT NULL
             UNION ALL
             SELECT 2, invocation_id, 'part-of-turn', invocation_id
               FROM trajectory_invocations WHERE log_id = ? AND head = ? AND turn_id = ?
             UNION ALL
             SELECT 3, message_id, 'turn-message', message_id
               FROM trajectory_messages WHERE log_id = ? AND head = ? AND turn_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["turnId"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "part-of-trajectory"
              ? {
                  kind: edgeKind,
                  from: turn,
                  to: { kind: "trajectory", logId: node["logId"], head: node["head"] },
                }
              : edgeKind === "triggered-by"
                ? {
                    kind: edgeKind,
                    from: turn,
                    to: {
                      kind: "trajectory-message",
                      logId: node["logId"],
                      head: node["head"],
                      messageId: targetId,
                    },
                  }
                : edgeKind === "part-of-turn"
                  ? {
                      kind: edgeKind,
                      from: {
                        kind: "trajectory-invocation",
                        logId: node["logId"],
                        head: node["head"],
                        invocationId: targetId,
                      },
                      to: turn,
                    }
                  : {
                      kind: "part-of-turn",
                      from: {
                        kind: "trajectory-message",
                        logId: node["logId"],
                        head: node["head"],
                        messageId: targetId,
                      },
                      to: turn,
                    },
        };
      });
    } else if (kind === "trajectory-message") {
      const message = {
        kind: "trajectory-message",
        logId: node["logId"],
        head: node["head"],
        messageId: node["messageId"],
      };
      const messageRow = this.deps.sql
        .exec(
          `SELECT turn_id FROM trajectory_messages
            WHERE log_id = ? AND head = ? AND message_id = ? LIMIT 1`,
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"])
        )
        .toArray()[0] as Row | undefined;
      if (!messageRow) {
        throw new SemanticVcsError("InvalidReference", "Unknown trajectory message");
      }
      const rows = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, edge_kind, target_id FROM (
             SELECT 0 AS edge_group, '' AS sort_key, 'part-of-trajectory' AS edge_kind,
                    message_id AS target_id
               FROM trajectory_messages WHERE log_id = ? AND head = ? AND message_id = ?
             UNION ALL
             SELECT 1, turn_id, 'part-of-turn', turn_id
               FROM trajectory_messages
              WHERE log_id = ? AND head = ? AND message_id = ? AND turn_id IS NOT NULL
             UNION ALL
             SELECT 2, turn_id, 'triggered-by', turn_id
               FROM trajectory_turns
              WHERE log_id = ? AND head = ? AND trigger_message_id = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, target_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["messageId"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const edgeKind = String(row["edge_kind"]);
        const targetId = String(row["target_id"]);
        return {
          position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
          edge:
            edgeKind === "part-of-trajectory"
              ? {
                  kind: edgeKind,
                  from: message,
                  to: { kind: "trajectory", logId: node["logId"], head: node["head"] },
                }
              : edgeKind === "part-of-turn"
                ? {
                    kind: edgeKind,
                    from: message,
                    to: {
                      kind: "trajectory-turn",
                      logId: node["logId"],
                      head: node["head"],
                      turnId: targetId,
                    },
                  }
                : {
                    kind: edgeKind,
                    from: {
                      kind: "trajectory-turn",
                      logId: node["logId"],
                      head: node["head"],
                      turnId: targetId,
                    },
                    to: message,
                  },
        };
      });
    } else if (kind === "trajectory") {
      const trajectory = { kind: "trajectory", logId: node["logId"], head: node["head"] };
      const members = this.deps.sql
        .exec(
          `SELECT edge_group, sort_key, member_kind, member_id FROM (
             SELECT 0 AS edge_group, invocation_id AS sort_key,
                    'trajectory-invocation' AS member_kind, invocation_id AS member_id
               FROM trajectory_invocations WHERE log_id = ? AND head = ?
             UNION ALL
             SELECT 1, message_id, 'trajectory-message', message_id
               FROM trajectory_messages WHERE log_id = ? AND head = ?
             UNION ALL
             SELECT 2, turn_id, 'trajectory-turn', turn_id
               FROM trajectory_turns WHERE log_id = ? AND head = ?
           ) adjacency
           WHERE edge_group > ?
              OR (edge_group = ? AND (? IS NULL OR sort_key > ?))
           ORDER BY edge_group, sort_key, member_id LIMIT ?`,
          String(node["logId"]),
          String(node["head"]),
          String(node["logId"]),
          String(node["head"]),
          String(node["logId"]),
          String(node["head"]),
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return members.map((row) => ({
        position: { phase: Number(row["edge_group"]), key: String(row["sort_key"]) },
        edge: {
          kind: "part-of-trajectory",
          from:
            row["member_kind"] === "trajectory-invocation"
              ? {
                  kind: "trajectory-invocation",
                  logId: node["logId"],
                  head: node["head"],
                  invocationId: String(row["member_id"]),
                }
              : row["member_kind"] === "trajectory-message"
                ? {
                    kind: "trajectory-message",
                    logId: node["logId"],
                    head: node["head"],
                    messageId: String(row["member_id"]),
                  }
                : {
                    kind: "trajectory-turn",
                    logId: node["logId"],
                    head: node["head"],
                    turnId: String(row["member_id"]),
                  },
          to: trajectory,
        },
      }));
    } else if (kind === "file") {
      const state = node["state"] as StateNodeRef;
      const fileId = String(node["fileId"]);
      const point = this.deps.store.facts.file(this.deps.store.stateRoot(state), fileId);
      if (!point) throw new SemanticVcsError("InvalidReference", `Unknown file ${fileId}`);
      const repositoryId = String(node["repositoryId"]);
      if (point.repository.repositoryId !== repositoryId) {
        throw new SemanticVcsError("InvalidReference", `File ${fileId} is not in ${repositoryId}`);
      }
      const file = { kind: "file", state, repositoryId, fileId } as const;
      const edges: PositionedNeighborEdge[] = [];
      if (point.state.presence === "placed" && after.phase === 0 && after.key === null) {
        edges.push({
          position: { phase: 0, key: "" },
          edge: { kind: "places-file", from: state, to: file },
        });
      }
      if (edges.length >= limit || after.phase > 1) return edges;
      const [stateKind, stateId] =
        state.kind === "event"
          ? (["event", state.eventId] as const)
          : (["application", state.applicationId] as const);
      const rows = this.deps.sql
        .exec(
          `SELECT change_id AS sort_key, change_id
             FROM gad_changes
            WHERE source_json IS NOT NULL
              AND json_extract(source_json, '$.state.kind') = ?
              AND coalesce(
                    json_extract(source_json, '$.state.eventId'),
                    json_extract(source_json, '$.state.applicationId')
                  ) = ?
              AND json_extract(source_json, '$.repositoryId') = ?
              AND json_extract(source_json, '$.fileId') = ?
              AND (? IS NULL OR change_id > ?)
            ORDER BY sort_key, change_id LIMIT ?`,
          stateKind,
          stateId,
          repositoryId,
          fileId,
          after.phase === 1 ? after.key : null,
          after.phase === 1 ? after.key : null,
          limit - edges.length
        )
        .toArray() as Row[];
      edges.push(
        ...rows.map((row) => ({
          position: { phase: 1, key: String(row["sort_key"]) },
          edge: {
            kind: "authored-copy-source",
            from: { kind: "change", changeId: String(row["change_id"]) },
            to: file,
          },
        }))
      );
      return edges;
    } else if (kind === "repository") {
      const state = node["state"] as StateNodeRef;
      const repositoryId = String(node["repositoryId"]);
      const member = this.deps.store.facts.member(this.deps.store.stateRoot(state), repositoryId);
      if (!member) {
        throw new SemanticVcsError("InvalidReference", `Unknown repository ${repositoryId}`);
      }
      const repository = { kind: "repository", state, repositoryId } as const;
      const edges: PositionedNeighborEdge[] = [];
      if (after.phase === 0 && after.key === null) {
        edges.push({
          position: { phase: 0, key: "" },
          edge: { kind: "contains-repository", from: state, to: repository },
        });
      }
      if (edges.length >= limit || after.phase > 1 || state.kind !== "application") return edges;
      const rows = this.deps.sql
        .exec(
          `SELECT work.work_unit_id AS sort_key, work.work_unit_id
             FROM gad_work_unit_applications application
             JOIN gad_work_units work ON work.work_unit_id = application.work_unit_id
             JOIN json_each(work.external_snapshot_json, '$.targetRepositoryIds') target
            WHERE application.application_id = ?
              AND CAST(target.value AS TEXT) = ?
              AND (? IS NULL OR work.work_unit_id > ?)
            ORDER BY sort_key, work.work_unit_id LIMIT ?`,
          state.applicationId,
          repositoryId,
          after.phase === 1 ? after.key : null,
          after.phase === 1 ? after.key : null,
          limit - edges.length
        )
        .toArray() as Row[];
      edges.push(
        ...rows.map((row) => ({
          position: { phase: 1, key: String(row["sort_key"]) },
          edge: {
            kind: "imports-repository",
            from: { kind: "work-unit", workUnitId: String(row["work_unit_id"]) },
            to: repository,
          },
        }))
      );
      return edges;
    }
    throw new SemanticVcsError("InvalidReference", `Unknown node kind ${kind}`);
  }

  private historyEntries(
    node: Row,
    direction: "past" | "future",
    cursor: string | undefined,
    limit: number
  ): PositionedHistoryEntry[] {
    const after = parseHistoryCursor(cursor, { root: node, direction });
    if (node["kind"] === "file") {
      if (direction !== "past") {
        throw new SemanticVcsError("InvalidReference", "File history is defined toward its past");
      }
      const state = node["state"] as StateNodeRef;
      const fileId = String(node["fileId"]);
      const point = this.deps.store.facts.file(this.deps.store.stateRoot(state), fileId);
      if (!point) throw new SemanticVcsError("InvalidReference", `Unknown file ${fileId}`);
      const rows = this.deps.sql
        .exec(
          `WITH RECURSIVE state_chain(state_kind, state_id, depth) AS (
             SELECT ?, ?, 0
             UNION ALL
             SELECT application.basis_kind, application.basis_id, state_chain.depth + 1
               FROM state_chain
               JOIN gad_work_unit_applications application
                 ON state_chain.state_kind = 'application'
                AND application.application_id = state_chain.state_id
              WHERE state_chain.depth < ?
             UNION ALL
             SELECT 'event', parent.parent_event_id, state_chain.depth + 1
               FROM state_chain
               JOIN gad_workspace_event_parents parent
                 ON state_chain.state_kind = 'event'
                AND parent.event_id = state_chain.state_id
                AND parent.ordinal = 0
              WHERE state_chain.depth < ?
           ), lineage_applications(depth, application_ordinal, application_id) AS (
             SELECT depth, 0, state_id FROM state_chain WHERE state_kind = 'application'
             UNION ALL
             SELECT state_chain.depth, event_application.ordinal,
                    event_application.application_id
               FROM state_chain
               JOIN gad_workspace_event_applications event_application
                 ON state_chain.state_kind = 'event'
                AND event_application.event_id = state_chain.state_id
           ), candidates AS (
             SELECT change.change_id, change.kind, work.intent_summary, work.created_at,
                    lineage.depth,
                    printf('%020d:%020d:',
                      9223372036854775807 - lineage.application_ordinal,
                      9223372036854775807 - applied.ordinal) || change.change_id AS sort_key,
                    ROW_NUMBER() OVER (
                      PARTITION BY change.change_id
                      ORDER BY lineage.depth, lineage.application_ordinal DESC,
                               applied.ordinal DESC, change.change_id
                    ) AS occurrence
               FROM lineage_applications lineage
               JOIN gad_applied_changes applied
                 ON applied.application_id = lineage.application_id
               JOIN gad_changes change ON change.change_id = applied.change_id
               JOIN gad_change_coordinates coordinate
                 ON coordinate.change_id = change.change_id AND coordinate.file_id = ?
               JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
           )
           SELECT change_id, kind, intent_summary, created_at, depth, sort_key
             FROM candidates
            WHERE occurrence = 1
              AND (depth > ? OR (depth = ? AND (? IS NULL OR sort_key > ?)))
            ORDER BY depth, sort_key
            LIMIT ?`,
          state.kind,
          state.kind === "event" ? state.eventId : state.applicationId,
          MAX_ANCESTRY_EDGES,
          MAX_ANCESTRY_EDGES,
          fileId,
          after.phase,
          after.phase,
          after.key,
          after.key,
          limit
        )
        .toArray() as Row[];
      return rows.map((row) => {
        const changeId = String(row["change_id"]);
        return {
          position: { phase: Number(row["depth"]), key: String(row["sort_key"]) },
          entry: {
            node: { kind: "change", changeId },
            createdAt: String(row["created_at"]),
            summary:
              row["intent_summary"] == null ? String(row["kind"]) : String(row["intent_summary"]),
          },
        };
      });
    }
    if (node["kind"] !== "event") {
      throw new SemanticVcsError("InvalidReference", "History requires an event or file root");
    }
    const eventId = String(node["eventId"]);
    if (!this.deps.store.event(eventId)) {
      throw new SemanticVcsError("InvalidReference", `Unknown event ${eventId}`);
    }
    const rows = this.deps.sql
      .exec(
        direction === "past"
          ? `WITH RECURSIVE history(event_id, depth) AS (
               SELECT ?, 0
               UNION
               SELECT parent.parent_event_id, history.depth + 1
                 FROM history
                 JOIN gad_workspace_event_parents parent
                   ON parent.event_id = history.event_id
                WHERE history.depth < ?
             ), nearest(event_id, depth) AS (
               SELECT event_id, MIN(depth) FROM history GROUP BY event_id
             )
             SELECT event.event_id, nearest.depth, event.created_at, event.message, event.kind
               FROM nearest JOIN gad_workspace_events event ON event.event_id = nearest.event_id
              WHERE nearest.depth > ?
                 OR (nearest.depth = ? AND (? IS NULL OR nearest.event_id > ?))
              ORDER BY nearest.depth, nearest.event_id LIMIT ?`
          : `WITH RECURSIVE history(event_id, depth) AS (
               SELECT ?, 0
               UNION
               SELECT child.event_id, history.depth + 1
                 FROM history
                 JOIN gad_workspace_event_parents child
                   ON child.parent_event_id = history.event_id
                WHERE history.depth < ?
             ), nearest(event_id, depth) AS (
               SELECT event_id, MIN(depth) FROM history GROUP BY event_id
             )
             SELECT event.event_id, nearest.depth, event.created_at, event.message, event.kind
               FROM nearest JOIN gad_workspace_events event ON event.event_id = nearest.event_id
              WHERE nearest.depth > ?
                 OR (nearest.depth = ? AND (? IS NULL OR nearest.event_id > ?))
              ORDER BY nearest.depth, nearest.event_id LIMIT ?`,
        eventId,
        MAX_ANCESTRY_EDGES,
        after.phase,
        after.phase,
        after.key,
        after.key,
        limit
      )
      .toArray() as Row[];
    return rows.map((row) => ({
      position: { phase: Number(row["depth"]), key: String(row["event_id"]) },
      entry: {
        node: { kind: "event", eventId: String(row["event_id"]) },
        createdAt: String(row["created_at"]),
        summary: row["message"] == null ? String(row["kind"]) : String(row["message"]),
      },
    }));
  }

  private traceBlameRange(
    appliedChangeId: string,
    segment: {
      rootStart: number;
      rootEnd: number;
      currentStart: number;
      currentEnd: number;
      coordinateKind: "utf16" | "byte";
      path: Row[];
      visited: Set<string>;
    },
    maximumSpans: number
  ): Row[] {
    if (maximumSpans <= 0) return [];
    if (segment.path.length >= 200) {
      throw new SemanticVcsError("ScopeTooLarge", "Blame lineage exceeds its edge bound", {
        maximum: 200,
      });
    }
    const visit = `${appliedChangeId}:${segment.currentStart}:${segment.currentEnd}`;
    if (segment.visited.has(visit)) {
      throw new SemanticVcsError("IntegrityFailure", "Content lineage contains a cycle");
    }
    const visited = new Set(segment.visited).add(visit);
    const current = this.appliedChangeMetadata(appliedChangeId);
    const routes: Array<{
      relation: "preserves-content" | "copies-content" | "incorporates-content";
      parentAppliedChangeId: string;
      mappings: ContentMapping[];
    }> = [];
    const contentEdges = this.deps.sql
      .exec(
        `SELECT content_edge_id, parent_applied_change_id, relation
           FROM gad_content_edges
          WHERE child_applied_change_id = ?
          ORDER BY content_edge_id`,
        appliedChangeId
      )
      .toArray() as Row[];
    for (const edge of contentEdges) {
      routes.push({
        relation:
          edge["relation"] === "incorporates"
            ? "incorporates-content"
            : edge["relation"] === "copies"
              ? "copies-content"
              : "preserves-content",
        parentAppliedChangeId: String(edge["parent_applied_change_id"]),
        mappings: this.contentMappings(String(edge["content_edge_id"])),
      });
    }

    const routed: Array<{
      childStart: number;
      childEnd: number;
      parentStart: number;
      parentEnd: number;
      route: (typeof routes)[number];
    }> = [];
    for (const route of routes) {
      for (const mapping of route.mappings) {
        if (mapping.coordinateKind !== segment.coordinateKind) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Content mapping ${mapping.digest} uses the wrong coordinate space`
          );
        }
        const childStart = Math.max(segment.currentStart, mapping.childStart);
        const childEnd = Math.min(segment.currentEnd, mapping.childEnd);
        if (childStart >= childEnd) continue;
        if (mapping.childEnd - mapping.childStart !== mapping.parentEnd - mapping.parentStart) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Content mapping ${mapping.digest} changes coordinate length`
          );
        }
        const parentStart = mapping.parentStart + childStart - mapping.childStart;
        routed.push({
          childStart,
          childEnd,
          parentStart,
          parentEnd: parentStart + childEnd - childStart,
          route,
        });
      }
    }
    routed.sort(
      (left, right) => left.childStart - right.childStart || left.childEnd - right.childEnd
    );
    for (let index = 1; index < routed.length; index += 1) {
      if (routed[index]!.childStart < routed[index - 1]!.childEnd) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Applied change ${appliedChangeId} has overlapping blame routes`
        );
      }
    }
    const importTerminal = current.workKind === "import";
    const terminal = (start: number, end: number): Row => ({
      start: segment.rootStart + (start - segment.currentStart),
      end: segment.rootStart + (end - segment.currentStart),
      change: { kind: "change", changeId: current.changeId },
      appliedChange: {
        kind: "applied-change",
        appliedChangeId: current.appliedChangeId,
      },
      workUnit: { kind: "work-unit", workUnitId: current.workUnitId },
      command: { kind: "command", commandId: current.commandId },
      path: segment.path,
      stop: importTerminal ? "import-boundary" : "authored",
    });
    if (routed.length === 0) return [terminal(segment.currentStart, segment.currentEnd)];
    const result: Row[] = [];
    let cursor = segment.currentStart;
    for (const route of routed) {
      if (cursor < route.childStart) {
        result.push(terminal(cursor, route.childStart));
        if (result.length >= maximumSpans) return result;
      }
      const parent = this.appliedChangeMetadata(route.route.parentAppliedChangeId);
      const rootStart = segment.rootStart + route.childStart - segment.currentStart;
      result.push(
        ...this.traceBlameRange(
          route.route.parentAppliedChangeId,
          {
            rootStart,
            rootEnd: rootStart + route.childEnd - route.childStart,
            currentStart: route.parentStart,
            currentEnd: route.parentEnd,
            coordinateKind: segment.coordinateKind,
            path: [
              ...segment.path,
              {
                kind: route.route.relation,
                from: {
                  kind: "applied-change",
                  appliedChangeId: current.appliedChangeId,
                },
                to: {
                  kind: "applied-change",
                  appliedChangeId: parent.appliedChangeId,
                },
              },
            ],
            visited,
          },
          maximumSpans - result.length
        )
      );
      if (result.length >= maximumSpans) return result;
      cursor = route.childEnd;
    }
    if (cursor < segment.currentEnd && result.length < maximumSpans) {
      result.push(terminal(cursor, segment.currentEnd));
    }
    return result;
  }

  private appliedChangeMetadata(appliedChangeId: string): {
    appliedChangeId: string;
    changeId: string;
    workUnitId: string;
    commandId: string;
    kind: string;
    workKind: string;
  } {
    const row = this.deps.sql
      .exec(
        `SELECT applied.applied_change_id, change.change_id, change.kind,
                change.work_unit_id, work.command_id, work.kind AS work_kind
           FROM gad_applied_changes applied
           JOIN gad_changes change ON change.change_id = applied.change_id
           JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
          WHERE applied.applied_change_id = ?`,
        appliedChangeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Content lineage reaches missing applied change ${appliedChangeId}`
      );
    }
    return {
      appliedChangeId,
      changeId: String(row["change_id"]),
      workUnitId: String(row["work_unit_id"]),
      commandId: String(row["command_id"]),
      kind: String(row["kind"]),
      workKind: String(row["work_kind"]),
    };
  }

  private contentEndpoint(endpoint: Row | null): {
    fileId: string;
    contentHash: string;
    coordinateKind: "utf16" | "byte";
    coordinateExtent: number;
  } | null {
    if (
      endpoint?.["kind"] !== "file" ||
      typeof endpoint["fileId"] !== "string" ||
      typeof endpoint["contentHash"] !== "string" ||
      (endpoint["contentKind"] !== "text" && endpoint["contentKind"] !== "bytes") ||
      typeof endpoint["coordinateExtent"] !== "number"
    ) {
      return null;
    }
    return {
      fileId: endpoint["fileId"],
      contentHash: endpoint["contentHash"],
      coordinateKind: endpoint["contentKind"] === "text" ? "utf16" : "byte",
      coordinateExtent: endpoint["coordinateExtent"],
    };
  }

  private appliedContentEndpoint(appliedChangeId: string): {
    fileId: string;
    contentHash: string;
    coordinateKind: "utf16" | "byte";
    coordinateExtent: number;
  } | null {
    const row = this.deps.sql
      .exec(
        `SELECT applied_base_json, applied_result_json
           FROM gad_applied_changes WHERE applied_change_id = ?`,
        appliedChangeId
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Missing applied change ${appliedChangeId} while deriving content lineage`
      );
    }
    const result =
      row["applied_result_json"] == null
        ? null
        : (JSON.parse(String(row["applied_result_json"])) as Row);
    const base =
      row["applied_base_json"] == null
        ? null
        : (JSON.parse(String(row["applied_base_json"])) as Row);
    return this.contentEndpoint(result) ?? this.contentEndpoint(base);
  }

  private contentMappings(contentEdgeId: string): ContentMapping[] {
    return (
      this.deps.sql
        .exec(
          `SELECT coordinate_kind, child_content_hash, child_start, child_end,
                  parent_content_hash, parent_start, parent_end, digest
             FROM gad_content_edge_mappings WHERE content_edge_id = ? ORDER BY ordinal`,
          contentEdgeId
        )
        .toArray() as Row[]
    ).map(contentMappingFromRow);
  }

  /** A text counteraction restores the original base bytes, so its exact
   * unchanged-coordinate lineage is the original text edge in reverse. The
   * original edge is durable semantic evidence; reconstructing edit text or
   * diffing blobs here would create a second, weaker source of truth. */
  private invertedCounteractionMappings(
    counteractedChangeIds: readonly string[],
    child: {
      contentHash: string;
      coordinateKind: "utf16" | "byte";
      coordinateExtent: number;
    },
    parent: {
      contentHash: string;
      coordinateKind: "utf16" | "byte";
      coordinateExtent: number;
    }
  ): ContentMapping[] {
    if (counteractedChangeIds.length !== 1) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        "A text counteraction must name exactly one original change"
      );
    }
    const row = this.deps.sql
      .exec(
        `SELECT edge.content_edge_id
           FROM gad_content_edges edge
           JOIN gad_applied_changes applied
             ON applied.applied_change_id = edge.child_applied_change_id
          WHERE applied.change_id = ?
            AND edge.relation = 'incorporates'
            AND json_extract(applied.applied_result_json, '$.contentHash') = ?
            AND json_extract(applied.applied_base_json, '$.contentHash') = ?
          ORDER BY edge.content_edge_id
          LIMIT 1`,
        counteractedChangeIds[0],
        parent.contentHash,
        child.contentHash
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Counteracted text change ${counteractedChangeIds[0]} has no exact content lineage`
      );
    }
    return this.contentMappings(String(row["content_edge_id"])).map((mapping) => {
      if (
        mapping.coordinateKind !== child.coordinateKind ||
        mapping.coordinateKind !== parent.coordinateKind ||
        mapping.childContentHash !== parent.contentHash ||
        mapping.parentContentHash !== child.contentHash
      ) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Counteracted text change ${counteractedChangeIds[0]} has mismatched content lineage`
        );
      }
      return contentMapping({
        coordinateKind: mapping.coordinateKind,
        childContentHash: mapping.parentContentHash,
        childStart: mapping.parentStart,
        childEnd: mapping.parentEnd,
        parentContentHash: mapping.childContentHash,
        parentStart: mapping.childStart,
        parentEnd: mapping.childEnd,
      });
    });
  }

  private latestAppliedChangeForFile(
    state: StateNodeRef,
    fileId: string
  ):
    | (Row & {
        changeId: string;
        appliedChangeId: string;
        workUnitId: string;
        commandId: string;
        kind: string;
      })
    | null {
    const applications = this.firstParentLineage(state).applicationIds;
    const row = this.deps.sql
      .exec(
        `SELECT applied.applied_change_id, change.change_id, change.kind,
              change.work_unit_id, work.command_id
         FROM json_each(?) selected
         JOIN gad_applied_changes applied
           ON applied.application_id = CAST(selected.value AS TEXT)
         JOIN gad_changes change ON change.change_id = applied.change_id
         JOIN gad_work_units work ON work.work_unit_id = change.work_unit_id
        WHERE EXISTS (
                SELECT 1 FROM gad_change_coordinates coordinate
                 WHERE coordinate.change_id = change.change_id
                   AND coordinate.file_id = ?
              )
           OR EXISTS (
                SELECT 1 FROM gad_applied_change_predicates predicate
                 WHERE predicate.applied_change_id = applied.applied_change_id
                   AND json_extract(predicate.predicate_json, '$.fileId') = ?
              )
        ORDER BY CAST(selected.key AS INTEGER) DESC, applied.ordinal DESC LIMIT 1`,
        canonicalJson(applications),
        fileId,
        fileId
      )
      .toArray()[0] as Row | undefined;
    return row
      ? {
          ...row,
          changeId: String(row["change_id"]),
          appliedChangeId: String(row["applied_change_id"]),
          workUnitId: String(row["work_unit_id"]),
          commandId: String(row["command_id"]),
          kind: String(row["kind"]),
        }
      : null;
  }
}

function readApplicationChain(sql: SqlStorage, tail: string, max: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | null = tail;
  while (current) {
    if (result.length >= max)
      throw new SemanticVcsError("ScopeTooLarge", "Application chain is too large");
    if (seen.has(current))
      throw new SemanticVcsError("IntegrityFailure", "Application chain is cyclic");
    seen.add(current);
    result.push(current);
    const row = sql
      .exec(
        `SELECT basis_kind, basis_id FROM gad_work_unit_applications WHERE application_id = ?`,
        current
      )
      .toArray()[0] as Row | undefined;
    if (!row) throw new SemanticVcsError("IntegrityFailure", `Missing application ${current}`);
    current = row["basis_kind"] === "application" ? String(row["basis_id"]) : null;
  }
  return result.reverse();
}
