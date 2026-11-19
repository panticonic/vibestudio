import { createHash } from "node:crypto";
import { compareUtf16CodeUnits, sha256HexSyncText } from "@vibestudio/content-addressing";
import {
  vcsBlameResultSchema,
  vcsCompareResultSchema,
  vcsHistoryResultSchema,
  vcsInspectResultSchema,
  vcsListDirectoryResultSchema,
  vcsListFilesResultSchema,
  vcsMergeResultSchema,
  vcsNeighborsResultSchema,
  vcsResolveRepositoryResultSchema,
  vcsStateNodeRefSchema,
  vcsSemanticNodeRefSchema,
  vcsStatusResultSchema,
  vcsWorkingMutationResultSchema,
  type VcsBlameInput,
  type VcsCompareInput,
  type VcsCopyInput,
  type VcsDiscardInput,
  type VcsEditInput,
  type VcsHistoryInput,
  type VcsInspectInput,
  type VcsListDirectoryInput,
  type VcsListFilesInput,
  type VcsMergeInput,
  type VcsNeighborsInput,
  type VcsProvenanceEdge,
  type VcsReadFilesInput,
  type VcsMoveInput,
  type VcsResolveRepositoryInput,
  type VcsSemanticNodeRef,
  type VcsStateNodeRef,
  type VcsStatusResult,
  type VcsTrajectorySenderRef,
  type VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import { GadJsonRecordSchema, semanticFileHostReadSchema } from "@vibestudio/service-schemas/workspaceSource";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { WorkspaceMaterializationRepositorySchema } from "@vibestudio/shared/vcs/workspaceProjection";
import { z } from "zod";
import { WorkspaceTemplateInstallationSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { DODispatch } from "../doDispatch.js";
import { getBytes, putBytes } from "../services/blobstoreService.js";
import type { CanonicalRefPublication } from "../services/protectedRefStore.js";
import { withBlobContentLock } from "../storage/blobRetentions.js";
import type { WorkspaceSourceProviderRef } from "../workspaceSourceProvider.js";

const head = z.string().min(1);
const reservationSchema = z
  .object({
    targetId: z.string().min(1),
    head,
    origin: z.object({ ref: z.string().min(1), token: z.string().min(1) }).strict(),
  })
  .strict();

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const historyForkSeed = z.object({
  branch: z.string().regex(/^fork\/[0-9a-f]{64}$/u),
  head,
  state: vcsStateNodeRefSchema,
}).strict();
const retainedParticipantKeys = z.array(z.string().regex(/^work-[0-9a-f]{64}$/u));
const retainedContentHashes = z.array(digest);
const blob = z.object({ contentHash: digest, base64: z.string() }).strict();
const causeSchema = z
  .object({
    parent: z
      .object({
        logId: z.string().min(1),
        head,
        invocationId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
const mutationPlan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read-content"), contentHashes: z.array(digest).min(1) }).strict(),
  z
    .object({
      kind: z.literal("committed"),
      head,
      result: vcsWorkingMutationResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("planned"),
      command: z
        .object({
          commandId: z.string().min(1),
          method: z.enum(["edit", "move", "copy"]),
          requestDigest: z.string().min(1),
          cause: causeSchema,
        })
        .strict(),
      application: GadJsonRecordSchema,
      blobs: z.array(blob),
      result: vcsWorkingMutationResultSchema.omit({ workingHead: true }),
    })
    .strict(),
]);
const appliedEdit = z.object({ head, value: vcsStateNodeRefSchema }).strict();
const mergeReply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read-content"), contentHashes: z.array(digest).min(1) }).strict(),
  z.object({ kind: z.literal("prepare-content"), blobs: z.array(blob).min(1) }).strict(),
  appliedEdit.extend({ kind: z.literal("committed"), result: vcsMergeResultSchema }).strict(),
]);
const historyMergeSelection = z.union([
  z.object({ head, base: head, main: head }).strict(),
  z.object({
    head, base: head,
    source: z.object({ contextId: z.string().min(1), head }).strict(),
  }).strict(),
]);
const mergeReview = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read-content"), contentHashes: z.array(digest).min(1) }).strict(),
  z.object({ kind: z.literal("reviewed"), result: vcsCompareResultSchema }).strict(),
]);
const workspaceProjection = z
  .object({
    head,
    state: vcsStateNodeRefSchema,
    repositories: z.array(WorkspaceMaterializationRepositorySchema),
  })
  .strict();
const workspaceContentProjection = workspaceProjection.omit({ head: true });
const changedLocations = z.object({
  target: vcsStateNodeRefSchema,
  source: vcsStateNodeRefSchema,
  locations: z.array(z.object({ kind: z.enum(["file", "folder"]), path: z.string() }).strict()),
}).strict();

export async function readWorkspaceParticipantProjection(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  owner: WorkspaceSourceProviderRef;
  contextId: string;
}) {
  return workspaceProjection.parse(
    await input.dispatch.dispatch(input.owner, "readHistoryProjection", {
      contextId: input.contextId,
    })
  );
}

