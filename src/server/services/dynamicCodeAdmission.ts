/**
 * One admission step for every run of dynamic code (§7.3 of
 * `docs/dolt-redesign.md`): an eval cell, a dynamic worker's kernel, anything a
 * hosting entity runs as code it did not ship.
 *
 * A hosted class cannot mint its own execution session, so reachability is
 * structural (only the hosting entity reaches its facet) while authority is
 * admitted here, by the host, once per run. This function owns:
 *  - the run's authority intent and its normalization (`normalizeAuthorityManifest`),
 *  - exact-operation `preauthorize`,
 *  - execution-session and task-authority registration,
 *  - the causal parent an agent-bound run must carry.
 *
 * It returns the session nonce the call into the hosted class carries. Owner
 * resolution, entity registration, tokens and delivery are not here.
 */
import type {
  CapabilityScope,
  EvalAuthorityManifest,
  ExecutionAdmissionFact,
} from "@vibestudio/rpc";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  normalizeEvalAuthorityIntent,
  type EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { resourceScopeContains } from "@vibestudio/shared/authorization";
import type { RuntimeAgentBinding } from "@vibestudio/shared/runtime/entitySpec";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import { executionAuthorityForCaller, retainExecutionAuthority } from "./executionAuthority.js";
import type { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { taskAuthorityPrincipal, type TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";

/** The authority intent a run declares (its `authority` field), whatever the code is. */
export type DynamicCodeAuthorityIntent = EvalStartInput["authority"];

export interface DynamicCodeAdmissionDeps {
  executionSessions: AgentExecutionSessionRegistry;
  taskAuthorities: TaskAuthorityRegistry;
  /** Entity registry, read for the caller's execution authority and task closure. */
  entityCache: Pick<EntityCache, "resolveActive" | "resolve">;
  workspaceId: string;
  isSystemTestHarness?: (caller: ServiceContext["caller"], runId: string) => boolean;
  /**
   * Whether an entity of the retired product `EvalDO` is still recorded active
   * (D5, docs/dolt-redesign.md §7.10): its notebook was dropped by the upgrade.
   */
  hasActiveEntity?: (runtimeId: string) => Promise<boolean>;
  /** Canonical dispatcher authorization-only path for exact prospective calls. */
  preauthorize?: (
    ctx: ServiceContext,
    operation: { service: string; method: string; args: unknown[] }
  ) => Promise<void>;
}

export interface DynamicCodeRunInput {
  runId: string;
  /** The runtime entity that hosts the code; its calls carry the session. */
  hostRuntimeId: string;
  /** The entity that owns the work (the principal the task belongs to). */
  ownerId: string;
  contextId: string;
  authority: DynamicCodeAuthorityIntent;
  /** The sealed code the host calls on behalf of the run. */
  executionImage: {
    repoPath: string;
    effectiveVersion: string;
    executionDigest: string;
    stateHash: `state:${string}`;
    /** Capabilities the code identity asked for; bounds wildcard run requests. */
    requested: readonly CapabilityScope[];
  };
  /** The agent relay the caller is bound to, when it is one. */
  agentBinding?: RuntimeAgentBinding;
  /** Opaque ids the caller keeps stable across a replay of the same run. */
  admissionKey: string;
  taskRefFallback: string;
  /** Today's push route for the run's events; deleted with push delivery (§7.5). */
  eventSinkNonce: string;
  /** The retired `EvalDO` entity of this owner and scope, when the run belongs to a notebook. */
  legacyHostRuntimeId?: string;
  /** Names the runtime kind of the executor fact (`eval` until the wire type is renamed). */
  controllerSignal?: AbortSignal;
}

export interface AdmittedDynamicCodeRun {
  /** The session the call into the hosted class carries. */
  executionSession: ExecutionAdmissionFact & {
    executor: Extract<ExecutionAdmissionFact["executor"], { kind: "eval" }>;
  };
  nonce: string;
  authorityManifest: EvalAuthorityManifest;
  authorityManifestDigest: string;
  /** The scope had a notebook in the retired `EvalDO`, which the upgrade dropped (D5): the kernel tells the user once. */
  legacyNotebookDropped: boolean;
  /** Close the session and forget the admission (a failure or a terminal). */
  discard(): void;
}

/** An agent-bound run must name the exact tool invocation that caused it, on the relay's own trajectory. */
export function assertAgentCausalParent(
  ctx: ServiceContext,
  agentBinding: RuntimeAgentBinding | undefined,
  service = "eval",
  method = "start"
): void {
  if (agentBinding && !ctx.causalParent) {
    throw new ServiceError(
      service,
      method,
      "Agent-bound eval execution requires an exact causal tool invocation",
      "EACCES",
      undefined,
      "access"
    );
  }
  if (agentBinding && ctx.causalParent) {
    const expected = channelTrajectoryFor(agentBinding.channelId);
    if (ctx.causalParent.logId !== expected.logId || ctx.causalParent.head !== expected.head) {
      throw new ServiceError(
        service,
        method,
        "Agent eval cause does not belong to the relay's host-bound trajectory",
        "EACCES",
        undefined,
        "access"
      );
    }
  }
}

export function normalizeAuthorityManifest(
  authority: DynamicCodeAuthorityIntent,
  initiatingRequests: readonly CapabilityScope[]
): EvalAuthorityManifest {
  const intent = normalizeEvalAuthorityIntent(authority);
  const requests = [...(intent.requests ?? [])]
    .map((request) => ({
      capability: request.capability,
      resource: { ...request.resource },
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const request of requests) {
    if (
      request.capability.endsWith("*") &&
      !initiatingRequests.some(
        (sealed) =>
          capabilityPatternCovers(sealed.capability, request.capability.slice(0, -1)) &&
          resourceScopeContains(sealed.resource, request.resource)
      )
    ) {
      throw new ServiceError(
        "eval",
        "start",
        `Wildcard run request ${request.capability} is not bounded by an equivalent sealed request`,
        "ERUNMANIFEST",
        undefined,
        "access"
      );
    }
  }
  const normalized = {
    mode: intent.requests === undefined ? ("adaptive" as const) : ("strict" as const),
    effects: intent.effects,
    approvals: intent.approvals,
    requests,
  };
  return Object.freeze({
    ...normalized,
    requests: Object.freeze(requests),
    digest: sha256Canonical(normalized),
  });
}

export function createDynamicCodeAdmission(deps: DynamicCodeAdmissionDeps) {
  return {
    /**
     * Admit one run. Any failure after the session exists discards it, so a
     * refused run leaves no authority behind.
     */
    async admit(ctx: ServiceContext, input: DynamicCodeRunInput): Promise<AdmittedDynamicCodeRun> {
      if (!ctx.caller.subject) {
        throw new ServiceError(
          "eval",
          "start",
          "Evaluated execution requires an authenticated user",
          "EACCES",
          undefined,
          "access"
        );
      }
      assertAgentCausalParent(ctx, input.agentBinding);
      const { agentBinding } = input;
      const parentAdmission = ctx.caller.executionSession ?? null;
      const mission = parentAdmission?.mission ?? null;
      const inheritedTestPolicy = deps.executionSessions.testPolicyForContext(input.contextId);
      const testPolicy =
        !mission &&
        (inheritedTestPolicy ??
          (deps.isSystemTestHarness?.(ctx.caller, input.runId)
            ? deps.executionSessions.createTestPolicy(input.runId)
            : null));
      const taskRef = agentBinding?.channelId ?? input.taskRefFallback;
      const ownerUser = `user:${ctx.caller.subject.userId}` as const;
      const inheritedTaskAuthority = deps.taskAuthorities.resolveCaller(
        ctx.caller,
        deps.entityCache
      );
      const taskBinding = {
        workspaceId: deps.workspaceId,
        contextId: input.contextId,
        channelId: taskRef,
      };
      const taskAuthority = inheritedTaskAuthority ?? taskAuthorityPrincipal(taskBinding);
      if (!inheritedTaskAuthority) deps.taskAuthorities.bindPrincipal(taskAuthority, taskBinding);
      const image = input.executionImage;
      const executionSession = await deps.executionSessions.admitWhenAvailable(
        {
          authorityOrigin: retainExecutionAuthority(
            executionAuthorityForCaller(ctx.caller, deps.entityCache),
            ctx.authorizingCaller
              ? executionAuthorityForCaller(ctx.authorizingCaller, deps.entityCache)
              : undefined
          ),
          controllerRuntimeId: ctx.caller.runtime.id,
          mode: mission ? "mission" : testPolicy ? "test" : "interactive",
          ownerUser,
          workspaceId: deps.workspaceId,
          contextId: input.contextId,
          agentBinding: agentBinding
            ? {
                entityId: agentBinding.entityId,
                channelId: agentBinding.channelId,
                bindingId: `${agentBinding.entityId}@${agentBinding.contextId}`,
              }
            : null,
          taskRef,
          taskAuthority,
          admissionKey: input.admissionKey,
          executionImage: {
            principal: codePrincipal(image),
            repoPath: image.repoPath,
            ref: image.stateHash,
            effectiveVersion: image.effectiveVersion,
            executionDigest: image.executionDigest,
          },
          executor: {
            kind: "eval",
            runtimeId: input.hostRuntimeId,
            evalRunId: input.runId,
            authorityManifest: normalizeAuthorityManifest(
              input.authority,
              ctx.caller.code?.requested ?? []
            ),
            eventSinkNonce: input.eventSinkNonce,
          },
          ...(mission ? { mission } : {}),
          ...(parentAdmission?.authorityPlanDigest
            ? { authorityPlanDigest: parentAdmission.authorityPlanDigest }
            : {}),
          parent: parentAdmission
            ? {
                authoritySessionId: parentAdmission.authoritySessionId,
                nonce: parentAdmission.nonce,
              }
            : null,
          ...(ctx.attachedHost ? { attachedHost: ctx.attachedHost } : {}),
          causalParent: ctx.causalParent
            ? {
                logId: ctx.causalParent.logId,
                head: ctx.causalParent.head,
                invocationId: ctx.causalParent.invocationId,
              }
            : null,
          ...(testPolicy ? { testPolicy } : {}),
        },
        ctx.signal
      );
      const discard = () => deps.executionSessions.discard(input.hostRuntimeId, input.runId);
      try {
        deps.taskAuthorities.bindExecution(executionSession);
        const executor = executionSession.executor;
        if (executor.kind !== "eval" || !executor.eventSinkNonce) {
          throw new Error("Dynamic-code admission has no live event sink");
        }
        const intent = normalizeEvalAuthorityIntent(input.authority);
        if (intent.preauthorize?.length) {
          if (!deps.preauthorize) {
            throw new ServiceError(
              "eval",
              "start",
              "Exact eval preauthorization is unavailable",
              "EUNAVAILABLE",
              undefined,
              "service"
            );
          }
          const prospectiveCtx: ServiceContext = {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            caller: {
              runtime: { id: input.hostRuntimeId, kind: "do" },
              code: {
                callerId: input.hostRuntimeId,
                callerKind: "do",
                repoPath: executionSession.executionImage.repoPath,
                effectiveVersion: executionSession.executionImage.effectiveVersion,
                executionDigest: executionSession.executionImage.executionDigest,
                requested: image.requested,
              },
              ...(agentBinding ? { agentBinding } : {}),
              executionSession,
              ...(ctx.caller.subject ? { subject: ctx.caller.subject } : {}),
            },
            ...(ctx.causalParent ? { causalParent: ctx.causalParent } : {}),
            ...(executor.authorityManifest.effects === "read-only" ? { readOnly: true } : {}),
          };
          for (const operation of intent.preauthorize)
            await deps.preauthorize(prospectiveCtx, operation);
        }
        const legacyNotebookDropped =
          input.legacyHostRuntimeId && deps.hasActiveEntity
            ? await deps.hasActiveEntity(input.legacyHostRuntimeId)
            : false;
        return {
          executionSession,
          nonce: executionSession.nonce,
          authorityManifest: executor.authorityManifest,
          authorityManifestDigest: executor.authorityManifest.digest,
          legacyNotebookDropped,
          discard,
        };
      } catch (error) {
        discard();
        throw error;
      }
    },
  };
}
