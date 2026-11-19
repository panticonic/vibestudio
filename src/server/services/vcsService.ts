/**
 * Canonical semantic VCS service.
 *
 * This boundary performs principal/context authorization and preserves the
 * exact causal ingress edge.
 * GAD owns revision resolution, semantic planning, graph mutation, proof, and
 * publication orchestration.  The host is deliberately unable to recreate a
 * merge, split one workspace mutation into repository loops, or reinterpret a
 * state hash as ancestry.
 */
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  ServiceError,
  verifiedInitiator,
  websiteAuthorityIdentity,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import {
  preparedAuthorityState,
  preparedAuthorityPayload,
  type ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { vcsFileSelections, type SemanticReads } from "./vcsFileAuthority.js";
import { defineServiceHandler, mapServiceHandlers } from "@vibestudio/shared/serviceHandlers";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import {
  channelTrajectoryFor,
  commandIdForTrajectoryInvocation,
} from "@vibestudio/trajectory-identity";
import {
  parseVcsSemanticRequest,
  vcsMethods,
  vcsOperationContextId,
  vcsOperationRegistry,
  type VcsMethodName,
} from "@vibestudio/service-schemas/vcs";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import { blobUploadPrincipal } from "../storage/blobUploads.js";
import {
  hasWorkspaceParticipantDiscardReceipt,
  inspectWorkspaceParticipantProvenance,
  readWorkspaceParticipantBlame,
  readWorkspaceParticipantHistory,
  readWorkspaceParticipantNeighbors,
  readWorkspaceParticipantStatus,
  workspaceParticipantCatalog,
  workspaceParticipantReferenceContext,
  workspaceParticipantReferencesReachable,
} from "../vcsHost/workspaceHistoryHost.js";
import { isTrustedDeviceCaller } from "./clientTrust.js";
import { admittedEvalContextOwner } from "./principalIdentity.js";
import { requireReviewedSourceConsumer } from "./workspaceTemplateSourceService.js";

export interface VcsServiceDeps {
  workspaceVcs: Pick<
    WorkspaceVcs,
    | "semanticCausalCall"
    | "semanticPublishCall"
    | "semanticEpochTransitionPublishCall"
    | "referencesReachable"
  >;
  participantWorkspace?: Pick<
    WorkspaceVcs,
    | "participantHistoryAttached"
    | "readParticipantMain"
    | "openParticipantScope"
    | "editParticipantContext"
    | "transferParticipantContext"
    | "revertParticipantContext"
    | "importParticipantSnapshot"
    | "saveParticipantContext"
    | "discardParticipantContext"
    | "publishParticipantContext"
    | "readParticipantFiles"
    | "reviewParticipantMerge"
    | "mergeParticipantContext"
  >;
  entityCache?: Pick<EntityCache, "resolveContext" | "resolveActive">;
  hasClientCapability?: (callerId: string, capability: ClientCapability) => boolean;
  listOwnedContexts?: (input: { contextId: string }) => Promise<{
    contexts: Array<{
      contextId: string;
      kind?: "lifecycle" | "lineage";
      ownerEntityId?: string | null;
    }>;
  }>;
  testPolicyForContext?: (
    contextId: string
  ) => import("@vibestudio/rpc").AgentExecutionTestPolicy | null;
  /**
   * Host coordinators may observe a durable external-delta decision after the
   * ordinary public integration succeeds. They do not receive registration or
   * lifecycle authority through this callback.
   */
  onExternalDeltaIntegrated?: (
    ctx: ServiceContext,
    input: { contextId: string; sourceDeltaId: string }
  ) => Promise<void>;
  /** Called only after the protected epoch-transition publication is durable. */
  onEpochTransitionPublished?: () => void;
}

function effectiveCallerId(ctx: ServiceContext): string {
  return ctx.caller.runtime.kind === "extension" && ctx.chainCaller
    ? ctx.chainCaller.callerId
    : ctx.caller.runtime.id;
}

function unauthorizedBinding(message: string): never {
  throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
    code: "Unauthorized",
    message,
    operation: "resolve-context",
  });
}

