import type { RpcCausalParent } from "@vibestudio/rpc";
import type {
  InitializeExactWorkspaceSnapshotInput,
  WorkspaceSourceInitializationInspection,
} from "@vibestudio/workspace-contracts/workspaceSource";
import type { DODispatch } from "./doDispatch.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { GadJsonRecordSchema, gadWireMethods } from "@vibestudio/service-schemas/workspaceSource";
import { WorkspaceTemplateInstallationSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  nativeInvocationId,
  nativeInvocationIdentity,
  type NativeInvocationIdentity,
  nativeInvocationInspectionSchema,
  nativeInvocationSourceSchema,
  nativeOriginatingInputSchema,
  type NativeInvocationSource,
} from "@vibestudio/service-schemas/nativeInvocation";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";

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
  readTemplateInstallation(input: {
    eventId: string;
  }): Promise<import("@vibestudio/workspace-contracts/types").WorkspaceTemplateInstallation | null>;
  initializeExactSnapshot(
    input: InitializeExactWorkspaceSnapshotInput
  ): Promise<WorkspaceSourceInitializationInspection>;
  resolveSource(input: { ref: string }): Promise<{ stateHash: string }>;
  currentSource(): Promise<{ stateHash: string } | null>;
  inspectInitialization(): Promise<WorkspaceSourceInitializationInspection>;
  health(): Promise<{ ok: true; protocol: "vibestudio.workspace-source.v1" }>;
}

/**
 * The complete host ABI of the cataloged workspace source builtin.
 * Keeping the wire method literals inside this adapter makes adding a new
 * cross-boundary operation an explicit interface change.
 */
type WorkspaceSemanticClient = import("@vibestudio/shared/typedServiceClient").TypedServiceClient<
  typeof gadWireMethods
>;
type SemanticWireMethodName =
  | "vcsEdit"
  | "vcsMove"
  | "vcsCopy"
  | "vcsMerge"
  | "vcsRevert"
  | "vcsCommit"
  | "vcsDiscard"
  | "vcsImportSnapshot"
  | "vcsRegisterExternalDelta"
  | "vcsSupersedeExternalDelta"
  | "vcsFinalizeExternalDelta"
  | "vcsPush"
  | "vcsStatus"
  | "vcsMainState"
  | "vcsCompare"
  | "vcsInspect"
  | "vcsNeighbors"
  | "vcsHistory"
  | "vcsBlame"
  | "vcsWalk"
  | "vcsQuery"
  | "vcsSearch"
  | "vcsReadMemory"
  | "vcsResolveRepository"
  | "vcsReadFile"
  | "vcsListDirectory"
  | "vcsListFiles";
export type WorkspaceSemanticPort = Pick<WorkspaceSemanticClient, SemanticWireMethodName> & {
  contentGcRoots: WorkspaceSemanticClient["vcsContentGcRoots"];
  referencesReachable: WorkspaceSemanticClient["vcsReferencesReachable"];
  listContexts: WorkspaceSemanticClient["vcsListContexts"];
  isStateDescendant: WorkspaceSemanticClient["vcsIsStateDescendant"];
  getChannelEnvelope(
    input: Parameters<WorkspaceSemanticClient["getChannelEnvelope"]>[0]
  ): Promise<{ contentClass: "internal" | "external" } | null>;
  semanticEffectAck: WorkspaceSemanticClient["vcsSemanticEffectAck"];
  semanticHostReadAck: WorkspaceSemanticClient["vcsSemanticHostReadAck"];
  semanticContentAck: WorkspaceSemanticClient["vcsSemanticContentAck"];
  pendingSemanticEffects: WorkspaceSemanticClient["vcsPendingSemanticEffects"];
  ensureContext: WorkspaceSemanticClient["vcsEnsureContext"];
  contextMaterializationCommand: WorkspaceSemanticClient["vcsContextMaterializationCommand"];
  forkContext: WorkspaceSemanticClient["vcsForkContext"];
  dropContext: WorkspaceSemanticClient["vcsDropContext"];
  appendLogEvent: WorkspaceSemanticClient["appendLogEvent"];
  getLogEvent: WorkspaceSemanticClient["getLogEvent"];
  inspectInvocationState: WorkspaceSemanticClient["inspectInvocationState"];
};
type RawWorkspaceSourceSemanticDispatchResult = Awaited<
  ReturnType<WorkspaceSemanticClient[SemanticWireMethodName]>
