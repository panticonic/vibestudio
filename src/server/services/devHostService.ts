import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  devHostMethods,
  type DevHostTarget,
  type DevHostProviderLaunchInput,
  type DevHostProviderPreparationFailure,
  type DevHostProviderPreparationInput,
  type DevHostProviderPreparationResult,
  type DevHostProviderRebuildInput,
  type DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";
import type {
  EvalCancelInput,
  EvalEventsInput,
  EvalGetInput,
  EvalRunHandle,
  EvalRunSnapshot,
  EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import type { ExecutionSnapshot } from "../execution/executionSnapshotService.js";
import { domainHash } from "@vibestudio/shared/execution/identity";
import type { EvalParentAuthorityEnvelope } from "@vibestudio/service-schemas/eval";
import { DevHostEvalAuthorityIssuer } from "./devHostEvalAuthority.js";
import { decodeDevHostEvalAuthority } from "./devHostEvalAuthority.js";
import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import type { CapabilityPermissionResult } from "./capabilityPermission.js";

export function childEvalContinuationDecision(
  permission: CapabilityPermissionResult,
  allowedDecisions: readonly ApprovalDecision[]
): ApprovalDecision {
  if (!permission.allowed) return permission.decision ?? "deny";

  const preferred =
    permission.decision === "once" ? (["once", "run"] as const) : (["run", "once"] as const);
  const continuation = preferred.find((decision) => allowedDecisions.includes(decision));
  if (continuation) return continuation;

  throw Object.assign(new Error("Child challenge has no non-persistent continuation decision"), {
    code: "EVAL_INVOCATION_INVALID",
  });
}

export interface DevHostProvider {
  prepare(input: DevHostProviderPreparationInput): Promise<DevHostProviderPreparationResult>;
  failPreparation(
    input: DevHostProviderPreparationInput,
    failure: DevHostProviderPreparationFailure
  ): Promise<DevLaunchStatus>;
  launch(input: DevHostProviderLaunchInput): Promise<DevLaunchStatus>;
  status(): Promise<DevLaunchStatus[]>;
  rebuild(input: DevHostProviderRebuildInput): Promise<{
    launchId: string;
    executionInputHash: string;
    hostBuildId: string | null;
    active: boolean;
    state: DevLaunchStatus["state"];
  }>;
  stop(launchId: string): Promise<{ launchId: string; stopped: boolean }>;
  evalStart(
    launchId: string,
    input: EvalStartInput,
    authority: EvalParentAuthorityEnvelope
  ): Promise<EvalRunHandle>;
  evalGet(launchId: string, input: EvalGetInput): Promise<EvalRunSnapshot>;
  evalEvents(
    launchId: string,
    input: EvalEventsInput
  ): Promise<{ events: unknown[]; next: number }>;
  evalCancel(
    launchId: string,
    input: EvalCancelInput
  ): Promise<{ status: "requested" | "cancelled" | "terminal" }>;
  logs(launchId: string, after?: number): Promise<Response>;
  watch(launchId: string, after?: number): Promise<Response>;
}

export interface DevHostServiceDeps {
  workspaceId: string;
  parentHostId: string;
  resolveCallerContext(callerId: string): string | null;
  resolveSource(contextId: string): Promise<{ stateHash: string; dirtyCount: number }>;
  createSnapshot(input: { stateHash: string; target: DevHostTarget }): Promise<ExecutionSnapshot>;
  releaseSnapshot(snapshot: ExecutionSnapshot): Promise<void>;
  prepareCurrentHostClient(
    ctx: ServiceContext,
    snapshot: DevHostProviderLaunchInput["snapshot"]
  ): Promise<NonNullable<DevHostProviderLaunchInput["currentHostPairing"]>>;
  authorize(input: {
    ctx: ServiceContext;
    capability:
      | "service:devHost.launch"
      | "service:devHost.status"
      | "service:devHost.rebuild"
      | "service:devHost.stop"
      | "service:devHost.eval.start"
      | "service:devHost.eval.get"
      | "service:devHost.eval.events"
      | "service:devHost.eval.cancel"
      | "service:devHost.logs"
      | "service:devHost.watch"
      | "devHost.admin";
    resource: string;
    executionInputHash?: string;
  }): Promise<void>;
  /** Binds provider invocations to the authenticated caller for host-side attribution. */
  provider(ctx: ServiceContext): DevHostProvider;
  resolveChildChallenge(input: {
    initiator: ServiceContext["caller"];
    launch: DevLaunchStatus;
    runId: string;
    challengeId: string;
    capability: string;
    resource: { type: string; label: string; value: string; key: string };
    allowedDecisions: ApprovalDecision[];
    signal: AbortSignal;
  }): Promise<ApprovalDecision>;
  now?: () => number;
}

export interface DevHostSourceWatcherDeps {
  provider: DevHostProvider;
  resolveSource(contextId: string): Promise<{ stateHash: string; dirtyCount: number }>;
  createSnapshot(input: { stateHash: string; target: DevHostTarget }): Promise<ExecutionSnapshot>;
  releaseSnapshot(snapshot: ExecutionSnapshot): Promise<void>;
  onError?: (contextId: string, error: unknown) => void;
}

/**
 * Coalesces canonical context advances into provider-owned candidate snapshots.
 * It never executes a candidate: the owner must return through `rebuild`, where
 * the host authorizes the exact pending execution input.
 */
export class DevHostSourceWatcher {
  private readonly dirtyContexts = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: DevHostSourceWatcherDeps) {}

  notify(contextId: string): void {
    this.dirtyContexts.add(contextId);
    if (this.running.has(contextId)) return;
    const run = Promise.resolve()
      .then(async () => {
        while (this.dirtyContexts.delete(contextId)) await this.refresh(contextId);
      })
      .catch((error) => this.deps.onError?.(contextId, error))
      .finally(() => {
        this.running.delete(contextId);
        if (this.dirtyContexts.has(contextId)) this.notify(contextId);
      });
    this.running.set(contextId, run);
  }

  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private async refresh(contextId: string): Promise<void> {
    const launches = (await this.deps.provider.status()).filter(
      (launch) =>
        launch.owner.contextId === contextId &&
        launch.activeHostBuildId !== null &&
        launch.state !== "failed" &&
        launch.state !== "stopping" &&
        launch.state !== "stopped"
    );
    if (launches.length === 0) return;
    const source = await this.deps.resolveSource(contextId);
    for (const launch of launches) {
      if (
        launch.sourceStateHash === source.stateHash ||
        launch.candidateSourceStateHash === source.stateHash
      ) {
        continue;
      }
      const snapshot = await this.deps.createSnapshot({
        stateHash: source.stateHash,
        target: launch.target,
      });
      let handedOff = false;
      try {
        await this.deps.provider.prepare({
          operation: "rebuild",
          request: {
            launchId: launch.launchId,
            owner: launch.owner,
            sourceRepoPath: "projects/vibestudio",
            sourceStateHash: source.stateHash,
            dirtyCount: source.dirtyCount,
            target: launch.target,
            snapshot: providerSnapshot(snapshot),
          },
        });
        handedOff = true;
      } finally {
        if (!handedOff) await this.deps.releaseSnapshot(snapshot);
      }
    }
  }
}

