import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  evalMethods,
  normalizeEvalAuthorityIntent,
  type EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import {
  getInternalDOBundle,
  internalDOExecutionIdentity,
  INTERNAL_DO_SOURCE,
} from "../internalDOs/internalDoLoader.js";
import { AmbiguousDoDispatchError, type HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import { createHash, randomUUID } from "node:crypto";
import { evalRuntimeId } from "@vibestudio/shared/evalRuntimeIdentity";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { resourceScopeContains } from "@vibestudio/shared/authorization";
import type { RuntimeAgentBinding } from "@vibestudio/shared/runtime/entitySpec";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { taskAuthorityPrincipal, type TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import { resolveCodeIdentity } from "./principalIdentity.js";
import { EvalKernelLeaseCoordinator, type EvalKernelLease } from "./evalKernelLease.js";

/**
 * A deadline is not evidence that workerd is unhealthy. This is only the
 * irreducible external bound on a side-effect-free liveness probe after the
 * EvalDO has had its own opportunity to abort and settle the run.
 */
const DEFAULT_EVAL_LIVENESS_PROBE_MS = 5_000;

/** One quick retry absorbs a transient transport blip before recovery. */
const PROBE_REJECTION_RETRY_MS = 250;

interface EvalSandboxRecoveryInput {
  runId: string;
  timeoutMs: number;
  evalDoRef: { source: string; className: string; objectKey: string };
}

export type EvalShutdown = (deadlineMs?: number) => Promise<void>;

export const evalServiceDocumentation = {
  name: "eval",
  description: "Owner-scoped sandbox eval backed by a per-owner internal EvalDO",
  authority: { principals: ["code", "user", "host"] },
  methods: evalMethods,
} satisfies Omit<ServiceDefinition, "handler">;

interface ActiveEvalRun {
  evalDoRef: { source: string; className: string; objectKey: string };
  runId: string;
  closeAdmission: () => void;
}

type LivenessObservation =
  | { kind: "live"; terminal: boolean }
  | { kind: "unresponsive" }
  | { kind: "rejected"; error: unknown };

function supervisorDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One side-effect-free probe of the canonical run record, bounded by
 * `probeBoundMs`. Any response proves the isolate can still execute host work;
 * a response that cannot arrive (hang past the bound, or transport rejection)
 * is the only evidence this supervisor acts on.
 */
async function observeRunLiveness(
  doDispatch: HeldDoDispatcher,
  evalDoRef: { source: string; className: string; objectKey: string },
  runId: string,
  probeBoundMs: number
): Promise<LivenessObservation> {
  const unresponsive = Symbol("eval-liveness-probe-unresponsive");
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      doDispatch.dispatch(evalDoRef, "getRun", runId).then(
        (snapshot) => ({ kind: "live" as const, snapshot }),
        (error: unknown) => ({ kind: "rejected" as const, error })
      ),
      new Promise<typeof unresponsive>((resolve) => {
        probeTimer = setTimeout(() => resolve(unresponsive), probeBoundMs);
        probeTimer.unref?.();
      }),
    ]);
    if (outcome === unresponsive) return { kind: "unresponsive" };
    if (outcome.kind === "rejected") return outcome;
    const status = (outcome.snapshot as { status?: string } | null)?.status;
    return {
      kind: "live",
      terminal:
        status === "done" ||
        status === "cancelled" ||
        status === "approval-route-lost" ||
        status === "unknown",
    };
  } finally {
    if (probeTimer !== undefined) clearTimeout(probeTimer);
  }
}

/**
 * Isolate liveness supervisor for one explicitly timed run.
 *
 * A synchronous CPU loop can prevent the EvalDO's own AbortSignal timer from
 * firing, so after the caller's deadline the host probes the canonical run.
 * Probes are side-effect-free and exist only to enforce that opt-in deadline.
 *
 * A live response does not disarm supervision because the isolate may wedge
 * during post-abort cleanup. Disposal is terminal status or admission close.
 */
