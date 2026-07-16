import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  evalMethods,
  type EvalPreauthorizationIntent,
  type EvalStartInput,
  type EvalTarget,
} from "@vibestudio/service-schemas/eval";
import { EVAL_DO_SOURCE, productSeedExecutionDigest } from "../internalDOs/productBootManifest.js";
import type { HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import { createHash, randomUUID } from "node:crypto";
import type { EvalInvocationCoordinator } from "./evalInvocationCoordinator.js";
import { evalStartIntentDigest } from "./evalStartIdentity.js";
import {
  verifyDevHostEvalApprovalRoute,
  verifyDevHostEvalAuthority,
  type DevEvalGenerationIdentity,
} from "./devHostEvalAuthority.js";

/** Parse a `do:<source>:<className>:<objectKey>` runtime id into a DO ref (source may contain '/'). */
function parseDoRef(
  runtimeId: string
): { source: string; className: string; objectKey: string } | null {
  if (!runtimeId.startsWith("do:")) return null;
  const rest = runtimeId.slice(3);
  const firstColon = rest.indexOf(":");
  if (firstColon < 0) return null;
  const source = rest.slice(0, firstColon);
  const afterSource = rest.slice(firstColon + 1);
  const secondColon = afterSource.indexOf(":");
  if (secondColon < 0) return null;
  const className = afterSource.slice(0, secondColon);
  const objectKey = afterSource.slice(secondColon + 1);
  if (!source || !className || !objectKey) return null;
  return { source, className, objectKey };
}

type EvalTerminalStatus = "failed" | "expired" | "interrupted";

const TRANSPORT_FAILURE_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") return code;
  return errorCode((error as Error & { cause?: unknown }).cause);
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = errorCode(error);
  if (code && TRANSPORT_FAILURE_CODES.has(code)) return true;
  if (error.name === "TypeError" && /\bfetch failed\b/i.test(error.message)) return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause !== undefined && isTransportFailure(cause);
}

function classifyTerminalFailure(error: unknown): {
  status: EvalTerminalStatus;
  error: string;
  errorCode?: string;
} {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "EVAL_INVOCATION_EXPIRED") {
    return { status: "expired", error: message, errorCode: code };
  }
  if (code === "EVAL_INTERRUPTED" || isTransportFailure(error)) {
    return { status: "interrupted", error: message, errorCode: "EVAL_INTERRUPTED" };
  }
  return { status: "failed", error: message, ...(code ? { errorCode: code } : {}) };
}

/**
 * Hold the EvalDO's `executeRun` on a background Node task (no request-scoped limit), then push the
 * result to the owning agent DO (`onEvalComplete`, server-stamped). The held dispatch uses the
 * no-`headersTimeout` dispatcher (`dispatchHeld`). On failure (e.g. a server restart dropped the
 * connection) the EvalDO's boot reconciliation marks the run interrupted and the agent's `get`
 * poll backstop surfaces it — so this is fire-and-forget.
 */
async function pushEvalComplete(
  doDispatch: HeldDoDispatcher,
  agentRef: string | undefined,
  channelId: string | undefined,
  runId: string,
  invocationId: string | undefined,
  result: unknown
): Promise<void> {
  if (!agentRef || !invocationId) return;
  const agentDoRef = parseDoRef(agentRef);
  if (!agentDoRef) return;
  // `channelId` routes the parked effect while `invocationId` correlates the
  // agent-loop tool invocation. `runId` remains the independent durable eval
  // handle and is retained for diagnostics/audit.
  await doDispatch
    .dispatch(agentDoRef, "onEvalComplete", { runId, invocationId, result, channelId })
    .catch((err) => {
      console.warn(
        `[eval] onEvalComplete push to ${agentRef} failed (get poll backstop covers it):`,
        err instanceof Error ? err.message : err
      );
    });
}