function verifiedAgentBinding(
  ctx: ServiceContext,
  deps: VcsServiceDeps
): {
  entityId: string;
  contextId: string;
  channelId: string;
} | null {
  if (ctx.caller.runtime.kind === "agent") {
    if (ctx.caller.agentBinding) return ctx.caller.agentBinding;
    return unauthorizedBinding("Agent caller has no verified entity binding");
  }
  const relay = deps.entityCache?.resolveActive(ctx.caller.runtime.id)?.agentBinding ?? null;
  return relay;
}

function callerContextId(ctx: ServiceContext, deps: VcsServiceDeps): string | null {
  const binding = verifiedAgentBinding(ctx, deps);
  if (binding) return binding.contextId;
  return deps.entityCache?.resolveContext(effectiveCallerId(ctx)) ?? null;
}

function callerContextAuthorities(ctx: ServiceContext, deps: VcsServiceDeps): string[] {
  const contexts = new Set<string>();
  const primary = callerContextId(ctx, deps);
  if (primary) contexts.add(primary);
  // An extension invocation carries both the verified upstream code identity
  // and the extension runtime principal. The former owns ordinary caller
  // work; the latter may own infrastructure lifecycle contexts it created.
  if (ctx.caller.runtime.kind === "extension") {
    const extensionContext = deps.entityCache?.resolveContext(ctx.caller.runtime.id) ?? null;
    if (extensionContext) contexts.add(extensionContext);
  }
  return [...contexts];
}

function privileged(ctx: ServiceContext, deps: VcsServiceDeps): boolean {
  return isTrustedDeviceCaller(verifiedInitiator(ctx), {
    hasClientCapability: deps.hasClientCapability,
  });
}

/**
 * A system-test case policy is resident authority on its exact semantic
 * context. Once ordinary context authorization has proved that the caller may
 * mutate that context, host-owned effects from the mutation must retain the
 * narrower resident case policy instead of falling back to the orchestrator's
 * broad identity and waiting for interactive consent.
 */
function callerForContext(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  contextId: string
): VerifiedCaller {
  const resident = deps.testPolicyForContext?.(contextId) ?? null;
  if (!resident) return ctx.caller;
  const callerPolicy = ctx.caller.testPolicy ?? ctx.caller.executionSession?.testPolicy ?? null;
  if (callerPolicy?.policyId === resident.policyId) return ctx.caller;
  if (
    callerPolicy &&
    !(
      callerPolicy.kind === "orchestrator" &&
      resident.kind === "case" &&
      resident.orchestratorPolicyId === callerPolicy.policyId
    )
  ) {
    throw new ServiceError(
      "vcs",
      "authorize",
      `Context test policy ${resident.policyId} is unrelated to caller policy ${callerPolicy.policyId}`,
      "EACCES"
    );
  }
  return {
    ...ctx.caller,
    testPolicy: resident,
    ...(ctx.caller.executionSession
      ? {
          executionSession: {
            ...ctx.caller.executionSession,
            testPolicy: resident,
          },
        }
      : {}),
  };
}

function isCallerTrajectoryRoot(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  reference: { kind: string; value: unknown }
): boolean {
  if (reference.kind !== "node" || !isRecord(reference.value)) return false;
  const binding = verifiedAgentBinding(ctx, deps);
  if (!binding) return false;
  const own = channelTrajectoryFor(binding.channelId);
  const rootKind = reference.value["kind"];
  if (rootKind === "command") {
    const parent = ctx.causalParent;
    return (
      parent?.kind === "trajectory-invocation" &&
      parent.logId === own.logId &&
      parent.head === own.head &&
      reference.value["commandId"] === commandIdForTrajectoryInvocation(parent)
    );
  }
  if (
    rootKind !== "trajectory" &&
    rootKind !== "trajectory-invocation" &&
    rootKind !== "trajectory-turn" &&
    rootKind !== "trajectory-message"
  ) {
    return false;
  }
  return reference.value["logId"] === own.logId && reference.value["head"] === own.head;
}