>;
export type WorkspaceSourceSemanticEffect = Awaited<
  ReturnType<WorkspaceSemanticClient["vcsPendingSemanticEffects"]>
>[number];
type PendingSemanticEffect = Extract<
  RawWorkspaceSourceSemanticDispatchResult,
  { kind: "effects-pending" }
>["effects"][number];
export type WorkspaceSourceHostReadRequest = Extract<
  RawWorkspaceSourceSemanticDispatchResult,
  { kind: "host-read" }
>["request"];
export type WorkspaceSourceHostContentRequest = Extract<
  RawWorkspaceSourceSemanticDispatchResult,
  { kind: "host-content" }
>["request"];
export type WorkspaceSourceSemanticDispatchResult =
  | { kind: "complete"; result: unknown }
  | {
      kind: "effects-pending";
      result: unknown;
      effects: PendingSemanticEffect[];
    }
  | Extract<RawWorkspaceSourceSemanticDispatchResult, { kind: "host-read" | "host-content" }>;

export function createWorkspaceSemanticPort(
  dispatch: Pick<DODispatch, "dispatch">,
  provider: WorkspaceSourceProviderRef
): WorkspaceSemanticPort {
  const client = createTypedServiceClient(
    "workspaceSource",
    gadWireMethods,
    (_service, method, args) => dispatch.dispatch(provider, method, ...args)
  );
  return {
    contentGcRoots: () => client.vcsContentGcRoots(),
    referencesReachable: (input) => client.vcsReferencesReachable(input),
    listContexts: (input) => client.vcsListContexts(input),
    isStateDescendant: (input) => client.vcsIsStateDescendant(input),
    getChannelEnvelope: async (input) => {
      const envelope = await client.getChannelEnvelope(input);
      return envelope ? { contentClass: envelope.contentClass } : null;
    },
    vcsEdit: (input) => client.vcsEdit(input),
    vcsMove: (input) => client.vcsMove(input),
    vcsCopy: (input) => client.vcsCopy(input),
    vcsMerge: (input) => client.vcsMerge(input),
    vcsRevert: (input) => client.vcsRevert(input),
    vcsCommit: (input) => client.vcsCommit(input),
    vcsDiscard: (input) => client.vcsDiscard(input),
    vcsImportSnapshot: (input) => client.vcsImportSnapshot(input),
    vcsRegisterExternalDelta: (input) => client.vcsRegisterExternalDelta(input),
    vcsSupersedeExternalDelta: (input) => client.vcsSupersedeExternalDelta(input),
    vcsFinalizeExternalDelta: (input) => client.vcsFinalizeExternalDelta(input),
    vcsPush: (input) => client.vcsPush(input),
    vcsStatus: (input) => client.vcsStatus(input),
    vcsMainState: (input) => client.vcsMainState(input),
    vcsCompare: (input) => client.vcsCompare(input),
    vcsInspect: (input) => client.vcsInspect(input),
    vcsNeighbors: (input) => client.vcsNeighbors(input),
    vcsHistory: (input) => client.vcsHistory(input),
    vcsBlame: (input) => client.vcsBlame(input),
    vcsWalk: (input) => client.vcsWalk(input),
    vcsQuery: (input) => client.vcsQuery(input),
    vcsSearch: (input) => client.vcsSearch(input),
    vcsReadMemory: (input) => client.vcsReadMemory(input),
    vcsResolveRepository: (input) => client.vcsResolveRepository(input),
    vcsReadFile: (input) => client.vcsReadFile(input),
    vcsListDirectory: (input) => client.vcsListDirectory(input),
    vcsListFiles: (input) => client.vcsListFiles(input),
    semanticEffectAck: (input) => client.vcsSemanticEffectAck(input),
    semanticHostReadAck: (input) => client.vcsSemanticHostReadAck(input),
    semanticContentAck: (input) => client.vcsSemanticContentAck(input),
    pendingSemanticEffects: () => client.vcsPendingSemanticEffects(),
    ensureContext: (input) => client.vcsEnsureContext(input),
    contextMaterializationCommand: (input) => client.vcsContextMaterializationCommand(input),
    forkContext: (input) => client.vcsForkContext(input),
    dropContext: (input) => client.vcsDropContext(input),
    appendLogEvent: (input) => client.appendLogEvent(input),
    getLogEvent: (input) => client.getLogEvent(input),
    inspectInvocationState: (input) => client.inspectInvocationState(input),
  } satisfies WorkspaceSemanticPort;
}

