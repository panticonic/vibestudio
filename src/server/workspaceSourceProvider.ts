import { vcsReadMemoryCauseSchema, vcsTrajectoryInvocationRefSchema } from "@vibestudio/service-schemas/vcs";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { DODispatch } from "./doDispatch.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import {
  HistoryQueryCausesSchema,
  HistoryQueryTrajectorySchema,
  type HistoryQueryTrajectory,
  type HistorySearchCause,
  HistoryTrajectoryProvenanceRequestSchema,
  type HistoryTrajectoryProvenanceRequest,
  HistoryTrajectorySearchInputSchema,
  HistoryTrajectorySearchMatchesSchema,
  HistoryWalkCohortSchema,
  HistoryWalkInvocationsSchema,
  HistoryWalkPageSchema,
  type HistoryWalkCohort,
  type HistoryWalkInvocation,
  type HistoryWalkPage,
  gadWireMethods,
  type HistoryTrajectorySearchInput,
} from "@vibestudio/service-schemas/workspaceSource";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import {
  nativeInvocationId,
  nativeInvocationIdentity,
  type NativeInvocationIdentity,
  nativeInvocationInspectionSchema,
  nativeInvocationIdentitySchema,
} from "@vibestudio/service-schemas/nativeInvocation";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { HistoryCommitMemoryIndex } from "./vcsHost/workspaceHistoryHost.js";

export interface WorkspaceSourceProviderRef {
  source: string;
  className: string;
  objectKey: string;
}

/** Share only an outstanding read of the same canonical original input.
 * Each ingress still inspects its native task and rechecks its runtime owner.
 * Neither successful evidence nor failures survive the read's settlement. */