/** Read surfaces whose result set is scoped by the caller's visibility basis. */
const VISIBILITY_SCOPED_METHODS = new Set<VcsMethodName>(["walk", "query", "search"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authorizeContext(
  ctx: ServiceContext,
  deps: VcsServiceDeps,
  contextId: string,
  operation: "read" | "write"
): Promise<void> {
  const authorityRoots = callerContextAuthorities(ctx, deps);
  if (authorityRoots.includes(contextId) || privileged(ctx, deps)) return;
  const owned = await Promise.all(
    authorityRoots.map(async (root) => ({
      root,
      contexts: (await deps.listOwnedContexts?.({ contextId: root }))?.contexts ?? [],
    }))
  );
  if (operation === "write") {
    const ownerEntityIds = new Set([effectiveCallerId(ctx), ctx.caller.runtime.id]);
    const evalOwner = admittedEvalContextOwner(deps.entityCache, ctx.caller);
    const exactLifecycleOwnership = owned.some(({ root, contexts }) =>
      contexts.some(
        (entry) =>
          entry.contextId === contextId &&
          entry.kind === "lifecycle" &&
          entry.ownerEntityId != null &&
          (ownerEntityIds.has(entry.ownerEntityId) ||
            (evalOwner?.contextId === root && evalOwner.runtimeId === entry.ownerEntityId))
      )
    );
    if (exactLifecycleOwnership) return;
    const message = "The requested context is outside the caller's authority for writes";
    throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
      code: "Unauthorized",
      message,
      operation: "context-write",
    });
  }
  if (authorityRoots.length === 0) {
    const message = "The caller has no context read authority";
    throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
      code: "Unauthorized",
      message,
      operation: "context-read",
    });
  }
  if (owned.some(({ contexts }) => contexts.some((entry) => entry.contextId === contextId))) return;
  const message = "The requested context is outside the caller's reachable context graph";
  throw new ServiceError("vcs", "authorize", message, "EACCES", undefined, "access", {
    code: "Unauthorized",
    message,
    operation: "context-read",
  });
}

async function reachableContextAuthorities(
  ctx: ServiceContext,
  deps: VcsServiceDeps
): Promise<string[]> {
  const roots = callerContextAuthorities(ctx, deps);
  const owned = await Promise.all(
    roots.map((contextId) => deps.listOwnedContexts?.({ contextId }))
  );
  return [
    ...new Set([
      ...roots,
      ...owned.flatMap((result) => result?.contexts.map(({ contextId }) => contextId) ?? []),
    ]),
  ].sort();
}