export function createWorkspaceSourceProviderV1(
  dispatch: Pick<DODispatch, "dispatch">,
  provider: WorkspaceSourceProviderRef
): WorkspaceSourceProviderV1 {
  const client = createTypedServiceClient(
    "workspaceSource",
    gadWireMethods,
    (_service, method, args) => dispatch.dispatch(provider, method, ...args)
  );
  return {
    readTemplateInstallation: (input) => client.workspaceSourceTemplateInstallation(input),
    initializeExactSnapshot: (input) => {
      const { acknowledgement, ...snapshot } = input;
      return client.workspaceSourceInitializeExactSnapshot({
        ...snapshot,
        installation: WorkspaceTemplateInstallationSchema.parse(input.installation),
        ...(acknowledgement
          ? {
              acknowledgement: {
                ...acknowledgement,
                receipt: GadJsonRecordSchema.parse(acknowledgement.receipt),
              },
            }
          : {}),
        repositories: input.repositories.map((repository) => ({
          ...repository,
          files: repository.files.map((file) => ({ ...file })),
        })),
      });
    },
    resolveSource: (input) => client.workspaceSourceResolve(input),
    currentSource: () => client.workspaceSourceCurrent(),
    inspectInitialization: () => client.workspaceSourceInspectInitialization(),
    health: () => client.workspaceSourceHealth(),
  } satisfies WorkspaceSourceProviderV1;
}

export interface ExactCausalInvocationFact {
  /** Host-retained runtime owner, independent of the original message's author. */
  owningUserId: string | null;
  nativeInvocation: NativeInvocationIdentity;
  initiatingUserId: string | null;
  active: boolean;
}