async function runHeldAndDeliver(
  doDispatch: HeldDoDispatcher,
  evalDoRef: { source: string; className: string; objectKey: string },
  runId: string,
  startIntentDigest: string,
  invocationCoordinator: EvalInvocationCoordinator,
  agentRef: string | undefined,
  channelId: string | undefined,
  agentInvocationId: string | undefined,
  maxEndsAt: number | null,
  preparation: {
    assembledArgs: Record<string, unknown>;
    contextId: string;
    executor: `code:${string}@${string}`;
    initiator: ServiceContext["caller"];
    authority: EvalStartInput["authority"];
  },
  preauthorize?: (credential: string, readOnly: boolean, signal: AbortSignal) => Promise<void>
): Promise<void> {
  try {
    // A preparation credential is intentionally minted only after this run owns
    // the per-scope queue. Queued predecessors may run or await approval without
    // consuming this run's short-lived invocation lease.
    const preparationLease = invocationCoordinator.issuePreparation({
      runId,
      startIntentDigest,
      objectKey: evalDoRef.objectKey,
      contextId: preparation.contextId,
      executor: preparation.executor,
      initiator: preparation.initiator,
      authority: preparation.authority,
      maxEndsAt,
    });
    await doDispatch.dispatch(evalDoRef, "begin", {
      ...preparation.assembledArgs,
      runId,
      startIntentDigest,
      invocationCredential: preparationLease.credential,
      authorityPolicy: preparationLease.policy,
    });
    const prepared = (await doDispatch.dispatchHeld(evalDoRef, "prepare", runId)) as {
      sourceDigest: string;
      executionProvenanceDigest: string;
      scopeInputRevision: string;
    };
    const lease = invocationCoordinator.finalize({
      runId,
      startIntentDigest,
      ...prepared,
    });
    if (preauthorize) {
      await doDispatch.dispatch(evalDoRef, "awaitPreauthorization", runId);
      const preauthorizationAbort = new AbortController();
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      if (maxEndsAt !== null) {
        const deadlineError = Object.assign(new Error("Eval preauthorization deadline expired"), {
          code: "EVAL_INVOCATION_EXPIRED",
        });
        const remaining = maxEndsAt - Date.now();
        if (remaining <= 0) preauthorizationAbort.abort(deadlineError);
        else {
          deadlineTimer = setTimeout(() => preauthorizationAbort.abort(deadlineError), remaining);
          deadlineTimer.unref?.();
        }
      }
      const renewal = setInterval(() => {
        try {
          invocationCoordinator.renew({
            runId,
            credential: lease.credential,
            objectKey: evalDoRef.objectKey,
          });
        } catch (error) {
          preauthorizationAbort.abort(error);
        }
      }, 10_000);
      renewal.unref?.();
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectFromSignal = () =>
          reject(
            preauthorizationAbort.signal.reason ??
              Object.assign(new Error("Eval preauthorization was aborted"), {
                code: "EVAL_INVOCATION_EXPIRED",
              })
          );
        if (preauthorizationAbort.signal.aborted) rejectFromSignal();
        else
          preauthorizationAbort.signal.addEventListener("abort", rejectFromSignal, { once: true });
      });
      try {
        await Promise.race([
          preauthorize(
            lease.credential,
            lease.policy.effects === "read-only",
            preauthorizationAbort.signal
          ),
          aborted,
        ]);
      } finally {
        clearInterval(renewal);
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    }
    await doDispatch.dispatch(evalDoRef, "activate", {
      runId,
      runDigest: lease.runDigest,
      manifestDigest: lease.manifestDigest,
      invocationCredential: lease.credential,
      authorityPolicy: lease.policy,
    });
    let result = await doDispatch.dispatchHeld(evalDoRef, "execute", runId);
    const authority = invocationCoordinator.authoritySummary(runId);
    result = await doDispatch.dispatch(evalDoRef, "attachAuthoritySummary", runId, authority);
    await pushEvalComplete(doDispatch, agentRef, channelId, runId, agentInvocationId, result);
  } catch (err) {
    console.warn(`[eval] held run ${runId} failed:`, err instanceof Error ? err.message : err);
    const terminal = classifyTerminalFailure(err);
    await doDispatch
      .dispatch(evalDoRef, "terminate", {
        runId,
        ...terminal,
      })
      .catch(() => undefined);
    // F2: the held dispatch died (e.g. a server restart dropped the connection). The agent's own
    // `get` poll backstop MAY re-fire, but if its `deferRedrive` never re-runs the eval gate the
    // parked invocation hangs forever. So reconcile the run's TERMINAL state from the EvalDO and push
    // an `onEvalComplete` ourselves — but ONLY when the run is actually terminal. A `done`/`cancelled`
    // run (boot reconciliation marks an interrupted run with a failed result) settles the agent's
    // invocation; a still-`pending`/`running` run (genuinely in flight elsewhere) is LEFT ALONE so we
    // never cut a legitimately long-running eval short — its own completion push covers it.
    if (!agentRef) return;
    try {
      const reconciled = (await doDispatch.dispatch(evalDoRef, "get", runId)) as {
        status?: string;
        result?: unknown;
      };
      const status = String(reconciled?.status ?? "unknown");
      if (
        ["succeeded", "failed", "cancelled", "expired", "interrupted"].includes(status) &&
        reconciled.result != null
      ) {
        await pushEvalComplete(
          doDispatch,
          agentRef,
          channelId,
          runId,
          agentInvocationId,
          reconciled.result
        );
      } else if (status === "cancelled" || status === "expired" || status === "interrupted") {
        // No durable result to deliver — synthesize a terminal failure so the parked invocation
        // settles instead of hanging. (`pending`/`running` deliberately fall through: do not bound.)
        await pushEvalComplete(doDispatch, agentRef, channelId, runId, agentInvocationId, {
          success: false,
          console: "",
          error:
            reconciled?.result != null
              ? String((reconciled.result as { error?: unknown })?.error ?? "eval run interrupted")
              : "eval run interrupted",
          errorCode:
            status === "expired"
              ? "EVAL_INVOCATION_EXPIRED"
              : status === "interrupted"
                ? "EVAL_INTERRUPTED"
                : "EVAL_CANCELLED",
        });
      }
    } catch (reconcileErr) {
      console.warn(
        `[eval] reconcile get for ${runId} after held failure also failed:`,
        reconcileErr instanceof Error ? reconcileErr.message : reconcileErr
      );
    }
  }
}