export function createCausalEnvelopeReader(
  read: (ref: WorkspaceSourceProviderRef, envelopeId: string) => Promise<unknown>
): (ref: WorkspaceSourceProviderRef, envelopeId: string) => Promise<unknown> {
  const pending = new Map<string, Promise<unknown>>();
  return (ref, envelopeId) => {
    const key = canonicalJson([ref.source, ref.className, ref.objectKey, envelopeId]);
    const existing = pending.get(key);
    if (existing) return existing;
    const flight = read(ref, envelopeId).finally(() => pending.delete(key));
    pending.set(key, flight);
    return flight;
  };
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
  | "vcsReadFiles"
  | "vcsListDirectory"
  | "vcsListFiles";
export type WorkspaceSemanticPort = Pick<WorkspaceSemanticClient, SemanticWireMethodName> & HistoryCommitMemoryIndex & {
  getChannelEnvelope(
    input: Parameters<WorkspaceSemanticClient["getChannelEnvelope"]>[0]
  ): Promise<{ contentClass: "internal" | "external" } | null>;
  semanticEffectAck: WorkspaceSemanticClient["vcsSemanticEffectAck"];
  semanticHostReadAck: WorkspaceSemanticClient["vcsSemanticHostReadAck"];
  semanticContentAck: WorkspaceSemanticClient["vcsSemanticContentAck"];
  pendingSemanticEffects: WorkspaceSemanticClient["vcsPendingSemanticEffects"];
  appendLogEvent: WorkspaceSemanticClient["appendLogEvent"];
  getLogEvent: WorkspaceSemanticClient["getLogEvent"];
  inspectInvocationState: WorkspaceSemanticClient["inspectInvocationState"];
  readHistoryTrajectoryProvenance(input: HistoryTrajectoryProvenanceRequest): Promise<unknown>;
  readHistoryMemoryCause(input: ReturnType<typeof vcsTrajectoryInvocationRefSchema.parse>):
    Promise<ReturnType<typeof vcsReadMemoryCauseSchema.parse> | null>;
  readHistoryWalkInvocation(input: HistoryWalkInvocation): Promise<HistoryWalkPage>;
  readHistoryWalkCohortInvocations(input: HistoryWalkCohort): Promise<HistoryWalkInvocation[]>;
  readHistoryQueryTrajectory(causes: readonly HistorySearchCause[]): Promise<HistoryQueryTrajectory>;
  searchHistoryTrajectory(input: HistoryTrajectorySearchInput):
    Promise<import("@vibestudio/service-schemas/vcs").VcsSearchHit[]>;
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
    vcsReadFiles: (input) => client.vcsReadFiles(input),
    vcsListDirectory: (input) => client.vcsListDirectory(input),
    vcsListFiles: (input) => client.vcsListFiles(input),
    semanticEffectAck: (input) => client.vcsSemanticEffectAck(input),
    semanticHostReadAck: (input) => client.vcsSemanticHostReadAck(input),
    semanticContentAck: (input) => client.vcsSemanticContentAck(input),
    pendingSemanticEffects: () => client.vcsPendingSemanticEffects(),
    appendLogEvent: (input) => client.appendLogEvent(input),
    getLogEvent: (input) => client.getLogEvent(input),
    inspectInvocationState: (input) => client.inspectInvocationState(input),
    readHistoryTrajectoryProvenance: (input) => dispatch.dispatch(
      provider, "readHistoryTrajectoryProvenance", HistoryTrajectoryProvenanceRequestSchema.parse(input),
    ),
    readHistoryMemoryCause: async (input) => vcsReadMemoryCauseSchema.nullable().parse(
      await dispatch.dispatch(provider, "readHistoryMemoryCause", vcsTrajectoryInvocationRefSchema.parse(input)),
    ),
    readHistoryWalkInvocation: async (input) => HistoryWalkPageSchema.parse(
      await dispatch.dispatch(provider, "readHistoryWalkInvocation", vcsTrajectoryInvocationRefSchema.parse(input)),
    ),
    readHistoryWalkCohortInvocations: async (input) => HistoryWalkInvocationsSchema.parse(
      await dispatch.dispatch(provider, "readHistoryWalkCohortInvocations", HistoryWalkCohortSchema.parse(input)),
    ),
    readHistoryQueryTrajectory: async (causes) => HistoryQueryTrajectorySchema.parse(
      await dispatch.dispatch(provider, "readHistoryQueryTrajectory", HistoryQueryCausesSchema.parse(causes)),
    ),
    recordHistoryCommitMemory: async (document) => {
      if (await dispatch.dispatch(provider, "recordHistoryCommitMemory", document) !== true)
        throw new Error("Workspace recall did not record the published event");
    },
    readHistoryCommitMemoryIndex: async () => {
      const marker = await dispatch.dispatch(provider, "readHistoryCommitMemoryIndex");
      if (marker !== null && typeof marker !== "string")
        throw new Error("Workspace recall returned an invalid commit memory marker");
      return marker;
    },
    recordHistoryCommitMemoryPage: async (page) => {
      if (await dispatch.dispatch(provider, "recordHistoryCommitMemoryPage", page) !== true)
        throw new Error("Workspace recall did not advance its commit memory index");
    },
    searchHistoryTrajectory: async (input) => HistoryTrajectorySearchMatchesSchema.parse(
      await dispatch.dispatch(provider, "searchHistoryTrajectory", HistoryTrajectorySearchInputSchema.parse(input)),
    ),
  } satisfies WorkspaceSemanticPort;
}

export interface ExactCausalInvocationFact {
  /** Host-retained runtime owner, independent of the original message's author. */
  owningUserId: string | null;
  nativeInvocation: NativeInvocationIdentity;
  initiatingUserId: string | null;
  active: boolean;
}