export async function resolveExactCausalInvocation(
  caller: Pick<WorkspaceSemanticPort, "inspectInvocationState" | "getLogEvent">,
  parent: RpcCausalParent,
  native: {
    binding: { entityId: string; contextId: string; channelId: string } | null;
    entities: Pick<EntityCache, "resolveActive">;
    inspect: (source: NativeInvocationSource, invocationId: string) => Promise<unknown>;
  }
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
  if (typeof row.started_event_id !== "string" || !row.started_event_id) return null;
  const event = gadWireMethods.getLogEvent.returns.parse(
    await caller.getLogEvent({
      logId: parent.logId,
      head: parent.head,
      envelopeId: row.started_event_id,
    })
  );
  if (
    !event ||
    event.logId !== parent.logId ||
    event.head !== parent.head ||
    event.envelopeId !== row.started_event_id ||
    event.payloadKind !== "invocation.started" ||
    event.causality?.invocationId !== parent.invocationId
  )
    return null;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = nativeInvocationSourceSchema.parse(
    (payload as Record<string, unknown>)["nativeSource"]
  );
  if (nativeInvocationId(source) !== parent.invocationId)
    throw new Error("Published native source has a different invocation identity");
  // Nested extension calls may carry a host-retained task closure instead of
  // a direct presenter binding. Both cases prove the same actual source owner.
  const binding = native.entities.resolveActive(source.owner.runtimeId)?.agentBinding;
  if (
    !binding ||
    source.owner.runtimeId !== binding.entityId ||
    source.owner.contextId !== binding.contextId ||
    source.owner.channelId !== binding.channelId
  )
    throw new Error("Published native source does not belong to the bound agent");
  if (native.binding && canonicalJson(native.binding) !== canonicalJson(binding))
    throw new Error("Published native source does not belong to the presenting agent");
  const trajectory = channelTrajectoryFor(binding.channelId);
  if (parent.logId !== trajectory.logId || parent.head !== trajectory.head)
    throw new Error("Published native source does not belong to the bound trajectory");
  const assertOwner = () => {
    const entity = native.entities.resolveActive(binding.entityId);
    if (
      !entity ||
      entity.kind !== "do" ||
      entity.contextId !== source.owner.contextId ||
      entity.authoritySessionId !== source.owner.authoritySessionId ||
      entity.source.repoPath !== source.owner.source ||
      entity.source.effectiveVersion !== source.owner.effectiveVersion ||
      entity.className !== source.owner.className ||
      entity.key !== source.owner.objectKey ||
      entity.activeExecutionDigest !== source.owner.executionDigest ||
      canonicalJson(entity.agentBinding) !== canonicalJson(binding)
    )
      throw new Error("Published native source belongs to a retired or different runtime image");
  };
  assertOwner();
  const observed = await native.inspect(source, parent.invocationId);
  assertOwner();
  if (observed === null) return null;
  const current = nativeInvocationInspectionSchema.parse(observed);
  if (canonicalJson(current.source) !== canonicalJson(source))
    throw new Error("Published native source conflicts with its owning task");
  const publishedInput = nativeOriginatingInputSchema
    .nullable()
    .parse((payload as Record<string, unknown>)["originatingInput"]);
  if (canonicalJson(publishedInput) !== canonicalJson(current.originatingInput))
    throw new Error("Published native input conflicts with its owning task");
  let initiatingUserId: string | null = null;
  const origin = current.originatingInput;
  if (origin) {
    if (
      origin.receiverParticipantId !== source.owner.runtimeId ||
      (source.operation.kind === "model" &&
        origin.conversationId === source.task.conversationId &&
        origin.entryId > source.operation.cutoff)
    )
      throw new Error("Native originating input does not belong to the invoking task");
    const original = gadWireMethods.getLogEvent.returns.parse(
      await caller.getLogEvent({
        logId: origin.channelRef.objectKey,
        head: channelTrajectoryFor(origin.channelRef.objectKey).head,
        envelopeId: origin.envelopeId,
      })
    );
    assertOwner();
    if (
      !original ||
      original.logId !== origin.channelRef.objectKey ||
      original.head !== channelTrajectoryFor(origin.channelRef.objectKey).head ||
      original.envelopeId !== origin.envelopeId ||
      original.seq !== origin.eventSequence ||
      original.payloadKind !== "message.completed" ||
      original.causality?.messageId !== origin.messageId
    )
      throw new Error("Native originating input has no exact canonical channel event");
    // Native inspection proves the original placed input. Only the journal's
    // authenticated outer sender identifies its human author; transcript text,
    // nested message actors and old turn projections do not establish authority.
    const actor = original.actor;
    if (actor.kind === "user") {
      if (
        !actor.id.startsWith("user:") ||
        actor.id.length === "user:".length ||
        (actor.participantId !== undefined && actor.participantId !== actor.id)
      )
        throw new Error("Native originating input has no canonical human sender");
      initiatingUserId = actor.id.slice("user:".length);
    }
  }
  return {
    owningUserId: native.entities.resolveActive(binding.entityId)?.ownerUserId ?? null,
    nativeInvocation: nativeInvocationIdentity(source),
    active:
      current.status !== "terminal" &&
      current.status !== "completing" &&
      row.terminal_outcome == null &&
      row.started_events === 1 &&
      row.terminal_events === 0,
    initiatingUserId,
  };
}