export function createVcsService(deps: VcsServiceDeps): ServiceDefinition {
  const participantWorkspace = () => {
    const workspace = deps.participantWorkspace;
    return workspace?.participantHistoryAttached ? workspace : undefined;
  };

  const participantScope = async (
    workspace: NonNullable<VcsServiceDeps["participantWorkspace"]>,
    ctx: ServiceContext,
    explicitContextId: string | null,
    caller = ctx.caller
  ) => {
    const ownerContextId =
      callerContextId(ctx, deps) ?? (privileged(ctx, deps) ? explicitContextId : null);
    const contextId = explicitContextId ?? ownerContextId;
    if (!ownerContextId || !contextId)
      return unauthorizedBinding("The caller has no admitted workspace participant context");
    const scope = await workspace.openParticipantScope({
      caller,
      contextId,
      ownerContextId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!scope) throw new Error("Participant workspace history is unavailable");
    return scope;
  };

  const participantOperationScope = async (
    workspace: NonNullable<VcsServiceDeps["participantWorkspace"]>,
    ctx: ServiceContext,
    method: VcsMethodName,
    input: unknown,
    caller = ctx.caller
  ) => {
    const explicitContext = vcsOperationContextId(method, input);
    const scope = await participantScope(workspace, ctx, explicitContext, caller);
    if (explicitContext !== null || vcsOperationRegistry[method].accessClass !== "read") return scope;
    const reference = parseVcsSemanticRequest(method, input).references.find(
      ({ kind }) => kind === "state-node" || kind === "node" || kind === "event" || kind === "external-delta"
    );
    if (!reference) return scope;
    const contextId = await workspaceParticipantReferenceContext({
      ...scope,
      readableContextIds: await reachableContextAuthorities(ctx, deps),
      reference,
    });
    return { ...scope, contextId };
  };

  const invokeParticipant = async (
    workspace: NonNullable<VcsServiceDeps["participantWorkspace"]>,
    ctx: ServiceContext,
    method: VcsMethodName,
    input: unknown,
    effectCaller: VerifiedCaller,
    epochTransition: boolean
  ): Promise<unknown> => {
    if (method === "mainState") return workspace.readParticipantMain();
    const scope = await participantOperationScope(workspace, ctx, method, input, effectCaller);
    const cause = { parent: ctx.causalParent ?? null };
    const common = { ...scope, head: scope.workingHead, cause };
    switch (method) {
      case "status":
        return readWorkspaceParticipantStatus(scope);
      case "inspect":
        return inspectWorkspaceParticipantProvenance({
          ...scope,
          inspect: vcsMethods.inspect.args.parse([input])[0],
        });
      case "neighbors":
        return readWorkspaceParticipantNeighbors({
          ...scope,
          neighbors: vcsMethods.neighbors.args.parse([input])[0],
        });
      case "blame":
        return readWorkspaceParticipantBlame({
          ...scope,
          blame: vcsMethods.blame.args.parse([input])[0],
        });
      case "history":
        return readWorkspaceParticipantHistory({
          ...scope,
          history: vcsMethods.history.args.parse([input])[0],
        });
      case "compare":
        return workspace.reviewParticipantMerge({
          ...scope,
          compare: vcsMethods.compare.args.parse([input])[0],
          readableContextIds: await reachableContextAuthorities(ctx, deps),
        });
      case "merge":
        return (
          await workspace.mergeParticipantContext({
            ...scope,
            cause,
            merge: vcsMethods.merge.args.parse([input])[0],
            readableContextIds: await reachableContextAuthorities(ctx, deps),
          })
        ).result;
      case "edit":
        return (
          await workspace.editParticipantContext({
            ...common,
            edit: vcsMethods.edit.args.parse([input])[0],
          })
        ).result;
      case "move":
        return (
          await workspace.transferParticipantContext({
            ...common,
            transfer: { method: "move", value: vcsMethods.move.args.parse([input])[0] },
          })
        ).result;
      case "copy":
        return (
          await workspace.transferParticipantContext({
            ...common,
            transfer: { method: "copy", value: vcsMethods.copy.args.parse([input])[0] },
            readableContextIds: await reachableContextAuthorities(ctx, deps),
          })
        ).result;
      case "revert":
        return (
          await workspace.revertParticipantContext({
            ...common,
            revert: vcsMethods.revert.args.parse([input])[0],
          })
        ).result;
      case "importSnapshot":
        return workspace.importParticipantSnapshot({
          ...common,
          snapshot: vcsMethods.importSnapshot.args.parse([input])[0],
          uploadPrincipal: blobUploadPrincipal(ctx),
        });
      case "commit":
        return workspace.saveParticipantContext({
          ...common,
          commit: vcsMethods.commit.args.parse([input])[0],
        });
      case "discard":
        return workspace.discardParticipantContext({
          ...common,
          discard: vcsMethods.discard.args.parse([input])[0],
        });
      case "push":
        if (epochTransition)
          throw new Error("Participant publication requires an ordinary workspace revision");
        return workspace.publishParticipantContext({
          ...scope,
          push: vcsMethods.push.args.parse([input])[0],
          gateContext: {
            kind: "caller",
            caller: effectCaller,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
        });
      case "readFiles":
        return workspace.readParticipantFiles({
          ...scope,
          read: vcsMethods.readFiles.args.parse([input])[0],
        });
      case "readFile": {
        const { state, ...file } = vcsMethods.readFile.args.parse([input])[0];
        return (
          (await workspace.readParticipantFiles({ ...scope, read: { state, files: [file] } }))[0] ??
          null
        );
      }
      case "resolveRepository":
        return workspaceParticipantCatalog(scope).resolveRepository(
          vcsMethods.resolveRepository.args.parse([input])[0]
        );
      case "listDirectory":
        return workspaceParticipantCatalog(scope).listDirectory(
          vcsMethods.listDirectory.args.parse([input])[0]
        );
      case "listFiles":
        return workspaceParticipantCatalog(scope).listFiles(
          vcsMethods.listFiles.args.parse([input])[0]
        );
      default:
        throw new Error(`The participant workspace does not yet implement vcs.${method}`);
    }
  };

  const invoke = async (
    ctx: ServiceContext,
    method: VcsMethodName,
    input: unknown,
    effectCaller: VerifiedCaller = ctx.caller,
    epochTransition = false
  ): Promise<unknown> => {
    const workspace = participantWorkspace();
    if (workspace)
      return invokeParticipant(workspace, ctx, method, input, effectCaller, epochTransition);
    const causalParent = ctx.causalParent ?? null;
    switch (method) {
      case "edit":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsEdit",
          vcsMethods.edit.args.parse([input])[0],
          causalParent
        );
      case "move":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsMove",
          vcsMethods.move.args.parse([input])[0],
          causalParent
        );
      case "copy":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsCopy",
          vcsMethods.copy.args.parse([input])[0],
          causalParent
        );
      case "merge":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsMerge",
          vcsMethods.merge.args.parse([input])[0],
          causalParent
        );
      case "revert":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsRevert",
          vcsMethods.revert.args.parse([input])[0],
          causalParent
        );
      case "commit":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsCommit",
          vcsMethods.commit.args.parse([input])[0],
          causalParent
        );
      case "discard":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsDiscard",
          vcsMethods.discard.args.parse([input])[0],
          causalParent
        );
      case "importSnapshot":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsImportSnapshot",
          vcsMethods.importSnapshot.args.parse([input])[0],
          causalParent
        );
      case "registerExternalDelta":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsRegisterExternalDelta",
          vcsMethods.registerExternalDelta.args.parse([input])[0],
          causalParent
        );
      case "supersedeExternalDelta":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsSupersedeExternalDelta",
          vcsMethods.supersedeExternalDelta.args.parse([input])[0],
          causalParent
        );
      case "finalizeExternalDelta":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsFinalizeExternalDelta",
          vcsMethods.finalizeExternalDelta.args.parse([input])[0],
          causalParent
        );
      case "push": {
        const pushInput = vcsMethods.push.args.parse([input])[0];
        const publish = epochTransition
          ? deps.workspaceVcs.semanticEpochTransitionPublishCall
          : deps.workspaceVcs.semanticPublishCall;
        return ctx.signal
          ? publish.call(deps.workspaceVcs, pushInput, causalParent, effectCaller, ctx.signal)
          : publish.call(deps.workspaceVcs, pushInput, causalParent, effectCaller);
      }
      case "mainState":
        return deps.workspaceVcs.semanticCausalCall("vcsMainState", undefined, causalParent);
      case "status":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsStatus",
          vcsMethods.status.args.parse([input])[0],
          causalParent
        );
      case "compare":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsCompare",
          vcsMethods.compare.args.parse([input])[0],
          causalParent
        );
      case "inspect":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsInspect",
          vcsMethods.inspect.args.parse([input])[0],
          causalParent
        );
      case "neighbors":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsNeighbors",
          vcsMethods.neighbors.args.parse([input])[0],
          causalParent
        );
      case "history":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsHistory",
          vcsMethods.history.args.parse([input])[0],
          causalParent
        );
      case "walk":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsWalk",
          vcsMethods.walk.args.parse([input])[0],
          causalParent
        );
      case "query":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsQuery",
          vcsMethods.query.args.parse([input])[0],
          causalParent
        );
      case "search":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsSearch",
          vcsMethods.search.args.parse([input])[0],
          causalParent
        );
      case "blame":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsBlame",
          vcsMethods.blame.args.parse([input])[0],
          causalParent
        );
      case "readMemory":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsReadMemory",
          vcsMethods.readMemory.args.parse([input])[0],
          causalParent
        );
      case "resolveRepository":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsResolveRepository",
          vcsMethods.resolveRepository.args.parse([input])[0],
          causalParent
        );
      case "readFile":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsReadFile",
          vcsMethods.readFile.args.parse([input])[0],
          causalParent
        );
      case "readFiles":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsReadFiles",
          vcsMethods.readFiles.args.parse([input])[0],
          causalParent
        );
      case "listDirectory":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsListDirectory",
          vcsMethods.listDirectory.args.parse([input])[0],
          causalParent
        );
      case "listFiles":
        return deps.workspaceVcs.semanticCausalCall(
          "vcsListFiles",
          vcsMethods.listFiles.args.parse([input])[0],
          causalParent
        );
    }
  };

  const admitOperation = async (ctx: ServiceContext, method: VcsMethodName, input: unknown) => {
    if (method === "push" && isRecord(input) && input["templateInstallation"] !== undefined)
      requireReviewedSourceConsumer(ctx.caller);
    const parsed = parseVcsSemanticRequest(method, input);
    const operation = vcsOperationRegistry[method];
    const isMutation =
      operation.accessClass === "context-write" || operation.accessClass === "workspace-write";
    if (isMutation && verifiedAgentBinding(ctx, deps) && !ctx.causalParent) {
      const message = "Agent-bound VCS mutation requires an exact causal tool invocation";
      throw new ServiceError("vcs", method, message, "EACCES", undefined, "access", {
        code: "Unauthorized",
        message,
        operation: "causal-ingress",
      });
    }
    const primaryContextId = vcsOperationContextId(method, parsed.input);
    if (primaryContextId !== null) {
      await authorizeContext(ctx, deps, primaryContextId, isMutation ? "write" : "read");
    }

    const readableContexts = [
      ...new Set(
        parsed.references
          .filter(({ kind, value }) => kind === "context" && value !== primaryContextId)
          .map(({ value }) => value)
          .filter((value): value is string => typeof value === "string")
      ),
    ].sort();
    await Promise.all(
      readableContexts.map((contextId) => authorizeContext(ctx, deps, contextId, "read"))
    );

    const exactRoots = parsed.references
      .filter(
        ({ kind }) =>
          kind === "state-node" || kind === "event" || kind === "external-delta" || kind === "node"
      )
      .map(({ kind, value }) => ({ kind, value }));
    const guardedRoots = exactRoots.filter(
      (reference) => !isCallerTrajectoryRoot(ctx, deps, reference)
    );
    if (guardedRoots.length > 0 && !privileged(ctx, deps)) {
      const contextIds = await reachableContextAuthorities(ctx, deps);
      const workspace = participantWorkspace();
      const scope = workspace ? await participantScope(workspace, ctx, primaryContextId) : null;
      const reachable = scope
        ? await workspaceParticipantReferencesReachable({
            ...scope,
            contextIds,
            references: guardedRoots,
          })
        : await deps.workspaceVcs.referencesReachable(contextIds, guardedRoots);
      if (
        !reachable &&
        !(
          scope &&
          method === "discard" &&
          (await hasWorkspaceParticipantDiscardReceipt({
            ...scope,
            discard: vcsMethods.discard.args.parse([parsed.input])[0],
            cause: { parent: ctx.causalParent ?? null },
          }))
        )
      ) {
        const reference = guardedRoots[0]!;
        const message =
          "The exact semantic reference is unavailable from the caller's reachable context graph; re-observe it and copy the complete typed reference unchanged";
        throw new ServiceError("vcs", method, message, "EINVAL", undefined, "application", {
          code: "InvalidReference",
          message,
          referenceKind: reference.kind,
          reference: reference.value,
        });
      }
    }

    // Caller-scoped execution for the set-oriented surfaces: the DO never
    // trusts a query, walk, or search for identity. The host overwrites the
    // declared visibility basis with the exact reachable context authorities
    // it already computes for per-reference authorization, so the caller
    // cannot widen the basis by supplying the field.
    if (VISIBILITY_SCOPED_METHODS.has(method) && isRecord(parsed.input)) {
      parsed.input["visibilityContextIds"] = await reachableContextAuthorities(ctx, deps);
    }

    return parsed.input;
  };

  const invokeOperation = async (
    ctx: ServiceContext,
    method: VcsMethodName,
    input: unknown
  ): Promise<unknown> => {
    const prepared = ctx.preparedAuthority?.resolver === `vcs.files.${method}`;
    const admittedInput = prepared
      ? preparedAuthorityPayload<readonly unknown[]>(ctx, `vcs.files.${method}`)[0]
      : await admitOperation(ctx, method, input);
    const parsed = { input: admittedInput };
    const primaryContextId = vcsOperationContextId(method, admittedInput);
    const epochTransition =
      method === "push" && isRecord(parsed.input) && parsed.input["epochTransition"] === true;
    const semanticInput = epochTransition
      ? Object.fromEntries(
          Object.entries(parsed.input as Record<string, unknown>).filter(
            ([key]) => key !== "epochTransition"
          )
        )
      : parsed.input;
    const effectCaller =
      method === "push" && primaryContextId !== null
        ? callerForContext(ctx, deps, primaryContextId)
        : ctx.caller;
    const result = await invoke(ctx, method, semanticInput, effectCaller, epochTransition);
    if (epochTransition) deps.onEpochTransitionPublished?.();
    if (
      method === "merge" &&
      (parsed.input as { source?: { kind?: unknown; deltaId?: unknown } }).source?.kind ===
        "external-delta" &&
      typeof (parsed.input as { source?: { deltaId?: unknown } }).source?.deltaId === "string"
    ) {
      const integration = parsed.input as {
        contextId: string;
        source: { kind: "external-delta"; deltaId: string };
      };
      await deps.onExternalDeltaIntegrated?.(ctx, {
        contextId: integration.contextId,
        sourceDeltaId: integration.source.deltaId,
      });
    }
    return result;
  };

  const handlers = mapServiceHandlers(vcsMethods, (method, ctx, args) =>
    invokeOperation(ctx, method, args[0])
  );

  return {
    name: "vcs",
    description:
      "One provenance-native workspace history: direct state nodes, local incremental integration, whole-chain commit/discard, explicit move/copy, and protected publication.",
    authority: { principals: ["user", "code", "host", "website"] },
    methods: vcsMethods,
    authorityPreparation: Object.fromEntries(
      Object.entries<ServiceDefinition["methods"][string]>(vcsMethods)
        .filter(
          ([, definition]) =>
            definition.authority &&
            "requirement" in definition.authority &&
            definition.authority.prepared
        )
        .map(([method]) => [
          `vcs.files.${method}`,
          async (ctx, [input]) => {
            const admittedInput = await admitOperation(ctx, method as VcsMethodName, input);
            // Seal the canonical argument tuple as JSON. Zero-argument calls
            // retain absence rather than an undefined payload's null default.
            const admittedArgs = admittedInput === undefined ? [] : [admittedInput];
            if (!websiteAuthorityIdentity(ctx.caller))
              return preparedAuthorityState([], admittedArgs);
            const workspace = participantWorkspace();
            const scope =
              workspace && method !== "mainState"
                ? await participantOperationScope(workspace, ctx, method as VcsMethodName, admittedInput)
                : null;
            const catalog = scope ? workspaceParticipantCatalog({
              ...scope,
              ...((method === "compare" || method === "merge" || method === "copy")
                ? { readableContextIds: await reachableContextAuthorities(ctx, deps) }
                : {}),
            }) : null;
            const reads: SemanticReads = {
              inspect: async (value) =>
                vcsMethods.inspect.returns.parse(await invoke(ctx, "inspect", value)),
              compare: async (value) => {
                if (catalog)
                  throw new Error("Participant merge requires a reviewed placement scope");
                return vcsMethods.compare.returns.parse(await invoke(ctx, "compare", value));
              },
              status: async (value) =>
                vcsMethods.status.returns.parse(await invoke(ctx, "status", value)),
              listDirectory: async (value) =>
                vcsMethods.listDirectory.returns.parse(await invoke(ctx, "listDirectory", value)),
              listFiles: async (value) =>
                vcsMethods.listFiles.returns.parse(await invoke(ctx, "listFiles", value)),
              ...(scope && catalog
                ? {
                    repositoryPath: catalog.repositoryPath,
                    changedLocations: catalog.changedLocations,
                    mergeLocations: catalog.mergeLocations,
                    hasDiscardReceipt: (discard) =>
                      hasWorkspaceParticipantDiscardReceipt({
                        ...scope,
                        discard,
                        cause: { parent: ctx.causalParent ?? null },
                      }),
                    filePath: catalog.filePath,
                  }
                : {}),
            };
            const selections = await vcsFileSelections(
              method as VcsMethodName,
              admittedInput,
              reads
            );
            return preparedAuthorityState(selections, admittedArgs);
          },
        ])
    ),
    handler: defineServiceHandler("vcs", vcsMethods, handlers),
  };
}