export async function rememberWorkspaceParticipantContentSource(input: WorkspaceHistoryParticipant & {
  contextId: string;
  stateHash: string;
  state: VcsStateNodeRef;
}): Promise<void> {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, stateHash, state } = input;
  await dispatch.dispatch(owner, "rememberHistoryContentSource", { contextId, stateHash, state });
}

export async function readWorkspaceParticipantContentSource(input: WorkspaceHistoryParticipant & {
  contextId: string;
  stateHash: string;
  readableContextIds?: readonly string[];
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, stateHash } = input;
  const readableContextIds = [...new Set(input.readableContextIds)].filter((id) => id !== contextId);
  return workspaceContentProjection.nullable().parse(await dispatch.dispatch(owner, "readHistoryContentSource", {
    contextId, stateHash, ...(readableContextIds.length ? { readableContextIds } : {}),
  }));
}

/** Read shared ancestry and edits from the verified participant's own context. */
export async function readWorkspaceParticipantStatus(input: WorkspaceHistoryParticipant & {
  contextId: string;
}): Promise<VcsStatusResult> {
  requireWorkspaceParticipantOwner(input);
  const status = vcsStatusResultSchema.parse(
    await input.dispatch.dispatch(input.owner, "readHistoryStatus", { contextId: input.contextId })
  );
  if (status.contextId !== input.contextId)
    throw new Error("Workspace status belongs to a different context");
  return status;
}

/** Check exact references through contexts the host has already admitted for this caller. */
export async function workspaceParticipantReferencesReachable(input: WorkspaceHistoryParticipant & {
  contextIds: readonly string[];
  references: readonly { kind: string; value: unknown }[];
}): Promise<boolean> {
  requireWorkspaceParticipantOwner(input);
  const references = [];
  for (const reference of input.references) {
    const parsed = historyReference(reference);
    if (!parsed.success) return false;
    references.push(parsed.data);
  }
  return z.boolean().parse(await input.dispatch.dispatch(input.owner, "readHistoryReferenceVisibility", {
    contextIds: [...new Set(input.contextIds)],
    references,
  }));
}

function historyReference({ kind, value }: { kind: string; value: unknown }) {
  switch (kind) {
    case "event": return vcsSemanticNodeRefSchema.safeParse({ kind, eventId: value });
    case "external-delta": return vcsSemanticNodeRefSchema.safeParse({ kind, deltaId: value });
    case "state-node": return vcsStateNodeRefSchema.safeParse(value);
    case "node": return vcsSemanticNodeRefSchema.safeParse(value);
    default: return { success: false } as const;
  }
}

/** Select the actual branch containing a reference within one participant's admitted context graph. */
export async function workspaceParticipantReferenceContext(input: WorkspaceHistoryParticipant & {
  contextId: string;
  readableContextIds: readonly string[];
  reference: { kind: string; value: unknown };
}): Promise<string> {
  requireWorkspaceParticipantOwner(input);
  const contextIds = [...new Set([input.contextId, ...input.readableContextIds])];
  if (contextIds.length === 1) return input.contextId;
  const reference = historyReference(input.reference);
  if (!reference.success) throw new Error("Workspace read requires an exact reference");
  const result = z.string().min(1).nullable().parse(await input.dispatch.dispatch(
    input.owner, "readHistoryReferenceContext", { contextIds, reference: reference.data },
  ));
  if (result !== null && !contextIds.includes(result))
    throw new Error("Workspace read selected an unauthorized context");
  return result ?? input.contextId;
}

/** A reset removes the discarded application from normal reference visibility. */
export async function hasWorkspaceParticipantDiscardReceipt(input: WorkspaceHistoryParticipant & {
  discard: VcsDiscardInput;
  cause: z.infer<typeof causeSchema>;
}): Promise<boolean> {
  requireWorkspaceParticipantOwner(input);
  return z.boolean().parse(await input.dispatch.dispatch(
    input.owner, "hasHistoryDiscardReceipt", { discard: input.discard, cause: input.cause },
  ));
}