const EVAL_DO_CLASS = "EvalDO";
/** Stable — EvalDO ships in the internal bundle, not build-versioned; keeps entity identity stable. */
const EVAL_DO_EXECUTION_DIGEST = productSeedExecutionDigest(EVAL_DO_SOURCE);

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
 * Owner-scoped sandbox eval service. Any entity principal (panel/app/worker/do/shell) uses the
 * handle-based `eval.start` lifecycle; the owner is the verified
 * `ctx.caller` unless a privileged shell/server caller selects a session owner. The EvalDO
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
  /**
   * Host-wide background-work registry (idle-exit monitor). Every held eval
   * execution reports begin/end so a detached server won't idle-exit while
   * background eval work is still running.
   */
  activity?: import("./activityRegistry.js").ActivityRegistry;
  invocationCoordinator: EvalInvocationCoordinator;
  preauthorize?: (input: {
    ctx: ServiceContext;
    runId: string;
    credential: string;
    objectKey: string;
    intents: readonly EvalPreauthorizationIntent[];
    readOnly: boolean;
    signal: AbortSignal;
  }) => Promise<void>;
  delegatedAuthority?: {
    parentHostId: string;
    publicKeySpki: string;
    generation: DevEvalGenerationIdentity;
    recipientPrivateKey: string;
  };
}): ServiceDefinition {
  const store = deps.entityStore;
  const scopeQueues = new Map<string, Promise<void>>();

  const enqueueScopeRun = (objectKey: string, work: () => Promise<void>): void => {
    const predecessor = scopeQueues.get(objectKey) ?? Promise.resolve();
    const scheduled = predecessor.then(work, work);
    scopeQueues.set(objectKey, scheduled);
    const cleanup = () => {
      if (scopeQueues.get(objectKey) === scheduled) scopeQueues.delete(objectKey);
    };
    void scheduled.then(cleanup, cleanup);
  };

  const evalDoKey = (ownerId: string, subKey: string): string =>
    createHash("sha256")
      .update(ownerId + "\0" + subKey)
      .digest("hex")
      .slice(0, 40);

  /**
   * The EvalDO's canonical entity id (kind `do`). This is the principal the
   * server resolves on every EvalDO→main callback AND the subject of the
   * owner-scoped gateway token — the two MUST agree, so both derive it here.
   */
  const evalDoEntityId = (objectKey: string): string =>
    `do:${EVAL_DO_SOURCE}:${EVAL_DO_CLASS}:${objectKey}`;

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
    requested: { ownerId?: string; contextId?: string },
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
      if (
        (requested.ownerId !== undefined && requested.ownerId !== agentBinding.entityId) ||
        (requested.contextId !== undefined && requested.contextId !== agentBinding.contextId)
      ) {
        throw new Error(
          "eval: agent ownerId/contextId overrides must match the connection's entity binding"
        );
      }
      return { ownerId: agentBinding.entityId, contextId: agentBinding.contextId };
    }
    if (requested.ownerId !== undefined || requested.contextId !== undefined) {
      if (callerKind !== "shell" && callerKind !== "server") {
        throw new Error("eval: ownerId/contextId overrides are restricted to shell/server callers");
      }
      if (!requested.ownerId || !requested.contextId) {
        throw new Error("eval: ownerId and contextId must be provided together");
      }
      const registeredContext = await resolveRegisteredContext(requested.ownerId);
      if (registeredContext == null) {
        throw new Error(`eval: no context registered for owner ${requested.ownerId}`);
      }
      if (registeredContext !== requested.contextId) {
        throw new Error(
          `eval: owner ${requested.ownerId} is registered to ${registeredContext}, not ${requested.contextId}`
        );
      }
      return { ownerId: requested.ownerId, contextId: requested.contextId };
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
    ownerUserId: string | undefined
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
    if (active && active.contextId === contextId) {
      return { objectKey };
    }
    // Register/refresh the EvalDO entity with the owner's context so the kernel's
    // own fs/git/vcs calls resolve the owner's workspace. The store pairs the
    // durable upsert with the server hot-cache mirror, so the server can resolve
    // THIS EvalDO's principal when it calls back to `main`. Idempotent.
    await store.activate({
      kind: "do",
      source: { repoPath: EVAL_DO_SOURCE },
      activeExecutionDigest: EVAL_DO_EXECUTION_DIGEST,
      contextId,
      className: EVAL_DO_CLASS,
      key: objectKey,
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
      stateArgs: { ownerPrincipalId: ownerId, subKey },
    });
    return { objectKey };
  }

  type EvalRoute = { target?: EvalTarget; scope?: { key: string } };

  function attachedOwnerRoute(target: EvalTarget | undefined): {
    ownerId?: string;
    contextId?: string;
  } {
    return target?.kind === "attached-session"
      ? { ownerId: target.ownerId, contextId: target.contextId }
      : {};
  }

  async function resolveOwnerForCaller(
    ctx: ServiceContext,
    requested: EvalRoute
  ): Promise<EvalOwner> {
    return await resolveOwner(
      ctx.caller.runtime.kind,
      ctx.caller.runtime.id,
      attachedOwnerRoute(requested.target),
      ctx.caller.agentBinding
    );
  }

  async function evalDoRefFor(
    ctx: ServiceContext,
    route: EvalRoute
  ): Promise<{ source: string; className: string; objectKey: string }> {
    const owner = await resolveOwnerForCaller(ctx, route);
    const { objectKey } = await ensureEvalDO(
      owner,
      route.scope?.key ?? "default",
      ctx.caller.subject?.userId
    );
    return { source: EVAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey };
  }

  async function prepareRun(
    ctx: ServiceContext,
    runArgs: EvalStartInput
  ): Promise<{
    evalDoRef: { source: string; className: string; objectKey: string };
    assembledArgs: Record<string, unknown>;
    agentRef: string | undefined;
    agentInvocationId: string | undefined;
    owner: EvalOwner;
    objectKey: string;
  }> {
    const ownerId = ctx.caller.runtime.id;
    const owner = await resolveOwnerForCaller(ctx, runArgs);
    const { objectKey } = await ensureEvalDO(
      owner,
      runArgs.scope?.key ?? "default",
      ctx.caller.subject?.userId
    );
    const isAgent = ctx.caller.runtime.kind === "do" && Boolean(runArgs.channelId);
    if (isAgent && !ctx.idempotencyKey) {
      throw Object.assign(new Error("Agent-owned eval requires RPC delivery correlation"), {
        code: "EVAL_INVOCATION_INVALID",
      });
    }
    // The RPC delivery idempotency key identifies the parked agent tool call.
    // `runArgs.idempotencyKey` independently identifies the logical eval run
    // and may deliberately be reused by a later tool call.
    const agentInvocationId = isAgent ? ctx.idempotencyKey : undefined;
    const chatBinding = isAgent
      ? {
          channelId: runArgs.channelId,
          agentRef: ownerId,
          agentInvocationId,
        }
      : {};
    const parent = (await resolveParentPanel(ownerId)) ?? undefined;
    return {
      evalDoRef: { source: EVAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey },
      assembledArgs: {
        ...(runArgs.source.kind === "inline"
          ? { code: runArgs.source.code, sourcePath: runArgs.source.pathHint }
          : { path: runArgs.source.path }),
        reset: runArgs.scope?.reset,
        syntax: runArgs.source.syntax,
        imports: runArgs.imports,
        contextId: owner.contextId,
        parent,
        timeoutMs: runArgs.deadlineMs,
        ...chatBinding,
      },
      agentRef: isAgent ? ownerId : undefined,
      agentInvocationId,
      owner,
      objectKey,
    };
  }

  function runIdFor(
    ctx: ServiceContext,
    owner: EvalOwner,
    input: EvalStartInput,
    delegatedNonce?: string
  ): string {
    const idempotencyKey = delegatedNonce ? `delegated:${delegatedNonce}` : input.idempotencyKey;
    if (!idempotencyKey) return randomUUID();
    return createHash("sha256")
      .update(
        [
          ctx.caller.code?.repoPath ?? ctx.caller.runtime.id,
          ctx.caller.code?.executionDigest ?? ctx.caller.subject?.userId ?? "interactive",
          owner.ownerId,
          owner.contextId,
          input.scope?.key ?? "default",
          idempotencyKey,
        ].join("\0")
      )
      .digest("hex");
  }

  const startEval = async (
    ctx: ServiceContext,
    runArgs: EvalStartInput,
    initiator: ServiceContext["caller"],
    delegatedNonce?: string
  ) => {
    const prepared = await prepareRun(ctx, runArgs);
    const runId = runIdFor(ctx, prepared.owner, runArgs, delegatedNonce);
    const startIntentDigest = evalStartIntentDigest(runArgs);
    const maxEndsAt = runArgs.deadlineMs ? Date.now() + runArgs.deadlineMs : null;
    const accepted = (await deps.doDispatch.dispatch(prepared.evalDoRef, "accept", {
      runId,
      startIntentDigest,
      deadlineAt: maxEndsAt,
    })) as {
      runId: string;
      status: string;
      acceptedAt: number;
      startIntentDigest: string;
      needsStart?: boolean;
    };
    if (accepted.needsStart === true) {
      deps.activity?.begin(`eval:${runId}`);
      enqueueScopeRun(prepared.objectKey, async () => {
        try {
          await runHeldAndDeliver(
            deps.doDispatch,
            prepared.evalDoRef,
            runId,
            startIntentDigest,
            deps.invocationCoordinator,
            prepared.agentRef,
            runArgs.channelId,
            prepared.agentInvocationId,
            maxEndsAt,
            {
              assembledArgs: prepared.assembledArgs,
              contextId: prepared.owner.contextId,
              executor: `code:${EVAL_DO_SOURCE}@${EVAL_DO_EXECUTION_DIGEST}`,
              initiator,
              authority: runArgs.authority,
            },
            runArgs.authority?.preauthorize?.length
              ? (credential, readOnly, signal) =>
                  deps.preauthorize
                    ? deps.preauthorize({
                        ctx,
                        runId,
                        credential,
                        objectKey: prepared.objectKey,
                        intents: runArgs.authority!.preauthorize!,
                        readOnly,
                        signal,
                      })
                    : Promise.reject(
                        Object.assign(new Error("Eval preauthorization broker is unavailable"), {
                          code: "EVAL_INVOCATION_INVALID",
                        })
                      )
              : undefined
          );
        } finally {
          deps.invocationCoordinator.invalidate(runId, prepared.objectKey);
          deps.activity?.end(`eval:${runId}`);
        }
      });
    }
    return {
      runId: accepted.runId,
      status: accepted.status,
      acceptedAt: accepted.acceptedAt,
      startIntentDigest: accepted.startIntentDigest,
    };
  };

  return {
    name: "eval",
    description: "Owner-scoped sandbox eval backed by a per-owner internal EvalDO",
    authority: { principals: ["code", "user", "host", "entity"] },
    methods: evalMethods,
    handler: defineServiceHandler("eval", evalMethods, {
      start: (ctx, [runArgs]) => startEval(ctx, runArgs, ctx.caller),
      delegatedStart: (ctx, [request]) => {
        if (!deps.delegatedAuthority) {
          throw Object.assign(new Error("This host is not a managed development generation"), {
            code: "EVAL_APPROVAL_ROUTE_LOST",
          });
        }
        const verified = verifyDevHostEvalAuthority({
          envelope: request.authority,
          publicKeySpki: deps.delegatedAuthority.publicKeySpki,
          parentHostId: deps.delegatedAuthority.parentHostId,
          generation: deps.delegatedAuthority.generation,
          recipientPrivateKey: deps.delegatedAuthority.recipientPrivateKey,
          start: request.input,
        });
        if (request.input.authority?.approvals !== "pregranted-only") {
          if (!request.approvalRoute) {
            throw Object.assign(
              new Error("Prompt-capable child eval requires a live parent approval route"),
              { code: "EVAL_APPROVAL_ROUTE_LOST" }
            );
          }
          verifyDevHostEvalApprovalRoute({
            proof: request.approvalRoute,
            authority: request.authority,
            publicKeySpki: deps.delegatedAuthority.publicKeySpki,
            parentHostId: deps.delegatedAuthority.parentHostId,
            generation: deps.delegatedAuthority.generation,
          });
        }
        return startEval(ctx, request.input, verified.initiator, verified.payload.nonce);
      },
      renew: async (ctx, [input]) => {
        const prefix = `do:${EVAL_DO_SOURCE}:${EVAL_DO_CLASS}:`;
        if (ctx.caller.runtime.kind !== "do" || !ctx.caller.runtime.id.startsWith(prefix)) {
          throw new Error("eval.renew is restricted to the active EvalDO kernel");
        }
        return deps.invocationCoordinator.renew({
          runId: input.runId,
          credential: input.credential,
          objectKey: ctx.caller.runtime.id.slice(prefix.length),
        });
      },
      beginCleanup: async (ctx, [input]) => {
        const prefix = `do:${EVAL_DO_SOURCE}:${EVAL_DO_CLASS}:`;
        if (ctx.caller.runtime.kind !== "do" || !ctx.caller.runtime.id.startsWith(prefix)) {
          throw new Error("eval.beginCleanup is restricted to the active EvalDO kernel");
        }
        return deps.invocationCoordinator.beginCleanup({
          runId: input.runId,
          credential: input.credential,
          objectKey: ctx.caller.runtime.id.slice(prefix.length),
        });
      },
      get: async (ctx, [getArgs]) =>
        deps.doDispatch.dispatch(await evalDoRefFor(ctx, getArgs), "get", getArgs.runId),
      events: async (ctx, [eventArgs]) =>
        deps.doDispatch.dispatch(
          await evalDoRefFor(ctx, eventArgs),
          "events",
          eventArgs.runId,
          eventArgs.after ?? 0
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
      reset: async (ctx, [resetArgs = {}]) => {
        const ref = await evalDoRefFor(ctx, resetArgs);
        try {
          return await deps.doDispatch.dispatch(ref, "reset");
        } finally {
          deps.invocationCoordinator.invalidateObject(ref.objectKey);
        }
      },
      cancel: async (ctx, [cancelArgs]) => {
        const ref = await evalDoRefFor(ctx, cancelArgs);
        try {
          return await deps.doDispatch.dispatch(ref, "cancel", cancelArgs.runId);
        } finally {
          deps.invocationCoordinator.invalidate(cancelArgs.runId, ref.objectKey);
        }
      },
      forceReset: async (ctx, [forceArgs = {}]) => {
        const ref = await evalDoRefFor(ctx, forceArgs);
        try {
          return await deps.doDispatch.dispatch(ref, "forceReset");
        } finally {
          deps.invocationCoordinator.invalidateObject(ref.objectKey);
        }
      },
    }),
  };
}