export function createDevHostService(deps: DevHostServiceDeps): ServiceDefinition {
  const evalAuthorityIssuer = new DevHostEvalAuthorityIssuer(deps.parentHostId);
  const evalAuthorityBridge = {
    parentHostId: evalAuthorityIssuer.parentHostId,
    publicKeySpki: evalAuthorityIssuer.publicKeySpki,
  };
  const childEvalRoutes = new Map<
    string,
    {
      signature: string;
      initiator: ServiceContext["caller"];
      runId: string | null;
      launchId: string;
      hostBuildId: string;
      processIdentity: string;
      expiresAt: number;
    }
  >();
  const childChallengeWaiters = new Map<
    string,
    { authorityPayload: string; controller: AbortController }
  >();
  const pruneChildEvalRoutes = (now = (deps.now ?? Date.now)()) => {
    for (const [key, route] of childEvalRoutes) {
      if (route.expiresAt <= now) childEvalRoutes.delete(key);
    }
  };
  const removeChildEvalRoutes = (
    predicate: (route: {
      runId: string | null;
      launchId: string;
      hostBuildId: string;
      processIdentity: string;
    }) => boolean
  ) => {
    for (const [key, route] of childEvalRoutes) {
      if (!predicate(route)) continue;
      childEvalRoutes.delete(key);
      for (const [waiterKey, waiter] of childChallengeWaiters) {
        if (waiter.authorityPayload !== key) continue;
        waiter.controller.abort();
        childChallengeWaiters.delete(waiterKey);
      }
    }
  };
  const ownerOf = (ctx: ServiceContext, contextId: string): DevLaunchStatus["owner"] => ({
    principal: ctx.caller.code
      ? `code:${ctx.caller.code.repoPath}@${ctx.caller.code.executionDigest}`
      : ctx.caller.subject
        ? `user:${ctx.caller.subject.userId}`
        : `entity:${ctx.caller.runtime.id}`,
    workspaceId: deps.workspaceId,
    contextId,
  });
  const assertTrustedDevHostExtension = (ctx: ServiceContext, method: string): void => {
    if (
      ctx.caller.runtime.kind !== "extension" ||
      ctx.caller.code?.repoPath !== "extensions/dev-host"
    ) {
      throw new ServiceError(
        "devHost",
        method,
        "Only the exact trusted dev-host extension may use the child authority bridge",
        "EACCES"
      );
    }
  };
  const assertOwned = async (
    ctx: ServiceContext,
    launchId: string,
    capability: Parameters<DevHostServiceDeps["authorize"]>[0]["capability"]
  ): Promise<DevLaunchStatus> => {
    const launch = (await deps.provider(ctx).status()).find(
      (candidate) => candidate.launchId === launchId
    );
    if (!launch)
      throw new ServiceError(
        "devHost",
        capability.split(".").at(-1) ?? capability,
        `Unknown launch: ${launchId}`,
        "ENOENT"
      );
    const callerContext = deps.resolveCallerContext(ctx.caller.runtime.id);
    const owner = ownerOf(ctx, callerContext ?? launch.owner.contextId);
    const foreign =
      launch.owner.principal !== owner.principal || launch.owner.workspaceId !== owner.workspaceId;
    if (foreign) {
      await deps.authorize({ ctx, capability: "devHost.admin", resource: launchResource(launch) });
    }
    await deps.authorize({ ctx, capability, resource: launchResource(launch) });
    return launch;
  };

  return {
    name: "devHost",
    description: "Exact-state Vibestudio host development lifecycle",
    authority: {
      principals: ["user", "code", "host", "entity"],
    },
    methods: devHostMethods,
    handler: defineServiceHandler("devHost", devHostMethods, {
      launch: async (ctx, [input]) => {
        const callerContext = deps.resolveCallerContext(ctx.caller.runtime.id);
        const contextId = input.contextId ?? callerContext;
        if (!contextId)
          throw new ServiceError("devHost", "launch", "Caller has no bound context", "ENOCTX");
        if (input.contextId && input.contextId !== callerContext) {
          throw new ServiceError(
            "devHost",
            "launch",
            "A caller cannot name another context",
            "EACCES"
          );
        }
        const owner = ownerOf(ctx, contextId);
        const resource = `workspace:${deps.workspaceId}/context:${contextId}/repo:projects/vibestudio`;
        await deps.authorize({ ctx, capability: "service:devHost.launch", resource });
        const source = await deps.resolveSource(contextId);
        const snapshot = await deps.createSnapshot({
          stateHash: source.stateHash,
          target: input.target,
        });
        let handedOff = false;
        try {
          const launchId = deterministicLaunchId(owner, input.target, input.idempotencyKey);
          const provider = deps.provider(ctx);
          const preparation: DevHostProviderPreparationInput = {
            operation: "launch",
            request: {
              launchId,
              idempotencyKey: input.idempotencyKey,
              owner,
              sourceRepoPath: "projects/vibestudio",
              sourceStateHash: source.stateHash,
              dirtyCount: source.dirtyCount,
              target: input.target,
              snapshot: providerSnapshot(snapshot),
            },
          };
          const prepared = await provider.prepare(preparation);
          handedOff = true;
          if (!prepared.proceed) return prepared.status;
          const approvedRequest = prepared.request as typeof preparation.request;
          try {
            await deps.authorize({
              ctx,
              capability: "service:devHost.launch",
              resource,
              executionInputHash: approvedRequest.snapshot.executionInputHash,
            });
            const currentHostPairing =
              input.target.kind === "current-host-client"
                ? await deps.prepareCurrentHostClient(ctx, approvedRequest.snapshot)
                : undefined;
            return await provider.launch({
              ...approvedRequest,
              evalAuthorityBridge,
              executionGrant: {
                resource: `${resource}/execution:${approvedRequest.snapshot.executionInputHash}`,
                authorizedAt: (deps.now ?? Date.now)(),
              },
              ...(currentHostPairing ? { currentHostPairing } : {}),
            });
          } catch (error) {
            await provider
              .failPreparation(preparation, preparationFailure(error))
              .catch(() => undefined);
            throw error;
          }
        } finally {
          if (!handedOff) await deps.releaseSnapshot(snapshot);
        }
      },
      status: async (ctx, [input]) => {
        const all = await deps.provider(ctx).status();
        const contextId = deps.resolveCallerContext(ctx.caller.runtime.id);
        const owner = ownerOf(ctx, contextId ?? "unbound");
        const owned = all.filter(
          (launch) =>
            launch.owner.principal === owner.principal &&
            launch.owner.workspaceId === owner.workspaceId
        );
        let selected = input?.launchId
          ? owned.filter((launch) => launch.launchId === input.launchId)
          : owned;
        if (input?.launchId && selected.length === 0) {
          const foreign = all.find((launch) => launch.launchId === input.launchId);
          if (foreign) {
            await deps.authorize({
              ctx,
              capability: "devHost.admin",
              resource: launchResource(foreign),
            });
            selected = [foreign];
          }
        }
        await Promise.all(
          selected.map((launch) =>
            deps.authorize({
              ctx,
              capability: "service:devHost.status",
              resource: launchResource(launch),
            })
          )
        );
        return selected;
      },
      rebuild: async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.rebuild");
        const source = await deps.resolveSource(launch.owner.contextId);
        const snapshot = await deps.createSnapshot({
          stateHash: source.stateHash,
          target: launch.target,
        });
        let handedOff = false;
        try {
          const provider = deps.provider(ctx);
          const preparation: DevHostProviderPreparationInput = {
            operation: "rebuild",
            request: {
              launchId: launch.launchId,
              owner: launch.owner,
              sourceRepoPath: "projects/vibestudio",
              sourceStateHash: source.stateHash,
              dirtyCount: source.dirtyCount,
              target: launch.target,
              snapshot: providerSnapshot(snapshot),
            },
          };
          const prepared = await provider.prepare(preparation);
          handedOff = true;
          if (!prepared.proceed) {
            return providerBuildResult(prepared.status, snapshot.executionInputHash);
          }
          const approvedRequest = prepared.request as typeof preparation.request;
          try {
            await deps.authorize({
              ctx,
              capability: "service:devHost.rebuild",
              resource: launchResource(launch),
              executionInputHash: approvedRequest.snapshot.executionInputHash,
            });
            const currentHostPairing =
              launch.target.kind === "current-host-client"
                ? await deps.prepareCurrentHostClient(ctx, approvedRequest.snapshot)
                : undefined;
            const result = await provider.rebuild({
              ...approvedRequest,
              evalAuthorityBridge,
              executionGrant: {
                resource: `${launchResource(launch)}/execution:${approvedRequest.snapshot.executionInputHash}`,
                authorizedAt: (deps.now ?? Date.now)(),
              },
              ...(currentHostPairing ? { currentHostPairing } : {}),
            });
            if (result.active && result.hostBuildId) {
              removeChildEvalRoutes(
                (route) =>
                  route.launchId === launch.launchId && route.hostBuildId !== result.hostBuildId
              );
            }
            return result;
          } catch (error) {
            await provider
              .failPreparation(preparation, preparationFailure(error))
              .catch(() => undefined);
            throw error;
          }
        } finally {
          if (!handedOff) await deps.releaseSnapshot(snapshot);
        }
      },
      stop: async (ctx, [input]) => {
        await assertOwned(ctx, input.launchId, "service:devHost.stop");
        const result = await deps.provider(ctx).stop(input.launchId);
        removeChildEvalRoutes((route) => route.launchId === input.launchId);
        return result;
      },
      "eval.start": async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.eval.start");
        if (!launch.activeHostBuildId || launch.state === "stopped" || launch.state === "failed") {
          throw new ServiceError(
            "devHost",
            "eval.start",
            "Launch has no ready active generation",
            "ENOTREADY"
          );
        }
        if (
          !launch.readinessIdentity ||
          !launch.readinessIdentity.evalAuthorityRecipientKey ||
          !launch.processIdentity ||
          !launch.childWorkspaceId
        ) {
          throw new ServiceError(
            "devHost",
            "eval.start",
            "Active generation has no complete child authority identity",
            "ENOTREADY"
          );
        }
        const generation = {
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          childServerId: launch.readinessIdentity.serverId,
          processIdentity: launch.processIdentity,
          childWorkspaceId: launch.childWorkspaceId,
          childContextId: launch.childContextId ?? "unbound",
          recipientPublicKey: launch.readinessIdentity.evalAuthorityRecipientKey,
        };
        const authority = evalAuthorityIssuer.issue({
          generation,
          initiator: ctx.caller,
          start: input.input,
          now: (deps.now ?? Date.now)(),
          ...(input.input.deadlineMs
            ? { ttlMs: Math.max(60_000, input.input.deadlineMs + 60_000) }
            : {}),
        });
        const attested = decodeDevHostEvalAuthority(authority);
        pruneChildEvalRoutes();
        if (childEvalRoutes.size >= 256) {
          throw new ServiceError(
            "devHost",
            "eval.start",
            "Live child eval authority route limit exceeded",
            "EVAL_RESOURCE_LIMIT"
          );
        }
        childEvalRoutes.set(authority.payload, {
          signature: authority.signature,
          initiator: structuredClone(ctx.caller),
          runId: null,
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          processIdentity: launch.processIdentity,
          expiresAt: attested.expiresAt,
        });
        let handle: EvalRunHandle;
        try {
          handle = await deps.provider(ctx).evalStart(input.launchId, input.input, authority);
          const route = childEvalRoutes.get(authority.payload);
          if (!route) {
            await deps.provider(ctx).evalCancel(input.launchId, { runId: handle.runId });
            throw new ServiceError(
              "devHost",
              "eval.start",
              "Parent approval route was lost before child eval acceptance",
              "EVAL_APPROVAL_ROUTE_LOST"
            );
          }
          route.runId = handle.runId;
        } catch (error) {
          removeChildEvalRoutes((route) => route === childEvalRoutes.get(authority.payload));
          throw error;
        }
        return {
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          sourceStateHash: launch.sourceStateHash,
          handle,
        };
      },
      "eval.confirmChildRoute": async (ctx, [input]) => {
        assertTrustedDevHostExtension(ctx, "eval.confirmChildRoute");
        const route = childEvalRoutes.get(input.authority.payload);
        if (
          !route ||
          route.signature !== input.authority.signature ||
          route.launchId !== input.launchId ||
          route.hostBuildId !== input.hostBuildId ||
          route.processIdentity !== input.processIdentity ||
          route.expiresAt <= (deps.now ?? Date.now)()
        ) {
          throw new ServiceError(
            "devHost",
            "eval.confirmChildRoute",
            "Parent approval route is absent or stale",
            "EVAL_APPROVAL_ROUTE_LOST"
          );
        }
        const launch = (await deps.provider(ctx).status()).find(
          (candidate) => candidate.launchId === route.launchId
        );
        if (
          !launch ||
          launch.activeHostBuildId !== route.hostBuildId ||
          launch.processIdentity !== route.processIdentity ||
          launch.state !== "ready"
        ) {
          removeChildEvalRoutes((candidate) => candidate === route);
          throw new ServiceError(
            "devHost",
            "eval.confirmChildRoute",
            "Child generation is no longer active",
            "EVAL_INTERRUPTED"
          );
        }
        const attested = decodeDevHostEvalAuthority(input.authority);
        return {
          proof: evalAuthorityIssuer.issueApprovalRoute({
            generation: {
              launchId: attested.launchId,
              hostBuildId: attested.hostBuildId,
              childServerId: attested.childServerId,
              processIdentity: attested.processIdentity,
              childWorkspaceId: attested.childWorkspaceId,
              childContextId: attested.childContextId,
              recipientPublicKey: attested.recipientPublicKey,
            },
            authority: input.authority,
            now: (deps.now ?? Date.now)(),
          }),
        };
      },
      "eval.get": async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.eval.get");
        if (!launch.activeHostBuildId) {
          throw new ServiceError(
            "devHost",
            "eval.get",
            "Launch has no active generation",
            "ENOTREADY"
          );
        }
        return {
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          sourceStateHash: launch.sourceStateHash,
          snapshot: await deps.provider(ctx).evalGet(input.launchId, input.input),
        };
      },
      "eval.events": async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.eval.events");
        if (!launch.activeHostBuildId) {
          throw new ServiceError(
            "devHost",
            "eval.events",
            "Launch has no active generation",
            "ENOTREADY"
          );
        }
        return {
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          sourceStateHash: launch.sourceStateHash,
          page: await deps.provider(ctx).evalEvents(input.launchId, input.input),
        };
      },
      "eval.cancel": async (ctx, [input]) => {
        const launch = await assertOwned(ctx, input.launchId, "service:devHost.eval.cancel");
        if (!launch.activeHostBuildId) {
          throw new ServiceError(
            "devHost",
            "eval.cancel",
            "Launch has no active generation",
            "ENOTREADY"
          );
        }
        const result = {
          launchId: launch.launchId,
          hostBuildId: launch.activeHostBuildId,
          sourceStateHash: launch.sourceStateHash,
          ...(await deps.provider(ctx).evalCancel(input.launchId, input.input)),
        };
        removeChildEvalRoutes(
          (route) => route.launchId === input.launchId && route.runId === input.input.runId
        );
        return result;
      },
      "eval.resolveChildChallenge": async (ctx, [input]) => {
        assertTrustedDevHostExtension(ctx, "eval.resolveChildChallenge");
        const route = childEvalRoutes.get(input.authority.payload);
        if (
          !route ||
          route.signature !== input.authority.signature ||
          route.runId !== input.runId ||
          route.launchId !== input.launchId ||
          route.hostBuildId !== input.hostBuildId ||
          route.processIdentity !== input.processIdentity ||
          route.expiresAt <= (deps.now ?? Date.now)()
        ) {
          throw new ServiceError(
            "devHost",
            "eval.resolveChildChallenge",
            "Child challenge route is stale or belongs to another run generation",
            "EVAL_INVOCATION_INVALID"
          );
        }
        const launch = (await deps.provider(ctx).status()).find(
          (candidate) => candidate.launchId === route.launchId
        );
        if (
          !launch ||
          launch.activeHostBuildId !== route.hostBuildId ||
          launch.processIdentity !== route.processIdentity ||
          launch.state !== "ready"
        ) {
          childEvalRoutes.delete(input.authority.payload);
          throw new ServiceError(
            "devHost",
            "eval.resolveChildChallenge",
            "Child generation was replaced while approval was pending",
            "EVAL_INTERRUPTED"
          );
        }
        const waiterKey = `${input.authority.payload}\0${input.challengeId}`;
        if (childChallengeWaiters.has(waiterKey)) {
          throw new ServiceError(
            "devHost",
            "eval.resolveChildChallenge",
            "Child challenge is already awaiting a parent decision",
            "EVAL_IDEMPOTENCY_CONFLICT"
          );
        }
        const controller = new AbortController();
        childChallengeWaiters.set(waiterKey, {
          authorityPayload: input.authority.payload,
          controller,
        });
        try {
          return {
            decision: await deps.resolveChildChallenge({
              initiator: route.initiator,
              launch,
              runId: input.runId,
              challengeId: input.challengeId,
              capability: input.capability,
              resource: input.resource,
              allowedDecisions: input.allowedDecisions,
              signal: controller.signal,
            }),
          };
        } finally {
          childChallengeWaiters.delete(waiterKey);
        }
      },
      "eval.cancelChildChallenge": async (ctx, [input]) => {
        assertTrustedDevHostExtension(ctx, "eval.cancelChildChallenge");
        const route = childEvalRoutes.get(input.authority.payload);
        if (
          !route ||
          route.signature !== input.authority.signature ||
          route.runId !== input.runId ||
          route.launchId !== input.launchId ||
          route.hostBuildId !== input.hostBuildId ||
          route.processIdentity !== input.processIdentity
        ) {
          return { cancelled: false };
        }
        const waiter = childChallengeWaiters.get(
          `${input.authority.payload}\0${input.challengeId}`
        );
        if (!waiter) return { cancelled: false };
        waiter.controller.abort();
        return { cancelled: true };
      },
      "eval.completeChildRun": async (ctx, [input]) => {
        assertTrustedDevHostExtension(ctx, "eval.completeChildRun");
        const route = childEvalRoutes.get(input.authority.payload);
        if (
          !route ||
          route.signature !== input.authority.signature ||
          route.runId !== input.runId ||
          route.launchId !== input.launchId ||
          route.hostBuildId !== input.hostBuildId ||
          route.processIdentity !== input.processIdentity
        ) {
          return { released: false };
        }
        removeChildEvalRoutes((candidate) => candidate === route);
        return { released: true };
      },
      logs: async (ctx, [input]) => {
        await assertOwned(ctx, input.launchId, "service:devHost.logs");
        return deps.provider(ctx).logs(input.launchId, input.after);
      },
      watch: async (ctx, [input]) => {
        await assertOwned(ctx, input.launchId, "service:devHost.watch");
        return deps.provider(ctx).watch(input.launchId, input.after);
      },
    }),
  };
}