export async function resolveExactCausalInvocation(
  parent: RpcCausalParent,
  native: {
    binding: { entityId: string; contextId: string; channelId: string } | null;
    entities: Pick<EntityCache, "resolveActive">;
    inspect: (locator: NativeInvocationIdentity, invocationId: string) => Promise<unknown>;
    getEnvelope: (
      ref: { source: string; className: string; objectKey: string },
      envelopeId: string
    ) => Promise<unknown>;
  }
): Promise<ExactCausalInvocationFact | null> {
  if (!parent.nativeInvocation)
    throw new Error("Native causal invocation requires its exact native task locator");
  const locator = nativeInvocationIdentitySchema.parse(parent.nativeInvocation);
  if (nativeInvocationId(locator) !== parent.invocationId)
    throw new Error("Native task locator has a different invocation identity");
  const entity = native.entities.resolveActive(locator.owner.runtimeId);
  const binding = entity?.agentBinding;
  if (
    !binding ||
    entity?.kind !== "do" ||
    entity.authoritySessionId !== locator.owner.authoritySessionId
  )
    throw new Error("Native task locator belongs to a retired or different runtime owner");
  if (native.binding && canonicalJson(native.binding) !== canonicalJson(binding))
    throw new Error("Native task locator does not belong to the presenting agent");
  const ownerImage = (value: ReturnType<EntityCache["resolveActive"]>) =>
    value
      ? canonicalJson({
          id: value.id,
          kind: value.kind,
          contextId: value.contextId,
          authoritySessionId: value.authoritySessionId,
          source: value.source,
          className: value.className,
          key: value.key,
          executionDigest: value.activeExecutionDigest,
          agentBinding: value.agentBinding,
        })
      : null;
  const admittedImage = ownerImage(entity);
  const observed = await native.inspect(locator, parent.invocationId);
  if (ownerImage(native.entities.resolveActive(locator.owner.runtimeId)) !== admittedImage)
    throw new Error("Native task locator belongs to a retired or different runtime image");
  if (observed === null) return null;
  const current = nativeInvocationInspectionSchema.parse(observed);
  const source = current.source;
  const executor = current.executor;
  const trajectory = channelTrajectoryFor(source.owner.channelId);
  if (parent.logId !== trajectory.logId || parent.head !== trajectory.head)
    throw new Error("Native task locator does not belong to the bound trajectory");

  if (canonicalJson(nativeInvocationIdentity(source)) !== canonicalJson(locator))
    throw new Error("Native task locator conflicts with its owning task");
  const assertOwner = () => {
    const active = native.entities.resolveActive(binding.entityId);
    if (
      !active ||
      active.kind !== "do" ||
      active.contextId !== source.owner.contextId ||
      active.authoritySessionId !== source.owner.authoritySessionId ||
      active.source.repoPath !== source.owner.source ||
      active.source.effectiveVersion !== executor.effectiveVersion ||
      active.className !== source.owner.className ||
      active.key !== source.owner.objectKey ||
      active.activeExecutionDigest !== executor.executionDigest ||
      canonicalJson(active.agentBinding) !== canonicalJson(binding) ||
      source.owner.runtimeId !== binding.entityId ||
      executor.runtimeId !== source.owner.runtimeId ||
      executor.authoritySessionId !== source.owner.authoritySessionId ||
      executor.contextId !== source.owner.contextId ||
      executor.channelId !== source.owner.channelId ||
      executor.source !== source.owner.source ||
      executor.className !== source.owner.className ||
      executor.objectKey !== source.owner.objectKey
    )
      throw new Error("Native task locator belongs to a retired or different runtime image");
  };
  assertOwner();
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
    const original = await native.getEnvelope(origin.channelRef, origin.envelopeId);
    assertOwner();
    if (!original || typeof original !== "object")
      throw new Error("Native originating input has no exact canonical channel event");
    const event = original as Record<string, unknown>;
    const payload = event["payload"] as {
      kind?: unknown;
      causality?: { messageId?: unknown };
    } | null;
    if (
      event["messageId"] !== origin.envelopeId ||
      event["type"] !== "agentic.trajectory.v1/event" ||
      payload?.kind !== "message.completed" ||
      payload.causality?.messageId !== origin.messageId ||
      typeof event["senderId"] !== "string"
    )
      throw new Error("Native originating input has no exact canonical channel event");
    // Only the canonical channel owner's authenticated outer sender proves a
    // human author. Cursor retention and nested actor claims are projections.
    const sender = event["senderId"];
    if (sender.startsWith("user:")) {
      if (sender.length === "user:".length)
        throw new Error("Native originating input has no canonical human sender");
      initiatingUserId = sender.slice("user:".length);
    }
  }
  return {
    owningUserId: native.entities.resolveActive(binding.entityId)?.ownerUserId ?? null,
    nativeInvocation: nativeInvocationIdentity(source),
    active: current.status !== "terminal" && current.status !== "completing",
    initiatingUserId,
  };
}
