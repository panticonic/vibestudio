import type { RpcCausalParent } from "@vibestudio/rpc";
import type { VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import type { ContextMaterializationCommand } from "@vibestudio/shared/vcs/workspaceProjection";
import type {
  InitializeExactWorkspaceSnapshotInput,
  WorkspaceSourceInitializationInspection,
} from "@vibestudio/workspace-contracts/workspaceSource";
import type { DODispatch } from "./doDispatch.js";

export interface WorkspaceSourceProviderRef {
  source: string;
  className: string;
  objectKey: string;
}

/**
 * The complete bootstrap ABI required by the generic host. Product semantic
 * operations deliberately do not enter this interface.
 */
export interface WorkspaceSourceProviderV1 {
  initializeExactSnapshot(
    input: InitializeExactWorkspaceSnapshotInput
  ): Promise<WorkspaceSourceInitializationInspection>;
  resolveSource(input: { ref: string }): Promise<{ stateHash: string }>;
  currentSource(): Promise<{ stateHash: string } | null>;
  inspectInitialization(): Promise<WorkspaceSourceInitializationInspection>;
  health(): Promise<{ ok: true; protocol: "vibestudio.workspace-source.v1" }>;
}

export interface WorkspaceSourceSemanticEffect {
  effectId: string;
  scopeKind: "context" | "workspace";
  scopeId: string;
  commandId: string;
  kind: "observe-content" | "materialize-context" | "publish-main";
  payload: Record<string, unknown>;
  payloadDigest: string;
  status: "pending";
}

export type WorkspaceSourceSemanticDispatchResult =
  | { kind: "complete"; result: unknown }
  | {
      kind: "effects-pending";
      result: unknown;
      effects: WorkspaceSourceSemanticEffect[];
    }
  | { kind: "host-read"; request: Record<string, unknown> };

export interface WorkspaceSemanticRequest {
  input: unknown;
  ingress: {
    causalParent: RpcCausalParent | null;
    contextIntegrity: {
      class: "internal" | "external";
      externalKeys: readonly string[];
    };
  };
}

/**
 * The complete host ABI of the cataloged workspace source builtin.
 * Keeping the wire method literals inside this adapter makes adding a new
 * cross-boundary operation an explicit interface change.
 */
export interface WorkspaceSemanticPort {
  contentGcRoots(): Promise<{ contentRoots: string[]; contentHashes: string[] }>;
  referencesReachable(input: {
    contextIds: readonly string[];
    references: readonly { kind: string; value: unknown }[];
  }): Promise<boolean>;
  listContexts(input: { prefix?: string }): Promise<string[]>;
  isStateDescendant(input: {
    ancestor: VcsStateNodeRef;
    descendant: VcsStateNodeRef;
    maxEdges: number;
  }): Promise<boolean>;
  getChannelEnvelope(input: {
    channelId: string;
    envelopeId: string;
  }): Promise<{ contentClass: "internal" | "external" } | null>;
  vcsEdit(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsMove(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsCopy(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsMerge(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsRevert(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsCommit(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsDiscard(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsImportSnapshot(
    input: WorkspaceSemanticRequest
  ): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsRegisterExternalDelta(
    input: WorkspaceSemanticRequest
  ): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsSupersedeExternalDelta(
    input: WorkspaceSemanticRequest
  ): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsFinalizeExternalDelta(
    input: WorkspaceSemanticRequest
  ): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsPush(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsStatus(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsCompare(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsInspect(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsNeighbors(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsHistory(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsBlame(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsWalk(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsQuery(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsSearch(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsReadMemory(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsResolveRepository(
    input: WorkspaceSemanticRequest
  ): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsReadFile(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsListDirectory(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  vcsListFiles(input: WorkspaceSemanticRequest): Promise<WorkspaceSourceSemanticDispatchResult>;
  semanticEffectAck(input: {
    acknowledgement: {
      effectId: string;
      payloadDigest: string;
      receipt: Record<string, unknown>;
    };
  }): Promise<WorkspaceSourceSemanticDispatchResult>;
  semanticHostReadAck(input: {
    acknowledgement: {
      request: Record<string, unknown>;
      files: Array<{ contentHash: string; text: string }>;
    };
  }): Promise<WorkspaceSourceSemanticDispatchResult>;
  pendingSemanticEffects(): Promise<WorkspaceSourceSemanticEffect[]>;
  ensureContext(input: {
    contextId: string;
    commandId: string;
    projection?: "deferred";
    ingress: WorkspaceSemanticRequest["ingress"];
  }): Promise<WorkspaceSourceSemanticDispatchResult>;
  contextMaterializationCommand(input: {
    contextId: string;
    materializedState: VcsStateNodeRef | null;
  }): Promise<ContextMaterializationCommand>;
  forkContext(input: {
    sourceContextId: string;
    targetContextId: string;
    commandId: string;
    ingress: WorkspaceSemanticRequest["ingress"];
  }): Promise<WorkspaceSourceSemanticDispatchResult>;
  dropContext(input: { contextId: string }): Promise<void>;
  appendLogEvent(input: {
    logId: string;
    head: string;
    logKind: string;
    events: readonly Record<string, unknown>[];
  }): Promise<void>;
  inspectInvocationState(input: {
    trajectoryId: string;
    branchId: string;
    invocationId: string;
    limit: number;
  }): Promise<{
    rows: Array<{
      log_id?: unknown;
      head?: unknown;
      invocation_id?: unknown;
      initiating_user_id?: unknown;
    }>;
  }>;
}

export function createWorkspaceSemanticPort(
  dispatch: Pick<DODispatch, "dispatch">,
  provider: WorkspaceSourceProviderRef
): WorkspaceSemanticPort {
  const invoke = <T>(method: string, input: unknown): Promise<T> =>
    dispatch.dispatch(provider, method, input) as Promise<T>;
  const invokeNoArgs = <T>(method: string): Promise<T> =>
    dispatch.dispatch(provider, method) as Promise<T>;
  return {
    contentGcRoots: () => invokeNoArgs("vcsContentGcRoots"),
    referencesReachable: (input) => invoke("vcsReferencesReachable", input),
    listContexts: (input) => invoke("vcsListContexts", input),
    isStateDescendant: (input) => invoke("vcsIsStateDescendant", input),
    getChannelEnvelope: (input) => invoke("getChannelEnvelope", input),
    vcsEdit: (input) => invoke("vcsEdit", input),
    vcsMove: (input) => invoke("vcsMove", input),
    vcsCopy: (input) => invoke("vcsCopy", input),
    vcsMerge: (input) => invoke("vcsMerge", input),
    vcsRevert: (input) => invoke("vcsRevert", input),
    vcsCommit: (input) => invoke("vcsCommit", input),
    vcsDiscard: (input) => invoke("vcsDiscard", input),
    vcsImportSnapshot: (input) => invoke("vcsImportSnapshot", input),
    vcsRegisterExternalDelta: (input) => invoke("vcsRegisterExternalDelta", input),
    vcsSupersedeExternalDelta: (input) => invoke("vcsSupersedeExternalDelta", input),
    vcsFinalizeExternalDelta: (input) => invoke("vcsFinalizeExternalDelta", input),
    vcsPush: (input) => invoke("vcsPush", input),
    vcsStatus: (input) => invoke("vcsStatus", input),
    vcsCompare: (input) => invoke("vcsCompare", input),
    vcsInspect: (input) => invoke("vcsInspect", input),
    vcsNeighbors: (input) => invoke("vcsNeighbors", input),
    vcsHistory: (input) => invoke("vcsHistory", input),
    vcsBlame: (input) => invoke("vcsBlame", input),
    vcsWalk: (input) => invoke("vcsWalk", input),
    vcsQuery: (input) => invoke("vcsQuery", input),
    vcsSearch: (input) => invoke("vcsSearch", input),
    vcsReadMemory: (input) => invoke("vcsReadMemory", input),
    vcsResolveRepository: (input) => invoke("vcsResolveRepository", input),
    vcsReadFile: (input) => invoke("vcsReadFile", input),
    vcsListDirectory: (input) => invoke("vcsListDirectory", input),
    vcsListFiles: (input) => invoke("vcsListFiles", input),
    semanticEffectAck: (input) => invoke("vcsSemanticEffectAck", input),
    semanticHostReadAck: (input) => invoke("vcsSemanticHostReadAck", input),
    pendingSemanticEffects: () => invokeNoArgs("vcsPendingSemanticEffects"),
    ensureContext: (input) => invoke("vcsEnsureContext", input),
    contextMaterializationCommand: (input) => invoke("vcsContextMaterializationCommand", input),
    forkContext: (input) => invoke("vcsForkContext", input),
    dropContext: (input) => invoke("vcsDropContext", input),
    appendLogEvent: (input) => invoke("appendLogEvent", input),
    inspectInvocationState: (input) => invoke("inspectInvocationState", input),
  };
}

export function createWorkspaceSourceProviderV1(
  dispatch: Pick<DODispatch, "dispatch">,
  provider: WorkspaceSourceProviderRef
): WorkspaceSourceProviderV1 {
  const invoke = <T>(method: string, input: unknown): Promise<T> =>
    dispatch.dispatch(provider, method, input) as Promise<T>;
  const invokeNoArgs = <T>(method: string): Promise<T> =>
    dispatch.dispatch(provider, method) as Promise<T>;
  return {
    initializeExactSnapshot: (input) => invoke("workspaceSourceInitializeExactSnapshot", input),
    resolveSource: (input) => invoke("workspaceSourceResolve", input),
    currentSource: () => invokeNoArgs("workspaceSourceCurrent"),
    inspectInitialization: () => invokeNoArgs("workspaceSourceInspectInitialization"),
    health: () => invokeNoArgs("workspaceSourceHealth"),
  };
}

export interface ExactCausalInvocationFact {
  initiatingUserId: string | null;
}

export async function resolveExactCausalInvocation(
  caller: Pick<WorkspaceSemanticPort, "inspectInvocationState">,
  parent: RpcCausalParent
): Promise<ExactCausalInvocationFact | null> {
  const inspection = await caller.inspectInvocationState({
    trajectoryId: parent.logId,
    branchId: parent.head,
    invocationId: parent.invocationId,
    limit: 1,
  });
  const row = inspection.rows.find(
    (row) =>
      row.log_id === parent.logId &&
      row.head === parent.head &&
      row.invocation_id === parent.invocationId
  );
  if (!row) return null;
  return {
    initiatingUserId:
      typeof row.initiating_user_id === "string" && row.initiating_user_id.length > 0
        ? row.initiating_user_id
        : null,
  };
}