function launchResource(launch: DevLaunchStatus): string {
  return `workspace:${launch.owner.workspaceId}/context:${launch.owner.contextId}/repo:${launch.sourceRepoPath}/launch:${launch.launchId}`;
}

function providerSnapshot(snapshot: ExecutionSnapshot): DevHostProviderLaunchInput["snapshot"] {
  return {
    snapshotId: snapshot.snapshotId,
    executionInputHash: snapshot.executionInputHash,
    recipeDigest: snapshot.recipeDigest,
    sourceRoot: snapshot.sourceRoot,
    scratchRoot: snapshot.scratchRoot,
    manifestPath: snapshot.manifestPath,
    createdAt: snapshot.createdAt,
  };
}

function deterministicLaunchId(
  owner: DevLaunchStatus["owner"],
  target: DevHostTarget,
  key: string
): string {
  const input = JSON.stringify({ owner, target, key });
  return `dev_${domainHash("vibestudio/dev-host-launch/v1", input)}`;
}

function preparationFailure(error: unknown): DevHostProviderPreparationFailure {
  return {
    phase: "approval",
    code:
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "DEV_HOST_PREPARATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function providerBuildResult(
  status: DevLaunchStatus,
  executionInputHash: string
): Awaited<ReturnType<DevHostProvider["rebuild"]>> {
  return {
    launchId: status.launchId,
    executionInputHash,
    hostBuildId: status.activeHostBuildId,
    active: status.state === "ready" && status.executionInputHash === executionInputHash,
    state: status.state,
  };
}