async function superviseIsolateLiveness(input: {
  doDispatch: HeldDoDispatcher;
  evalDoRef: { source: string; className: string; objectKey: string };
  runId: string;
  timeoutMs: number;
  livenessProbeMs: number;
  recoverUnresponsiveSandbox: (input: EvalSandboxRecoveryInput) => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { doDispatch, evalDoRef, runId, timeoutMs, livenessProbeMs, signal } = input;
  await supervisorDelay(timeoutMs, signal);
  let retriedRejection = false;
  while (!signal.aborted) {
    const observation = await observeRunLiveness(doDispatch, evalDoRef, runId, livenessProbeMs);
    if (signal.aborted) return;
    if (observation.kind === "live") {
      if (observation.terminal) return;
      retriedRejection = false;
      await supervisorDelay(livenessProbeMs, signal);
      continue;
    }
    if (observation.kind === "rejected" && !retriedRejection) {
      retriedRejection = true;
      await supervisorDelay(Math.min(PROBE_REJECTION_RETRY_MS, livenessProbeMs), signal);
      continue;
    }
    await input.recoverUnresponsiveSandbox({ runId, timeoutMs, evalDoRef });
    return;
  }
}

const EVAL_DO_CLASS = "EvalDO";

function normalizeAuthorityManifest(
  runArgs: EvalStartInput,
  initiatingRequests: readonly import("@vibestudio/rpc").CapabilityScope[]
): import("@vibestudio/rpc").EvalAuthorityManifest {
  const intent = normalizeEvalAuthorityIntent(runArgs.authority);
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

interface EvalOwner {
  ownerId: string;
  contextId: string;
}

/** Server-resolved launch parent for an eval session (the owning panel). */
interface EvalParentMeta {
  parentId: string;
  parentEntityId: string;
  parentKind: "panel";
}

/**
 * Owner-scoped sandbox eval service — replaces the `scope` service. Any entity-principal
 * (panel/app/worker/do/shell) calls `eval.start`/`eval.reset`; the owner is the verified
 * `ctx.caller` unless a privileged shell/server caller selects a live session owner. The EvalDO
 * `objectKey` is derived (hashed) from the owner id + subKey, so unprivileged callers can
 * only address their own EvalDO. The EvalDO entity is registered with the owner's context so
 * the kernel's own fs/git/vcs resolve the owner's workspace.
 */
export function createEvalService(deps: {
  /** Generic DO dispatcher — used to invoke `run`/`reset` on the per-owner EvalDO. */
  doDispatch: HeldDoDispatcher;
  /**
   * The single owner of WorkspaceDO entity state. Eval registers the EvalDO
   * entity via `store.activate`, which pairs the durable write with the server
   * hot-cache mirror. Bypassing it (dispatching `entityActivate` directly) is
   * exactly what caused every EvalDO→main RPC to 403 with "Unknown principal
   * kind" — the cache never learned the EvalDO's identity.
   */
  entityStore: WorkspaceEntityStore;
  /** Host lifecycle owner used to retire a disposed EvalDO through the normal
   * release, relay-drain, cleanup, and durable-reaper path. */
  retireEntity: (id: string) => Promise<void>;
  tokenManager: TokenManager;
  workspaceId: string;
  executionSessions: AgentExecutionSessionRegistry;
  taskAuthorities: TaskAuthorityRegistry;
  isSystemTestHarness?: (caller: ServiceContext["caller"], runId: string) => boolean;
  /**
   * Host-wide background-work registry (idle-exit monitor). Every admitted run
   * holds a lease until its trusted terminal event; explicit timeout watchdogs
   * hold a second lease while host recovery is still in flight.
   */
  activity?: import("./activityRegistry.js").ActivityRegistry;
  /** Host-process safety boundary for synchronous sandbox CPU starvation. */
  recoverUnresponsiveSandbox?: (input: EvalSandboxRecoveryInput) => Promise<void>;
  /** Bound on one side-effect-free liveness probe (and the interval between probes). */
  livenessProbeMs?: number;
  /** Test seam; production uses one held inter-cell lease per EvalDO. */
  kernelLeases?: EvalKernelLease;
  /** Receives the production coordinator so ordered server shutdown can close its held requests. */
  onKernelLeaseCoordinator?: (coordinator: EvalKernelLeaseCoordinator) => void;
  /** Receives the shared eval admission drain used by ordered server shutdown. */
  onShutdown?: (shutdown: EvalShutdown) => void;
  /** Canonical dispatcher authorization-only path for exact prospective calls. */
  preauthorize?: (
    ctx: ServiceContext,
    operation: { service: string; method: string; args: unknown[] }
  ) => Promise<void>;
  eventSinks?: {
    register(route: {
      nonce: string;
      runtimeId: string;
      runId: string;
      contextId: string;
      ownerCallerId: string;
      initiatorCallerId: string;
      subKey: string;
      onTerminal?: () => void;
    }): void;
    close(nonce: string): void;
  };
  resolveContextSource?: (
    contextId: string,
    path: string
  ) => Promise<{
    code: string;
    sourceDigest: string;
    sourceState: import("@vibestudio/service-schemas/vcs").VcsStateNodeRef;
    contentStateHash: string;
  }>;
}): ServiceDefinition {
  const store = deps.entityStore;
  const kernelLeases =
    deps.kernelLeases ??
    new EvalKernelLeaseCoordinator(deps.doDispatch, {
      onError: (message, error) =>
        console.warn(message, error instanceof Error ? error.message : error),
    });
  if (!deps.kernelLeases && kernelLeases instanceof EvalKernelLeaseCoordinator) {
    deps.onKernelLeaseCoordinator?.(kernelLeases);
  }
  const activeRuns = new Map<string, ActiveEvalRun>();
  /**
   * One liveness supervisor per admitted timed run. Replayed starts for the
   * same runId join the existing supervision instead of arming another loop
   * (which would also restart the deadline wait against a shifted clock).
   */
  const runSupervisions = new Map<string, { dispose: () => void }>();
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;
  const evalExecutionIdentity = internalDOExecutionIdentity(getInternalDOBundle(), EVAL_DO_CLASS);

  const evalDoKey = (ownerId: string, subKey: string): string =>
    evalRuntimeId(ownerId, subKey).slice(`do:${INTERNAL_DO_SOURCE}:${EVAL_DO_CLASS}:`.length);

  /** The EvalDO identity and object-key derivation share one canonical helper. */
  const evalDoEntityId = (objectKey: string): string =>
    `do:${INTERNAL_DO_SOURCE}:${EVAL_DO_CLASS}:${objectKey}`;

  const activeRunKey = (evalRuntimeId: string, runId: string): string =>
    `${evalRuntimeId}\0${runId}`;

  const shutdown = (deadlineMs = 4_000): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownRequested = true;
    shutdownPromise = (async () => {
      const entries = [...activeRuns.values()];
      if (entries.length === 0) return;

      const cancellations = Promise.allSettled(
        entries.map(async (entry) => {
          try {
            await deps.doDispatch.dispatch(entry.evalDoRef, "cancel", entry.runId);
          } finally {
            // The durable EvalDO owns terminal truth. Once cancellation has
            // either completed or failed, remove the host admission so a
            // disappearing workerd cannot leave authority/activity state live.
            entry.closeAdmission();
          }
        })
      );
      const result = await settlePromiseWithin(cancellations, deadlineMs);
      if (!result.settled) {
        throw new Error(
          `eval shutdown cancellation exceeded its ${Math.max(0, deadlineMs)}ms drain budget`
        );
      }
      const failures = result.value
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => item.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "eval shutdown cancellation failed");
      }
    })();
    return shutdownPromise;
  };
  deps.onShutdown?.(shutdown);

  /**
   * Owner-scoped gateway token for THIS EvalDO. Pinned to the concrete
   * `do:vibestudio/internal:EvalDO:<objectKey>` identity (kind `do`), NOT the
   * shared `do-service:*` bearer — so the kernel's `gatewayFetch` resolves the
   * owner's context and a leak's blast radius is the owner alone (eval code can
   * read `gatewayConfig.token`, but it IS the owner's own authority). Minted
   * here (server-internal, owner already verified) and handed to `EvalDO.run`
   * over the authenticated server→DO dispatch — no new callable token-issuing
   * surface, so nothing rides the worker→do policy fallthrough. `ensureToken`
   * is idempotent per callerId, so it's a stable per-owner token.
   */
  const mintGatewayToken = (objectKey: string): string =>
    deps.tokenManager.ensureToken(evalDoEntityId(objectKey), "do");

  async function resolveRegisteredContext(ownerId: string): Promise<string | null> {
    return store.resolveContext(ownerId);
  }

  /**
   * Resolve the nearest panel ancestor-or-self of `callerId` from the entity
   * store (cache-first) — the panel that "owns" this eval. Walks `parentId` up
   * the launch chain: a panel caller resolves to itself; an agent/worker caller
   * resolves to its owning panel (recorded at `runtime.createEntity` from the
   * verified caller); anything with no panel ancestor → null. Server-
   * authoritative — never eval user input. Becomes `RunArgs.parent`, from which
   * the EvalDO derives the portable `parent`/`getParent`.
   */
  async function resolveParentPanel(callerId: string): Promise<EvalParentMeta | null> {
    // Shared resolver: walk the entity lineage to the nearest OPEN panel and return its TREE SLOT id
    // (durable nav→slot via the slot store — the SAME source the server create handler uses, so the
    // eval's defaultOpenParentId and the server's nesting decision can't drift, and it works even when
    // the owning panel isn't currently loaded). The lineage is entity-id space, so a node is never
    // itself a slot id (isOpenSlot is constant false here).
    const slotId = await resolveOwningPanelSlot(callerId, {
      isOpenSlot: () => false,
      resolveOpenSlotForEntity: async (id) => (await store.resolveSlotByEntity(id)) ?? undefined,
      resolveParentId: async (id) =>
        (store.cache.resolve(id) ?? (await store.resolveRecord(id)))?.parentId,
    });
    if (!slotId) return null;
    // parentEntityId is only consumed for worker/do parent kinds (createRuntimeParentHandle); a panel
    // parent resolves via getPanelHandle(slotId), so the slot id is the operative identity.
    return { parentId: slotId, parentEntityId: slotId, parentKind: "panel" };
  }

  async function resolveOwner(
    callerKind: string,
    callerId: string,
    target: EvalRoute["target"],
    agentBinding?: { entityId: string; contextId: string }
  ): Promise<EvalOwner> {
    // Agent callers (plan §6.4): the host-verified entity binding IS the owner
    // and context the EvalDO trusts. Client-supplied ownerId/contextId are never
    // honored as overrides for an autonomous agent — if present they must match
    // the binding, else the call is rejected (no cross-entity escalation).
    if (callerKind === "agent") {
      if (!agentBinding) {
        throw new Error("eval: agent caller has no entity binding");
      }
      if (target?.kind === "owner-session" && target.sessionId !== agentBinding.entityId)
        throw new Error("eval: agent target must match the connection's entity binding");
      return { ownerId: agentBinding.entityId, contextId: agentBinding.contextId };
    }
    if (target?.kind === "owner-session") {
      if (callerKind !== "shell" && callerKind !== "server") {
        throw new Error("eval: owner-session targets are restricted to shell/server callers");
      }
      const registeredContext = await resolveRegisteredContext(target.sessionId);
      if (registeredContext == null) {
        throw new Error(`eval: no context registered for owner session ${target.sessionId}`);
      }
      return { ownerId: target.sessionId, contextId: registeredContext };
    }

    const contextId = await resolveRegisteredContext(callerId);
    if (contextId == null) {
      throw new Error(`eval: no context registered for caller ${callerId}`);
    }
    return { ownerId: callerId, contextId };
  }

  async function ensureEvalDO(
    owner: EvalOwner,
    subKey: string,
    ownerUserId: string | undefined,
    agentBinding: RuntimeAgentBinding | undefined,
    requestedLifecycle: "finite" | "persistent" | undefined
  ): Promise<{ objectKey: string }> {
    const { ownerId, contextId } = owner;
    const objectKey = evalDoKey(ownerId, subKey);
    // Fast path: the EvalDO entity is sticky (idle-eviction aborts the instance
    // but never retires the entity), so once it's active in the cache for the
    // right context there's nothing to do — re-activating every run is a wasted
    // WorkspaceDO round-trip. Gating on the cache (not a private "seen" set)
    // keeps us self-consistent: a retired entity (cache miss) or a fresh server
    // process (empty cache) re-activates; the cache IS the source of truth the
    // server's principal resolution reads.
    const active = store.cache.resolveActive(evalDoEntityId(objectKey));
    const activeStateArgs =
      active?.stateArgs && typeof active.stateArgs === "object" && !Array.isArray(active.stateArgs)
        ? (active.stateArgs as Record<string, unknown>)
        : null;
    const activeLifecycle = active
      ? activeStateArgs?.["lifecycle"] === "finite"
        ? "finite"
        : "persistent"
      : undefined;
    if (active && requestedLifecycle && activeLifecycle !== requestedLifecycle) {
      throw new ServiceError(
        "eval",
        "start",
        `Eval scope ${subKey} was created as ${activeLifecycle} and cannot be reclassified as ${requestedLifecycle}`,
        "EINVAL",
        undefined,
        "application"
      );
    }
    // Lookup/control methods do not declare lifecycle intent. Preserve an
    // existing entity's immutable class; only a missing scope defaults to the
    // ordinary persistent notebook class.
    const effectiveLifecycle = requestedLifecycle ?? activeLifecycle ?? "persistent";
    if (
      active &&
      active.contextId === contextId &&
      JSON.stringify(active.agentBinding ?? null) === JSON.stringify(agentBinding ?? null) &&
      activeStateArgs?.["ownerPrincipalId"] === ownerId &&
      typeof activeStateArgs["agentExecutionAdmission"] === "object" &&
      active.activeBuildKey === evalExecutionIdentity.buildKey &&
      active.activeExecutionDigest === evalExecutionIdentity.executionDigest
    ) {
      return { objectKey };
    }
    // Register/refresh the EvalDO entity with the owner's context so the kernel's
    // own fs/git/vcs calls resolve the owner's workspace. The store pairs the
    // durable upsert with the server hot-cache mirror, so the server can resolve
    // THIS EvalDO's principal when it calls back to `main`. Idempotent.
    const activation = {
      kind: "do",
      source: {
        repoPath: INTERNAL_DO_SOURCE,
        effectiveVersion: evalExecutionIdentity.effectiveVersion,
      },
      contextId,
      className: EVAL_DO_CLASS,
      key: objectKey,
      activeBuildKey: evalExecutionIdentity.buildKey,
      activeExecutionDigest: evalExecutionIdentity.executionDigest,
      activeAuthority: evalExecutionIdentity.authority,
      // The EvalDO's launch parent IS its owner. An entity spawned FROM an eval (e.g. a headless
      // sub-agent the orchestrator's eval creates via runtime.createEntity) records THIS EvalDO as its
      // parentId — so without this link the lineage dead-ends at the EvalDO and the sub-agent's panels
      // resolve to root. With it, the walk continues owner → owner's panel, so the sub-agent's panels
      // nest under the owner's panel. ownerId is stable; the panel is re-resolved live at walk time.
      parentId: ownerId,
      // Attribute the EvalDO to the human whose subject launched this run (WP0
      // §6). Write-once, so the first activation's owner sticks; undefined for a
      // bootstrap caller with no subject.
      ownerUserId,
      agentBinding,
      stateArgs: {
        ownerPrincipalId: ownerId,
        subKey,
        agentExecutionAdmission: { v: 1, ownerId },
        ...(effectiveLifecycle === "finite" ? { lifecycle: "finite" as const } : {}),
      },
    } as const;
    if (active) {
      await store.advanceExecution(activation);
    } else {
      await store.activate(activation);
    }
    return { objectKey };
  }

  type EvalRoute = {
    target?: { kind: "caller" } | { kind: "owner-session"; sessionId: string };
    scopeKey?: string;
  };

  async function resolveOwnerForCaller(
    ctx: ServiceContext,
    requested: EvalRoute
  ): Promise<EvalOwner> {
    return await resolveOwner(
      ctx.caller.runtime.kind,
      ctx.caller.runtime.id,
      requested.target,
      ctx.caller.agentBinding
    );
  }

  function trustedAgentRelay(ctx: ServiceContext): RuntimeAgentBinding | undefined {
    if (ctx.caller.runtime.kind === "agent") {
      const binding = ctx.caller.agentBinding;
      return binding
        ? {
            entityId: binding.entityId,
            contextId: binding.contextId,
            channelId: binding.channelId,
          }
        : undefined;
    }
    if (ctx.caller.runtime.kind !== "do" && ctx.caller.runtime.kind !== "worker") {
      return undefined;
    }
    return store.cache.resolveActive(ctx.caller.runtime.id)?.agentBinding;
  }

  async function evalDoRefFor(
    ctx: ServiceContext,
    route: EvalRoute
  ): Promise<{ source: string; className: string; objectKey: string }> {
    const owner = await resolveOwnerForCaller(ctx, route);
    const agentBinding = trustedAgentRelay(ctx);
    const { objectKey } = await ensureEvalDO(
      owner,
      route.scopeKey ?? "default",
      ctx.caller.subject?.userId,
      agentBinding,
      undefined
    );
    return { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey };
  }

  async function prepareRun(
    ctx: ServiceContext,
    runArgs: EvalStartInput,
    runId: string
  ): Promise<{
    evalDoRef: { source: string; className: string; objectKey: string };
    assembledArgs: Record<string, unknown>;
    agentRef: string | undefined;
    channelId: string | undefined;
    runDigest: string;
    authorityManifestDigest: string;
    eventSinkNonce: string;
    activityId: string | undefined;
  }> {
    const owner = await resolveOwnerForCaller(ctx, runArgs);
    const ownerId = owner.ownerId;
    const exactSource =
      runArgs.source.kind === "inline"
        ? {
            code: runArgs.source.code,
            sourceDigest: createHash("sha256").update(runArgs.source.code).digest("hex"),
            sourceState: undefined,
            contentStateHash: undefined,
          }
        : deps.resolveContextSource
          ? await deps.resolveContextSource(owner.contextId, runArgs.source.path)
          : (() => {
              throw new ServiceError(
                "eval",
                "start",
                "Exact semantic context-file resolution is unavailable",
                "EUNAVAILABLE",
                undefined,
                "service"
              );
            })();
    const agentBinding = trustedAgentRelay(ctx);
    if (agentBinding && !ctx.causalParent) {
      throw new ServiceError(
        "eval",
        "start",
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
          "eval",
          "start",
          "Agent eval cause does not belong to the relay's host-bound trajectory",
          "EACCES",
          undefined,
          "access"
        );
      }
    }
    // Refuse an unscoped or trajectory-drifting agent relay before activating
    // an EvalDO or exposing any presenter authority ceiling.
    const { objectKey } = await ensureEvalDO(
      owner,
      runArgs.scope?.key ?? "default",
      ctx.caller.subject?.userId,
      agentBinding,
      runArgs.scope?.lifecycle ?? "persistent"
    );
    const isAgentDo = ctx.caller.runtime.kind === "do" && agentBinding !== undefined;
    if (runArgs.resultReceiver && !isAgentDo) {
      throw new ServiceError(
        "eval",
        "start",
        "This caller does not expose the eval terminal receiver contract",
        "EINVAL",
        undefined,
        "application"
      );
    }
    const timeoutMs = runArgs.timeoutMs;
    const chatBinding = isAgentDo ? { channelId: agentBinding.channelId, agentRef: ownerId } : {};
    const parent = (await resolveParentPanel(ownerId)) ?? undefined;
    const evalRuntimeId = evalDoEntityId(objectKey);
    const ownerHarness = resolveCodeIdentity(store.cache, ownerId);
    const harness = ownerHarness
      ? {
          repoPath: ownerHarness.repoPath,
          effectiveVersion: ownerHarness.effectiveVersion,
          executionDigest: ownerHarness.executionDigest,
        }
      : {
          repoPath: evalExecutionIdentity.source,
          effectiveVersion: evalExecutionIdentity.effectiveVersion,
          executionDigest: evalExecutionIdentity.executionDigest,
        };
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
    const parentAdmission = ctx.caller.executionSession ?? null;
    const mission = parentAdmission?.mission ?? null;
    const inheritedTestPolicy = deps.executionSessions.testPolicyForContext(owner.contextId);
    const testPolicy =
      !mission &&
      (inheritedTestPolicy ??
        (deps.isSystemTestHarness?.(ctx.caller, runId)
          ? deps.executionSessions.createTestPolicy(runId)
          : null));
    const eventSinkNonce = randomUUID();
    const taskRef = agentBinding?.channelId ?? `eval:${ownerId}:${runId}`;
    const ownerUser = `user:${ctx.caller.subject.userId}` as const;
    const taskAuthority =
      deps.taskAuthorities.resolveCaller(ctx.caller, store.cache) ??
      taskAuthorityPrincipal({ workspaceId: deps.workspaceId, ownerUser, taskRef });
    const executionSession = await deps.executionSessions.admitWhenAvailable(
      {
        mode: mission ? "mission" : testPolicy ? "test" : "interactive",
        ownerUser,
        workspaceId: deps.workspaceId,
        contextId: owner.contextId,
        agentBinding: agentBinding
          ? {
              entityId: agentBinding.entityId,
              channelId: agentBinding.channelId,
              bindingId: `${agentBinding.entityId}@${agentBinding.contextId}`,
            }
          : null,
        taskRef,
        taskAuthority,
        admissionKey: `eval:${evalRuntimeId}:${runId}`,
        executionImage: {
          principal: codePrincipal(harness),
          repoPath: harness.repoPath,
          ref: `state:${harness.executionDigest}`,
          effectiveVersion: harness.effectiveVersion,
          executionDigest: harness.executionDigest,
        },
        executor: {
          kind: "eval",
          runtimeId: evalRuntimeId,
          evalRunId: runId,
          authorityManifest: normalizeAuthorityManifest(runArgs, ctx.caller.code?.requested ?? []),
          eventSinkNonce,
        },
        ...(mission ? { mission } : {}),
        ...(parentAdmission?.operationPolicyDigest
          ? { operationPolicyDigest: parentAdmission.operationPolicyDigest }
          : {}),
        parent: parentAdmission
          ? { authoritySessionId: parentAdmission.authoritySessionId, nonce: parentAdmission.nonce }
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
    deps.taskAuthorities.bindExecution(executionSession);
    const evalExecutor = executionSession.executor;
    if (evalExecutor.kind !== "eval" || !evalExecutor.eventSinkNonce) {
      deps.executionSessions.discard(evalRuntimeId, runId);
      throw new Error("Evaluated execution admission has no live event sink");
    }
    const activityId =
      deps.activity && deps.eventSinks ? `eval:${evalRuntimeId}:${runId}` : undefined;
    deps.eventSinks?.register({
      nonce: evalExecutor.eventSinkNonce,
      runtimeId: evalRuntimeId,
      runId,
      contextId: owner.contextId,
      ownerCallerId: ownerId,
      initiatorCallerId: ctx.caller.runtime.id,
      subKey: runArgs.scope?.key ?? "default",
      onTerminal: () => {
        deps.executionSessions.close(evalRuntimeId, runId);
        if (activityId) deps.activity?.end(activityId);
        activeRuns.get(activeRunKey(evalRuntimeId, runId))?.closeAdmission();
      },
    });
    if (activityId) deps.activity?.begin(activityId);
    const discardPreparedAdmission = () => {
      deps.executionSessions.discard(evalRuntimeId, runId);
      deps.eventSinks?.close(eventSinkNonce);
      if (activityId) deps.activity?.end(activityId);
    };
    const authorityManifestDigest = evalExecutor.authorityManifest.digest;
    const runDigest = sha256Canonical({
      runId,
      ownerRuntimeId: ownerId,
      contextId: owner.contextId,
      source:
        runArgs.source.kind === "inline"
          ? {
              kind: "inline",
              digest: exactSource.sourceDigest,
              pathHint: runArgs.source.pathHint ?? null,
              syntax: runArgs.source.syntax ?? null,
            }
          : {
              kind: "context-file",
              path: runArgs.source.path,
              digest: exactSource.sourceDigest,
              sourceState: exactSource.sourceState,
              contentStateHash: exactSource.contentStateHash,
              syntax: runArgs.source.syntax ?? null,
            },
      scope: {
        key: runArgs.scope?.key ?? "default",
        lifecycle: runArgs.scope?.lifecycle ?? "persistent",
      },
      reset: runArgs.reset === true,
      imports: runArgs.imports ?? {},
      timeoutMs: runArgs.timeoutMs ?? null,
      authorityManifestDigest,
      attachedHost: ctx.attachedHost
        ? {
            sessionId: ctx.attachedHost.sessionId,
            childGenerationId: ctx.attachedHost.childGenerationId,
            developmentRunId: ctx.attachedHost.developmentRunId,
            authorityCeilingDigest: ctx.attachedHost.authorityCeilingDigest,
          }
        : null,
      preauthorize: normalizeEvalAuthorityIntent(runArgs.authority).preauthorize ?? [],
      initiatorChain: [
        ctx.caller.subject ? `user:${ctx.caller.subject.userId}` : null,
        ctx.caller.runtime.id,
        ctx.caller.code?.executionDigest ? codePrincipal(ctx.caller.code) : null,
      ].filter((value): value is string => value !== null),
    });
    if (normalizeEvalAuthorityIntent(runArgs.authority).preauthorize?.length) {
      if (!deps.preauthorize) {
        discardPreparedAdmission();
        throw new ServiceError(
          "eval",
          "start",
          "Exact eval preauthorization is unavailable",
          "EUNAVAILABLE",
          undefined,
          "service"
        );
      }
      const principalDigest = executionSession.executionImage.executionDigest;
      const prospectiveCtx: ServiceContext = {
        caller: {
          runtime: { id: evalRuntimeId, kind: "do" },
          code: {
            callerId: evalRuntimeId,
            callerKind: "do",
            repoPath: executionSession.executionImage.repoPath,
            effectiveVersion: executionSession.executionImage.effectiveVersion,
            executionDigest: principalDigest,
            requested: ownerHarness?.requested ?? [],
          },
          ...(agentBinding ? { agentBinding } : {}),
          executionSession,
          ...(ctx.caller.subject ? { subject: ctx.caller.subject } : {}),
        },
        ...(ctx.causalParent ? { causalParent: ctx.causalParent } : {}),
        ...(evalExecutor.authorityManifest.effects === "read-only" ? { readOnly: true } : {}),
      };
      try {
        for (const operation of normalizeEvalAuthorityIntent(runArgs.authority).preauthorize ??
          []) {
          await deps.preauthorize(prospectiveCtx, operation);
        }
      } catch (error) {
        discardPreparedAdmission();
        throw error;
      }
    }
    const evalDoRef = { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey };
    try {
      await kernelLeases.touch(evalDoRef);
    } catch (error) {
      // Admission and kernel residency are one preparation transaction. If the
      // lease cannot be established, no run can start and nothing downstream
      // will reach the normal completion cleanup.
      discardPreparedAdmission();
      throw error;
    }
    return {
      evalDoRef,
      assembledArgs: {
        runId,
        code: exactSource.code,
        path: undefined,
        sourcePath:
          runArgs.source.kind === "inline" ? runArgs.source.pathHint : runArgs.source.path,
        sourceDigest: exactSource.sourceDigest,
        sourceState: exactSource.sourceState,
        contentStateHash: exactSource.contentStateHash,
        reset: runArgs.reset,
        syntax: runArgs.source.syntax,
        imports: runArgs.imports,
        contextId: owner.contextId,
        gatewayToken: mintGatewayToken(objectKey),
        executionSessionNonce: executionSession.nonce,
        causalParent: ctx.causalParent,
        agentInvocationId: ctx.causalParent?.invocationId,
        parent,
        timeoutMs,
        readOnly: evalExecutor.authorityManifest.effects === "read-only",
        authorityManifestDigest,
        intentDigest: runDigest,
        eventSinkNonce: evalExecutor.eventSinkNonce,
        resultReceiverRef: runArgs.resultReceiver ? ownerId : undefined,
        ...chatBinding,
      },
      agentRef: isAgentDo ? ownerId : undefined,
      channelId: isAgentDo ? agentBinding.channelId : undefined,
      runDigest,
      authorityManifestDigest,
      eventSinkNonce: evalExecutor.eventSinkNonce,
      activityId,
    };
  }

  return {
    ...evalServiceDocumentation,
    handler: defineServiceHandler("eval", evalMethods, {
      start: async (ctx, [runArgs]) => {
        if (shutdownRequested) {
          throw new ServiceError(
            "eval",
            "start",
            "Eval admission is closed because the server is shutting down",
            "ESHUTDOWN",
            undefined,
            "service"
          );
        }
        // Every caller uses the same durable lifecycle. The caller-owned run id
        // is known before transport, so an ambiguous response or process loss
        // never makes the accepted run unaddressable.
        const runId = runArgs.runId;
        const { evalDoRef, assembledArgs, authorityManifestDigest, eventSinkNonce, activityId } =
          await prepareRun(ctx, runArgs, runId);
        const startArgs = {
          ...assembledArgs,
          runId,
        };
        const evalRuntimeId = evalDoEntityId(evalDoRef.objectKey);
        const activeKey = activeRunKey(evalRuntimeId, runId);
        let admissionClosed = false;
        const closeAdmission = () => {
          if (admissionClosed) return;
          admissionClosed = true;
          if (activeRuns.get(activeKey)?.runId === runId) activeRuns.delete(activeKey);
          // Supervision must not outlive the admitted run: the terminal event
          // (or shutdown/cancel) is the lifecycle fact that disposes it.
          runSupervisions.get(activeKey)?.dispose();
          deps.executionSessions.close(evalRuntimeId, runId);
          deps.eventSinks?.close(eventSinkNonce);
          if (activityId) deps.activity?.end(activityId);
        };
        activeRuns.set(activeKey, { evalDoRef, runId, closeAdmission });
        if (shutdownRequested) {
          closeAdmission();
          throw new ServiceError(
            "eval",
            "start",
            "Eval admission closed while this run was being prepared",
            "ESHUTDOWN",
            undefined,
            "service"
          );
        }
        let accepted: {
          status: string;
          existing?: boolean;
          runDigest: string;
        };
        try {
          accepted = (await deps.doDispatch.dispatch(evalDoRef, "startRun", startArgs)) as {
            status: string;
            existing?: boolean;
            runDigest: string;
          };
        } catch (error) {
          if (!(error instanceof AmbiguousDoDispatchError)) {
            closeAdmission();
            throw error;
          }
          // startRun is idempotent on runId. Only an explicitly ambiguous
          // acknowledgement keeps admission alive: the EvalDO may already have
          // durably accepted the run. Structured remote rejections are
          // definitive and were unwound above.
          void reconcileAmbiguousStart(deps.doDispatch, evalDoRef, startArgs).catch(
            (reconcileError) => {
              closeAdmission();
              console.warn(
                `[eval] admission reconciliation ${runId} stopped:`,
                reconcileError instanceof Error ? reconcileError.message : reconcileError
              );
            }
          );
          throw error;
        }
        const acceptedRunDigest = accepted.runDigest;
        if (
          accepted.status === "done" ||
          accepted.status === "cancelled" ||
          accepted.status === "approval-route-lost"
        ) {
          const snapshot = await deps.doDispatch.dispatch(evalDoRef, "getRun", runId);
          closeAdmission();
          return {
            runId,
            runDigest: acceptedRunDigest,
            authorityManifestDigest,
            status: "terminal" as const,
            snapshot,
          };
        }
        const timeoutMs = assembledArgs["timeoutMs"];
        if (
          typeof timeoutMs === "number" &&
          deps.recoverUnresponsiveSandbox &&
          !runSupervisions.has(activeKey)
        ) {
          const recoverUnresponsiveSandbox = deps.recoverUnresponsiveSandbox;
          const controller = new AbortController();
          const supervision = { dispose: () => controller.abort() };
          runSupervisions.set(activeKey, supervision);
          const watchdogActivityId = `eval-watchdog:${runId}`;
          deps.activity?.begin(watchdogActivityId);
          void superviseIsolateLiveness({
            doDispatch: deps.doDispatch,
            evalDoRef,
            runId,
            timeoutMs,
            livenessProbeMs: deps.livenessProbeMs ?? DEFAULT_EVAL_LIVENESS_PROBE_MS,
            recoverUnresponsiveSandbox,
            signal: controller.signal,
          })
            .catch((error) => {
              console.warn(
                `[eval] liveness supervision for timed run ${runId} failed:`,
                error instanceof Error ? error.message : error
              );
            })
            .finally(() => {
              deps.activity?.end(watchdogActivityId);
              if (runSupervisions.get(activeKey) === supervision) {
                runSupervisions.delete(activeKey);
              }
            });
        }
        return {
          runId,
          runDigest: acceptedRunDigest,
          authorityManifestDigest,
          status: accepted.existing ? ("already-running" as const) : ("accepted" as const),
        };
      },
      get: async (ctx, [getArgs]) =>
        deps.doDispatch.dispatch(await evalDoRefFor(ctx, getArgs), "getRun", getArgs.runId),
      events: async (ctx, [eventArgs]) =>
        deps.doDispatch.dispatch(
          await evalDoRefFor(ctx, eventArgs),
          "getRunEvents",
          eventArgs.runId,
          eventArgs.after ?? 0,
          eventArgs.limit ?? 100
        ),
      readScopeTextPage: async (ctx, [pageArgs]) =>
        deps.doDispatch.dispatch(
          await evalDoRefFor(ctx, pageArgs),
          "readScopeTextPage",
          pageArgs.key,
          pageArgs.offset,
          pageArgs.limit
        ),
      deleteScopeValue: async (ctx, [deleteArgs]) =>
        deps.doDispatch.dispatch(
          await evalDoRefFor(ctx, deleteArgs),
          "deleteScopeValue",
          deleteArgs.key
        ),
      reset: async (ctx, [resetArgs = {}]) =>
        deps.doDispatch.dispatch(await evalDoRefFor(ctx, resetArgs), "reset"),
      dispose: async (ctx, [disposeArgs = {}]) => {
        const owner = await resolveOwnerForCaller(ctx, disposeArgs);
        const objectKey = evalDoKey(owner.ownerId, disposeArgs.scopeKey ?? "default");
        const entityId = evalDoEntityId(objectKey);
        const active = await store.resolveRecord(entityId);
        if (!active || active.status !== "active") return { ok: true };
        const stateArgs =
          active.stateArgs &&
          typeof active.stateArgs === "object" &&
          !Array.isArray(active.stateArgs)
            ? (active.stateArgs as Record<string, unknown>)
            : null;
        if (stateArgs?.["lifecycle"] !== "finite") {
          throw new ServiceError(
            "eval",
            "dispose",
            "Only an eval scope declared finite at creation may be disposed",
            "EACCES",
            undefined,
            "access"
          );
        }
        await deps.doDispatch.dispatch(
          { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
          "dispose"
        );
        await deps.retireEntity(entityId);
        return { ok: true };
      },
      cancel: async (ctx, [cancelArgs]) => {
        const ref = await evalDoRefFor(ctx, cancelArgs);
        const result = await deps.doDispatch.dispatch(ref, "cancel", cancelArgs.runId);
        activeRuns
          .get(activeRunKey(evalDoEntityId(ref.objectKey), cancelArgs.runId))
          ?.closeAdmission();
        return result;
      },
    }),
  };
}

async function reconcileAmbiguousStart(
  dispatch: HeldDoDispatcher,
  ref: { source: string; className: string; objectKey: string },
  startArgs: Record<string, unknown>
): Promise<void> {
  for (;;) {
    try {
      await dispatch.dispatch(ref, "startRun", startArgs);
      return;
    } catch (error) {
      if (!(error instanceof AmbiguousDoDispatchError)) throw error;
      await admissionRetryDelay();
    }
  }
}

function admissionRetryDelay(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    timer.unref?.();
  });
}

async function settlePromiseWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ settled: true; value: T } | { settled: false }> {
  if (timeoutMs <= 0) return { settled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