/** Inspect the exact admitted provenance node and its immediate relationships. */
export async function inspectWorkspaceParticipantProvenance(input: WorkspaceHistoryParticipant & {
  contextId: string;
  inspect: VcsInspectInput;
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, inspect } = input;
  const result = vcsInspectResultSchema.parse(
    await dispatch.dispatch(owner, "inspectHistoryNode", { contextId, inspect }),
  );
  const sameNode =
    (inspect.node.kind === "event" && result.node.kind === "event" &&
      result.node.value.eventId === inspect.node.eventId && "revision" in result.node.value) ||
    (inspect.node.kind === "application" && result.node.kind === "application" &&
      result.node.value.applicationId === inspect.node.applicationId && "revision" in result.node.value) ||
    (inspect.node.kind === "change" && result.node.kind === "change" &&
      result.node.value.changeId === inspect.node.changeId) ||
    (inspect.node.kind === "applied-change" && result.node.kind === "applied-change" &&
      result.node.value.appliedChangeId === inspect.node.appliedChangeId) ||
    (inspect.node.kind === "decision" && result.node.kind === "decision" &&
      result.node.value.decisionId === inspect.node.decisionId) ||
    (inspect.node.kind === "external-delta" && result.node.kind === "external-delta" &&
      result.node.value.deltaId === inspect.node.deltaId) ||
    (inspect.node.kind === "file" && result.node.kind === "file" &&
      canonicalJson(result.node.state) === canonicalJson(inspect.node.state) &&
      result.node.value.fileId === inspect.node.fileId &&
      (result.node.value.kind === "tombstone" || result.node.value.repositoryId === inspect.node.repositoryId)) ||
    (inspect.node.kind === "repository" && result.node.kind === "repository" &&
      canonicalJson(result.node.state) === canonicalJson(inspect.node.state) &&
      result.node.value.repositoryId === inspect.node.repositoryId) ||
    (inspect.node.kind === "work-unit" && result.node.kind === "work-unit" &&
      result.node.value.workUnitId === inspect.node.workUnitId) ||
    (inspect.node.kind === "command" && result.node.kind === "command" &&
      result.node.value.commandId === inspect.node.commandId);
  if (!sameNode) throw new Error("Workspace history returned different provenance");
  requireWorkspaceProvenanceEdges(inspect.node, result, inspect.edgeLimit);
  return result;
}

export async function readWorkspaceParticipantNeighbors(input: WorkspaceHistoryParticipant & {
  contextId: string;
  neighbors: VcsNeighborsInput;
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, neighbors } = input;
  const result = vcsNeighborsResultSchema.parse(
    await dispatch.dispatch(owner, "readHistoryNeighbors", { contextId, neighbors }),
  );
  requireWorkspaceProvenanceEdges(neighbors.root, result, neighbors.limit);
  return result;
}

export async function readWorkspaceParticipantBlame(input: WorkspaceHistoryParticipant & {
  contextId: string;
  blame: VcsBlameInput;
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, blame } = input;
  const result = vcsBlameResultSchema.parse(
    await dispatch.dispatch(owner, "readHistoryBlame", { contextId, blame }),
  );
  if (canonicalJson(result.state) !== canonicalJson(blame.state) ||
      result.fileId !== blame.fileId || result.spans.length > blame.limit) {
    throw new Error("Workspace history returned different content lineage");
  }
  let last = blame.range.start;
  for (const span of result.spans) {
    if (span.start < last || span.end > blame.range.end)
      throw new Error("Workspace history returned content lineage outside the requested range");
    last = span.end;
  }
  return result;
}

export async function readWorkspaceParticipantHistory(input: WorkspaceHistoryParticipant & {
  contextId: string;
  history: VcsHistoryInput;
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, history } = input;
  const result = vcsHistoryResultSchema.parse(
    await dispatch.dispatch(owner, "readHistoryTimeline", { contextId, history }),
  );
  const expectedEntryKind = history.root.kind === "event" ? "event" : "change";
  if (canonicalJson(result.root) !== canonicalJson(history.root) ||
      result.entries.length > history.limit ||
      result.entries.some(({ node }) => node.kind !== expectedEntryKind)) {
    throw new Error("Workspace history returned a different timeline");
  }
  return result;
}

function requireWorkspaceProvenanceEdges(
  requested: VcsSemanticNodeRef,
  { root, edges }: { root: VcsSemanticNodeRef; edges: readonly VcsProvenanceEdge[] },
  limit: number,
) {
  const expected = canonicalJson(requested);
  if (canonicalJson(root) !== expected || edges.length > limit ||
      edges.some(({ from, to }) => canonicalJson(from) !== expected && canonicalJson(to) !== expected)) {
    throw new Error("Workspace history returned different provenance");
  }
}

export async function readWorkspacePublishedRevision(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  eventId: string;
}) {
  return workspaceProjection.parse(
    await input.dispatch.dispatch(input.canonical, "readHistoryPublishedRevision", {
      eventId: input.eventId,
    })
  );
}

export async function readWorkspaceCanonicalMain(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
}): Promise<{ head: string; eventId: string }> {
  return z
    .object({ head, eventId: z.string().min(1) })
    .strict()
    .parse(await input.dispatch.dispatch(input.canonical, "readHistoryMain"));
}

export interface WorkspaceHistorySource {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
}

export async function workspaceMainStateReachable(
  source: WorkspaceHistorySource,
  state: VcsStateNodeRef
): Promise<boolean> {
  return z.boolean().parse(
    await source.dispatch.dispatch(source.canonical, "readHistoryMainStateVisibility", { state }),
  );
}

export async function readWorkspaceHistoryTemplateInstallation(source: WorkspaceHistorySource, eventId: string) {
  return WorkspaceTemplateInstallationSchema.nullable().parse(
    await source.dispatch.dispatch(source.canonical, "readHistoryTemplateInstallation", { eventId }),
  );
}

export interface WorkspaceHistoryParticipant extends WorkspaceHistorySource {
  owner: WorkspaceSourceProviderRef;
  caller: VerifiedCaller;
  ownerContextId?: string | undefined;
}

function participantStorage(canonical: WorkspaceSourceProviderRef, participantId: string) {
  const owner = { ...canonical, objectKey: `work-${sha256HexSyncText(participantId)}` };
  const targetId = canonicalEntityId({
    kind: "do", source: owner.source, className: owner.className, key: owner.objectKey,
  });
  return { owner, targetId };
}

/** The host has verified authority over the source and admitted the destination lifetime. */
export async function forkWorkspaceParticipantContext(input: WorkspaceHistoryParticipant & {
  contextId: string;
  child: { caller: VerifiedCaller; ownerContextId: string; contextId: string };
  blobsDir: string;
}): Promise<VcsStateNodeRef> {
  const { dispatch, canonical, owner, child } = input;
  const fromParticipant = requireWorkspaceParticipantOwner(input);
  if (!input.contextId || !child.contextId || child.contextId === input.contextId) {
    throw new Error("Workspace fork requires distinct source and target contexts");
  }
  const participantId = workspaceParticipantIdentity(child.caller, child.ownerContextId);
  const target = participantStorage(canonical, participantId);
  const fromPeer = participantStorage(canonical, fromParticipant).targetId;
  const reservation = reservationSchema.parse(await dispatch.dispatch(canonical, "reserveHistoryParticipant", {
    participantId,
    contextId: participantId === fromParticipant ? input.ownerContextId : child.ownerContextId,
    workingContextId: child.contextId,
  }));
  if (reservation.targetId !== target.targetId)
    throw new Error("Workspace fork reserved a different storage peer");
  const request = { parentContextId: input.contextId, childContextId: child.contextId, childPeer: target.targetId };
  return withBlobContentLock(input.blobsDir, async () => {
    const { seed, token } = z.object({
      seed: historyForkSeed,
      token: z.string().min(1).nullable(),
    }).strict().parse(await dispatch.dispatch(owner, "offerHistoryContextFork", request));
    const accepted = historyForkSeed.parse(await dispatch.dispatch(target.owner, "acceptHistoryContextFork", {
      participantId, origin: reservation.origin, request, seed, token, fromPeer,
    }));
    if (canonicalJson(accepted) !== canonicalJson(seed))
      throw new Error("Workspace fork accepted a different revision");
    await dispatch.dispatch(owner, "finishHistoryContextFork", { request, seed });
    return seed.state;
  });
}

/** Read exact file metadata without accessing content bytes. */
export async function readWorkspaceParticipantFileDescriptors(input: WorkspaceHistoryParticipant & {
  contextId: string;
  read: VcsReadFilesInput;
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId, read } = input;
  const files = semanticFileHostReadSchema.nullable().array().max(500).parse(
    await dispatch.dispatch(owner, "readHistoryFiles", { contextId, read })
  );
  if (files.length !== read.files.length) {
    throw new Error("Workspace history returned a different number of file results");
  }
  const state = canonicalJson(read.state);
  for (const [index, selector] of read.files.entries()) {
    const file = files[index];
    if (file === null) continue;
    if (!file || canonicalJson(file.state) !== state || file.repositoryId !== selector.repositoryId ||
        (selector.file.kind === "id" ? file.fileId !== selector.file.fileId : file.path !== selector.file.path)) {
      throw new Error("Workspace history returned a different file selection");
    }
  }
  return files;
}

/** Bind the catalog reads to the admitted copy and verify their exact revision. */
export function workspaceParticipantCatalog(input: WorkspaceHistoryParticipant & {
  contextId: string;
  readableContextIds?: readonly string[];
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, contextId } = input;
  const verify = <T extends { state: VcsStateNodeRef } | null>(result: T, state: VcsStateNodeRef) => {
    if (result && canonicalJson(result.state) !== canonicalJson(state)) {
      throw new Error("Workspace catalog returned a different revision");
    }
    return result;
  };
  const locations = async (
    method: "readHistoryChangedLocations" | "readHistoryMergeLocations",
    target: VcsStateNodeRef,
    source: VcsStateNodeRef,
  ) => {
    const result = changedLocations.parse(await dispatch.dispatch(owner, method, {
      contextId, target, source,
      ...(method === "readHistoryMergeLocations" ? { readableContextIds: input.readableContextIds ?? [] } : {}),
    }));
    if (canonicalJson([result.target, result.source]) !== canonicalJson([target, source])) {
      throw new Error("Workspace changes belong to different revisions");
    }
    return result.locations;
  };
  return {
    changedLocations: (target: VcsStateNodeRef, source: VcsStateNodeRef) =>
      locations("readHistoryChangedLocations", target, source),
    mergeLocations: (target: VcsStateNodeRef, source: VcsStateNodeRef) =>
      locations("readHistoryMergeLocations", target, source),
    async repositoryPath(state: VcsStateNodeRef, repositoryId: string) {
      const result = verify(vcsResolveRepositoryResultSchema.parse(
        await dispatch.dispatch(owner, "readHistoryRepositoryLocation", { contextId, state, repositoryId })
      ), state);
      if (result && result.repositoryId !== repositoryId)
        throw new Error("Workspace catalog returned a different repository identity");
      return result?.repoPath ?? null;
    },
    async resolveRepository(repository: VcsResolveRepositoryInput) {
      const result = verify(vcsResolveRepositoryResultSchema.parse(
        await dispatch.dispatch(owner, "resolveHistoryRepository", { contextId, repository })
      ), repository.state);
      if (result && result.repoPath !== repository.repoPath)
        throw new Error("Workspace catalog returned a different repository path");
      return result;
    },
    async listFiles(list: VcsListFilesInput) {
      const { prefix } = list;
      const result = verify(vcsListFilesResultSchema.parse(
        await dispatch.dispatch(owner, "listHistoryFiles", { contextId, list })
      ), list.state);
      if (result.repositoryId !== list.repositoryId || result.files.length > list.limit ||
          (prefix && result.files.some(({ path }) => !path.startsWith(prefix)))) {
        throw new Error("Workspace catalog returned a different file scope");
      }
      return result;
    },
    async listDirectory(list: VcsListDirectoryInput) {
      const result = verify(vcsListDirectoryResultSchema.parse(
        await dispatch.dispatch(owner, "listHistoryDirectory", { contextId, list })
      ), list.state);
      const prefix = list.path ? `${list.path}/` : "";
      if (result && (result.path !== list.path || result.entries.length > list.limit ||
          result.entries.some(({ name, path }) => path !== prefix + name))) {
        throw new Error("Workspace catalog returned a different directory scope");
      }
      return result;
    },
  };
}

/** Read private roots before canonical roots so retirement preserves saved history in either location. */
export async function collectWorkspaceHistoryContentRoots(input: WorkspaceHistorySource): Promise<Set<string>> {
  const { dispatch, canonical } = input;
  const participants = async () => retainedParticipantKeys.parse(
    await dispatch.dispatch(canonical, "listHistoryRetainedParticipants")
  );
  const read = async (owner: WorkspaceSourceProviderRef) => retainedContentHashes.parse(
    await dispatch.dispatch(owner, "readHistoryContentRoots")
  );
  const roots = new Set<string>();
  for (const objectKey of new Set(await participants())) {
    try {
      for (const hash of await read({ ...canonical, objectKey })) roots.add(hash);
    } catch (error) {
      if ((await participants()).includes(objectKey)) throw error;
    }
  }
  for (const hash of await read(canonical)) roots.add(hash);
  return roots;
}

/** Store every prepared blob before its owner can commit a reference to it. */
export async function putPreparedWorkspaceContent(
  blobsDir: string,
  blobs: readonly z.infer<typeof blob>[]
): Promise<string[]> {
  const seen = new Set<string>();
  const prepared = blobs.map(({ contentHash, base64 }) => {
    if (!digest.safeParse(contentHash).success) {
      throw new Error("semantic content preparation contains an invalid content identity");
    }
    if (seen.has(contentHash))
      throw new Error(`semantic content preparation repeats ${contentHash}`);
    seen.add(contentHash);
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) {
      throw new Error(`semantic content preparation has invalid bytes for ${contentHash}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== contentHash) {
      throw new Error(`semantic content preparation bytes do not match ${contentHash}`);
    }
    return bytes;
  });
  await Promise.all(prepared.map((bytes) => putBytes(blobsDir, bytes)));
  return [...seen].sort(compareUtf16CodeUnits);
}

interface ParticipantMutationTarget {
  dispatch: Pick<DODispatch, "dispatch">;
  owner: WorkspaceSourceProviderRef;
  head: string;
  cause: z.infer<typeof causeSchema>;
  triggerEvidence?: { text: string; sender: VcsTrajectorySenderRef } | null;
  blobsDir: string;
}

export type ParticipantTransfer =
  | { method: "move"; value: VcsMoveInput }
  | { method: "copy"; value: VcsCopyInput };

/** Execute an edit with host-owned content, after admission has fixed the participant owner. */
export function editWorkspaceParticipant(input: ParticipantMutationTarget & { edit: VcsEditInput }) {
  return mutateWorkspaceParticipant(input, { method: "edit", value: input.edit });
}

/** Apply an admitted exact move or copy with its original content provenance. */
export function transferWorkspaceParticipant(input: ParticipantMutationTarget & { transfer: ParticipantTransfer }) {
  return mutateWorkspaceParticipant(input, input.transfer);
}

async function mutateWorkspaceParticipant(
  input: ParticipantMutationTarget,
  request: ParticipantTransfer | { method: "edit"; value: VcsEditInput },
): Promise<{ head: string; result: VcsWorkingMutationResult }> {
  const { dispatch, owner, cause, blobsDir } = input;
  const { value, method } = request;
  const common = {
    head: input.head,
    cause,
    ...(input.triggerEvidence === undefined ? {} : { triggerEvidence: input.triggerEvidence }),
  };
  const requestPlan = async (receipt: { files: z.infer<typeof blob>[] } | null) =>
    mutationPlan.parse(method === "edit"
      ? await dispatch.dispatch(owner, "planHistoryEdit", { ...common, edit: value, receipt })
      : await dispatch.dispatch(owner, "planHistoryTransfer", { ...common, transfer: request })
    );
  const checkResult = (result: VcsWorkingMutationResult) => {
    if (
      result.commandId !== value.commandId ||
      result.contextId !== value.contextId ||
      result.workingHead.kind !== "application" ||
      result.applicationId !== result.workingHead.applicationId
    ) {
      throw new Error("Workspace mutation returned a different application");
    }
  };
  let plan = await requestPlan(null);
  if (plan.kind === "read-content") {
    if (method !== "edit") throw new Error("Workspace transfer requested new content");
    const files = await Promise.all(
      plan.contentHashes.map(async (contentHash) => {
        const bytes = await getBytes(blobsDir, contentHash);
        if (!bytes) throw new Error(`semantic content blob ${contentHash} is missing`);
        return { contentHash, base64: bytes.toString("base64") };
      })
    );
    plan = await requestPlan({ files });
  }
  if (plan.kind === "read-content") throw new Error("Workspace mutation repeated its content request");
  if (plan.kind === "committed") {
    checkResult(plan.result);
    return { head: plan.head, result: plan.result };
  }
  if (
    plan.command.commandId !== value.commandId ||
    plan.command.method !== method ||
    canonicalJson(plan.command.cause) !== canonicalJson(cause) ||
    plan.result.commandId !== value.commandId ||
    plan.result.contextId !== value.contextId
  ) {
    throw new Error("Workspace mutation plan belongs to a different command");
  }
  const prepared = plan;
  const applied = await withBlobContentLock(blobsDir, async () => {
    await putPreparedWorkspaceContent(blobsDir, prepared.blobs);
    return appliedEdit.parse(
      await dispatch.dispatch(owner, "applyHistoryApplication", {
        head: input.head,
        command: prepared.command,
        plan: prepared.application,
      })
    );
  });
  const result = { ...prepared.result, workingHead: applied.value };
  checkResult(result);
  return { head: applied.head, result };
}

async function readWorkspaceMergeObservation(blobsDir: string, contentHashes: string[]) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: Array<{ contentHash: string; text: string }> = [];
  for (const contentHash of contentHashes) {
    const bytes = await getBytes(blobsDir, contentHash);
    if (!bytes) throw new Error(`semantic merge blob ${contentHash} is missing`);
    files.push({ contentHash, text: decoder.decode(bytes) });
  }
  return { files };
}

/** Review the participant's current state against an admitted exact revision. */
export async function reviewWorkspaceParticipantMerge(input: WorkspaceHistoryParticipant & {
  contextId: string;
  compare: VcsCompareInput;
  readableContextIds?: readonly string[];
  blobsDir: string;
}) {
  requireWorkspaceParticipantOwner(input);
  const { contextId, compare, blobsDir, owner, dispatch } = input;
  const request = { contextId, compare, readableContextIds: input.readableContextIds ?? [] };
  let review = mergeReview.parse(await dispatch.dispatch(owner, "reviewHistoryMerge", request));
  if (review.kind === "read-content") {
    const observation = await readWorkspaceMergeObservation(blobsDir, review.contentHashes);
    review = mergeReview.parse(await dispatch.dispatch(owner, "reviewHistoryMerge", { ...request, observation }));
  }
  if (review.kind !== "reviewed" ||
      canonicalJson([review.result.target, review.result.source]) !== canonicalJson([compare.target, compare.source])) {
    throw new Error("Workspace history returned a different merge comparison");
  }
  return review.result;
}

/** Observe and store merge content before the participant can reference it in its native history. */
export async function mergeWorkspaceParticipantContext(input: WorkspaceHistoryParticipant & {
  selection?: { head: string; base: string } & (
    { main: string } | { source: { contextId: string; head: string; participantId?: string } }
  );
  merge: VcsMergeInput;
  readableContextIds?: readonly string[];
  cause: z.infer<typeof causeSchema>;
  triggerEvidence?: { text: string; sender: VcsTrajectorySenderRef } | null;
  blobsDir: string;
}) {
  requireWorkspaceParticipantOwner(input);
  const { dispatch, owner, merge, cause, blobsDir, triggerEvidence } = input;
  let selection = input.selection;
  if (!selection) {
    if (merge.source.kind !== "event") throw new Error("Workspace integration requires a saved event");
    const readableContextIds = input.readableContextIds ?? [];
    selection = historyMergeSelection.parse(await dispatch.dispatch(owner, "resolveHistoryMerge", {
      contextId: merge.contextId, target: merge.expectedWorkingHead, source: merge.source, readableContextIds,
    }));
    if ("source" in selection && selection.source.contextId !== merge.contextId &&
        !readableContextIds.includes(selection.source.contextId)) {
      throw new Error("Workspace integration selected an unauthorized source context");
    }
  }
  const method = "main" in selection ? "mergeHistoryMain" : "mergeHistoryContext";
  const send = async (content?: {
    observation: { files: Array<{ contentHash: string; text: string }> };
    contentHashes?: string[];
  }) => mergeReply.parse(await dispatch.dispatch(owner, method, {
    ...selection,
    merge,
    cause,
    ...(triggerEvidence === undefined ? {} : { triggerEvidence }),
    ...(content ? { content } : {}),
  }));
  let reply = await send();
  if (reply.kind === "read-content") {
    const observation = await readWorkspaceMergeObservation(blobsDir, reply.contentHashes);
    reply = await send({ observation });
    if (reply.kind === "prepare-content") {
      const { blobs } = reply;
      reply = await withBlobContentLock(blobsDir, async () => {
        const contentHashes = await putPreparedWorkspaceContent(blobsDir, blobs);
        return send({ observation, contentHashes });
      });
    }
  }
  if (reply.kind !== "committed" || reply.value.kind !== "application") {
    throw new Error("Workspace merge did not return the committed application");
  }
  if (reply.result.status !== "working" || reply.result.contextId !== merge.contextId || reply.result.commandId !== merge.commandId ||
      reply.result.applicationId !== reply.value.applicationId ||
      reply.result.decisionId !== reply.result.decisionIds[0] ||
      canonicalJson(reply.result.workingHead) !== canonicalJson(reply.value)) {
    throw new Error("Workspace merge returned a different application receipt");
  }
  return { head: reply.head, value: reply.value, result: reply.result };
}

export function workspaceParticipantIdentity(caller: VerifiedCaller, ownerContextId: string | undefined): string {
  const invocation = caller.nativeInvocation;
  if (invocation) {
    // Every tool call in the same authenticated task reuses its working copy.
    return canonicalJson(["task", invocation.owner, invocation.task]);
  }
  const userId = caller.subject?.userId;
  const execution = caller.executionSession;
  if (
    userId && ownerContextId &&
    execution?.mode === "interactive" &&
    execution.executor.kind === "dynamic-code" &&
    execution.executor.runtimeId === caller.runtime.id &&
    execution.contextId === ownerContextId &&
    execution.ownerUser === `user:${userId}` &&
    execution.agentBinding === null && execution.parent === null
  ) {
    // The host reissues task grants for individual signed evals. Their edits
    // belong to the authenticated person's persistent session context.
    return canonicalJson(["interactive-session", userId, ownerContextId]);
  }
  if (caller.taskAuthority) return canonicalJson(["task-grant", caller.taskAuthority]);
  if (userId && ownerContextId) {
    // One device can open several independent sessions with separate retirement.
    return canonicalJson(["user", userId, caller.remoteDeviceKey ?? caller.runtime.id, ownerContextId]);
  }
  throw new Error("The verified caller has no workspace participant identity");
}

export function requireWorkspaceParticipantOwner(input: Omit<WorkspaceHistoryParticipant, "dispatch">): string {
  const participantId = workspaceParticipantIdentity(input.caller, input.ownerContextId);
  const expected = { ...input.canonical, objectKey: `work-${sha256HexSyncText(participantId)}` };
  if (canonicalJson(input.owner) !== canonicalJson(expected)) {
    throw new Error("Workspace history belongs to a different participant");
  }
  return participantId;
}

const publicationApproval = z
  .object({
    publicationId: z.string().min(1),
    participantId: z.string().min(1),
    previousEventId: z.string().min(1),
    proposedEventId: z.string().min(1),
    publication: z.object({ previousHead: head, proposedHead: head }).strict(),
  })
  .strict();
const publicationReceipt = z
  .object({
    approval: publicationApproval,
    expiresAt: z.number().int().positive(),
    applied: z.boolean(),
  })
  .strict();
const publicationGrant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), head }).strict(),
  z
    .object({
      kind: z.literal("grant"),
      id: z.string().min(1),
      origin: reservationSchema.shape.origin,
    })
    .strict(),
]);

export async function readWorkspacePublicationApproval(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  publicationId: string;
}) {
  return publicationReceipt.nullable().parse(
    await input.dispatch.dispatch(input.canonical, "readHistoryPublicationApproval", {
      publicationId: input.publicationId,
    })
  );
}

export async function listAppliedWorkspacePublications(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
}) {
  return z
    .array(publicationReceipt.extend({ applied: z.literal(true) }))
    .parse(await input.dispatch.dispatch(input.canonical, "listHistoryAppliedPublications"));
}

async function readExactWorkspacePublicationApproval(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  approval: z.infer<typeof publicationApproval>;
}) {
  const receipt = await readWorkspacePublicationApproval({
    ...input,
    publicationId: input.approval.publicationId,
  });
  if (receipt && canonicalJson(receipt.approval) !== canonicalJson(input.approval)) {
    throw new Error("Workspace publication receipt names a different transition");
  }
  return receipt;
}

/** Startup recovery can project an already committed revision without authority to publish. */
export function observeAppliedWorkspacePublication(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  approval: z.infer<typeof publicationApproval>;
}): CanonicalRefPublication {
  const confirmed = async () =>
    (await readExactWorkspacePublicationApproval(input))?.applied === true;
  return {
    approved: confirmed,
    async authorize() {
      throw new Error("Publication recovery cannot issue approval");
    },
    async publish() {
      if (!(await confirmed())) throw new Error("Workspace publication has no applied revision");
    },
    async acknowledge() {
      await input.dispatch.dispatch(input.canonical, "acknowledgeHistoryPublication", {
        publicationId: input.approval.publicationId,
      });
    },
  };
}

/** The protected gate authorizes this exact native transition before it can publish. */
export function bindWorkspaceParticipantPublication(input: WorkspaceHistoryParticipant & {
  contextId: string;
  target: Omit<z.infer<typeof publicationApproval>, "participantId">;
}): CanonicalRefPublication {
  const { dispatch, canonical, owner, contextId } = input;
  const participantId = requireWorkspaceParticipantOwner(input);
  const approval = publicationApproval.parse({ ...input.target, participantId });
  const publicationId = { publicationId: approval.publicationId };
  const readApproval = () =>
    readExactWorkspacePublicationApproval({ dispatch, canonical, approval });
  return {
    async approved(): Promise<boolean> {
      const receipt = await readApproval();
      return receipt !== null && (receipt.applied || receipt.expiresAt > Date.now());
    },
    async authorize(): Promise<void> {
      await dispatch.dispatch(canonical, "authorizeHistoryPublication", approval);
    },
    async publish(): Promise<void> {
      const permit = publicationGrant.parse(
        await dispatch.dispatch(canonical, "grantHistoryPublication", publicationId)
      );
      if (permit.kind === "applied") {
        if (permit.head !== approval.publication.proposedHead || !(await readApproval())?.applied) {
          throw new Error("Workspace publication did not advance to its approved head");
        }
        return;
      }
      try {
        await dispatch.dispatch(owner, "publishApprovedHistory", {
          contextId,
          publication: approval.publication,
          proposedEventId: approval.proposedEventId,
          origin: permit.origin,
        });
      } catch (error) {
        if (!(await readApproval())?.applied) throw error;
      } finally {
        await dispatch
          .dispatch(canonical, "releaseHistoryGrant", { id: permit.id })
          .catch((error) =>
            console.warn(
              "[WorkspaceHistory] Could not release the publication grant",
              error instanceof Error ? error.message : String(error)
            )
          );
      }
      if (!(await readApproval())?.applied) {
        throw new Error("Workspace publication did not advance to its approved head");
      }
    },
    async acknowledge(): Promise<void> {
      await dispatch.dispatch(canonical, "acknowledgeHistoryPublication", publicationId);
    },
  };
}

/** Called after the host authorizes the requested context for the verified caller. */
export async function openWorkspaceParticipantContext(input: {
  dispatch: Pick<DODispatch, "dispatch">;
  canonical: WorkspaceSourceProviderRef;
  caller: VerifiedCaller;
  ownerContextId: string;
  contextId: string;
  replayedWorkingHead?: string;
  signal?: AbortSignal;
}): Promise<{ owner: WorkspaceSourceProviderRef; workingHead: string }> {
  const { dispatch, canonical, caller, ownerContextId, contextId } = input;
  if (!ownerContextId || !contextId)
    throw new Error("Workspace contexts require durable identities");
  const participantId = workspaceParticipantIdentity(caller, ownerContextId);
  const { owner, targetId } = participantStorage(canonical, participantId);
  input.signal?.throwIfAborted();
  const reservation = reservationSchema.parse(
    await dispatch.dispatch(canonical, "reserveHistoryParticipant", {
      participantId,
      contextId: ownerContextId,
      workingContextId: contextId,
    })
  );
  if (reservation.targetId !== targetId)
    throw new Error("Workspace history returned a different participant owner");
  input.signal?.throwIfAborted();
  const workingHead = head.parse(
    await dispatch.dispatch(owner, "bindHistoryContext", {
      participantId,
      origin: reservation.origin,
      contextId,
      ...(input.replayedWorkingHead === undefined ? {} : { replayedHead: input.replayedWorkingHead }),
    })
  );
  return { owner, workingHead };
}

/** Archive all storage owners whose logical context has finished retiring. */
export async function retireWorkspaceParticipantContext(input: WorkspaceHistorySource & {
  contextId: string;
}): Promise<{ owners: WorkspaceSourceProviderRef[]; branchOwners: WorkspaceSourceProviderRef[] }> {
  const { dispatch, canonical, contextId } = input;
  const receipt = z.object({
    contextId: z.string().min(1),
    targets: retainedParticipantKeys,
    branchOwners: retainedParticipantKeys.default([]),
  }).strict().parse(await dispatch.dispatch(canonical, "retireHistoryContext", { contextId }));
  const members = [...receipt.targets, ...receipt.branchOwners];
  if (receipt.contextId !== contextId || new Set(members).size !== members.length) {
    throw new Error("Workspace retirement returned a different context or allocation");
  }
  return {
    owners: receipt.targets.map((objectKey) => ({ ...canonical, objectKey })),
    branchOwners: receipt.branchOwners.map((objectKey) => ({ ...canonical, objectKey })),
  };
}
