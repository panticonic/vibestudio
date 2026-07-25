import { createDevLogger } from "@vibestudio/dev-log";
import type { DORef } from "@vibestudio/shared/doDispatcher";
import type { DODispatch } from "../doDispatch.js";
import {
  DURABLE_WORK_QUEUES,
  type ClaimRequest,
  type ClaimSettlement,
  type DurableWorkQueue,
  type DurableWorkReadyHint,
  type DurableWorkTrigger,
  type SettleRequest,
  type WorkClaim,
} from "@vibestudio/shared/durableWork";

const log = createDevLogger("DurableWorkDriver");
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RECOVERY_SCAN_MS = 30_000;
const DEFAULT_RECOVERY_SCAN_CONCURRENCY = 1;

export interface DurableWorkFailure {
  workerId: string;
  itemId: string;
  generation: number;
  error: unknown;
}

/**
 * Queue-specific execution remains explicit and exhaustive. Queue owners
 * select only claims whose lane can run now (channel delivery therefore
 * returns one ordered target batch as one claim).
 */
export interface DurableWorkHandler {
  claim(owner: DORef, request: ClaimRequest): Promise<WorkClaim[]>;
  laneKey(owner: DORef, claim: WorkClaim): string;
  execute(owner: DORef, claim: WorkClaim, signal: AbortSignal): Promise<unknown>;
  settle(owner: DORef, request: SettleRequest): Promise<ClaimSettlement>;
  fail(owner: DORef, request: DurableWorkFailure): Promise<unknown>;
}

export interface DurableWorkDriverDeps {
  handlers: Record<DurableWorkQueue, DurableWorkHandler>;
  scanReadyOwners: () => Promise<DurableWorkReadyHint[]>;
  concurrency?: number;
  recoveryScanMs?: number;
  workerId?: string;
}

export interface DurableWorkDriverInspection {
  workerId: string;
  accepting: boolean;
  active: number;
  pendingHints: number;
  activeLanes: string[];
  duplicateHints: number;
  staleSettlements: number;
  recoveryScans: number;
  recoveryHits: number;
  claimsByTrigger: Record<DurableWorkTrigger, number>;
  recentTrace: DurableWorkDriverTrace[];
}

export interface DurableWorkDriverTrace {
  at: number;
  phase:
    | "hint.received"
    | "claim.started"
    | "claim.completed"
    | "execution.started"
    | "execution.completed"
    | "settlement.completed"
    | "execution.failed";
  trigger: DurableWorkTrigger;
  queue: DurableWorkQueue;
  owner: string;
  itemId?: string;
  generation?: number;
  durationMs?: number;
  disposition?: ClaimSettlement;
}

interface PendingHint {
  hint: DurableWorkReadyHint;
  trigger: DurableWorkTrigger;
  notifiedAt: number;
}

export function createDurableWorkOwnerScanner(
  doDispatch: Pick<DODispatch, "dispatch">,
  workspaceOwner: DORef,
  workerId: string,
  concurrency = DEFAULT_RECOVERY_SCAN_CONCURRENCY
): () => Promise<DurableWorkReadyHint[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Durable-work recovery scan concurrency must be a positive integer");
  }
  return async () => {
    const registered = (await doDispatch.dispatch(
      workspaceOwner,
      "durableWorkOwnerList"
    )) as DurableWorkReadyHint[];
    const ready: DurableWorkReadyHint[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < registered.length) {
        const { owner, queues } = registered[next++]!;
        try {
          await doDispatch.dispatch(owner, "adoptDurableWorkWorker", workerId);
          const local = (await doDispatch.dispatch(owner, "durableWorkStatus")) as {
            readyQueues?: unknown;
          };
          const declared = new Set(queues);
          const readyQueues = Array.isArray(local.readyQueues)
            ? local.readyQueues.filter(
                (queue): queue is DurableWorkQueue =>
                  typeof queue === "string" && declared.has(queue as DurableWorkQueue)
              )
            : [];
          if (readyQueues.length > 0) ready.push({ owner, queues: readyQueues });
        } catch (error) {
          log.warn(
            `readiness scan failed for ${owner.source}:${owner.className}:${owner.objectKey}`,
            error
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, registered.length) }, () => worker())
    );
    return ready;
  };
}

interface DriverClaimPayload {
  workKind?: unknown;
  laneKey?: unknown;
  target?: unknown;
  batch?: unknown;
}

function requireTarget(value: unknown): DORef {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as DORef).source !== "string" ||
    typeof (value as DORef).className !== "string" ||
    typeof (value as DORef).objectKey !== "string"
  ) {
    throw new Error("channel-delivery claim has no valid target");
  }
  return value as DORef;
}

/**
 * The host knows transport, not queue storage. Owners expose the common
 * claim/settle surface; only execution differs by queue.
 */
export function createDurableWorkHandlers(
  doDispatch: Pick<DODispatch, "dispatch" | "dispatchHeldWithSignal">
): Record<DurableWorkQueue, DurableWorkHandler> {
  const common = (queue: DurableWorkQueue): Omit<DurableWorkHandler, "execute"> => ({
    claim: (owner, request) =>
      doDispatch.dispatch(owner, "claimReadyWork", queue, request) as Promise<WorkClaim[]>,
    laneKey: (owner, claim) => {
      const supplied = (claim.payload as DriverClaimPayload | null)?.laneKey;
      return typeof supplied === "string" && supplied.length > 0
        ? supplied
        : `${owner.source}\u0000${owner.className}\u0000${owner.objectKey}\u0000${claim.itemId}`;
    },
    settle: (owner, request) =>
      doDispatch.dispatch(owner, "settleReadyWork", queue, request) as Promise<ClaimSettlement>,
    fail: (owner, request) => doDispatch.dispatch(owner, "failReadyWork", queue, request),
  });
  return {
    "channel-delivery": {
      ...common("channel-delivery"),
      execute: async (owner, claim, signal) => {
        const payload = claim.payload as DriverClaimPayload;
        if (payload.workKind === "channel-maintenance") {
          return doDispatch.dispatchHeldWithSignal(
            owner,
            signal,
            "executeChannelMaintenanceClaim",
            {
              itemId: claim.itemId,
              generation: claim.generation,
            }
          );
        }
        const target = requireTarget(payload.target);
        return doDispatch.dispatchHeldWithSignal(
          target,
          signal,
          "acceptChannelBatch",
          payload.batch
        );
      },
    },
    "agent-inbox": {
      ...common("agent-inbox"),
      execute: (owner, claim, signal) =>
        doDispatch.dispatchHeldWithSignal(owner, signal, "executeInboxClaim", {
          itemId: claim.itemId,
          generation: claim.generation,
        }),
    },
    "agent-effect": {
      ...common("agent-effect"),
      execute: (owner, claim, signal) =>
        doDispatch.dispatchHeldWithSignal(owner, signal, "executeEffectClaim", {
          itemId: claim.itemId,
          generation: claim.generation,
        }),
    },
  };
}

/**
 * Immediate host-owned dispatcher. Hints are disposable; claims and outcomes
 * remain durable at their semantic owner.
 */
export class DurableWorkDriver {
  private readonly handlers: Record<DurableWorkQueue, DurableWorkHandler>;
  private readonly scanReadyOwners: () => Promise<DurableWorkReadyHint[]>;
  private readonly concurrency: number;
  private readonly recoveryScanMs: number;
  private readonly workerId: string;
  private readonly pending = new Map<string, PendingHint>();
  private readonly claiming = new Set<string>();
  private readonly activeLanes = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private readonly runners = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private accepting = false;
  private pumping: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private duplicateHints = 0;
  private staleSettlements = 0;
  private recoveryScans = 0;
  private recoveryHits = 0;
  private readonly claimsByTrigger: Record<DurableWorkTrigger, number> = {
    hint: 0,
    recovery: 0,
    continuation: 0,
  };
  private readonly recentTrace: DurableWorkDriverTrace[] = [];

  constructor(deps: DurableWorkDriverDeps) {
    this.handlers = deps.handlers;
    this.scanReadyOwners = deps.scanReadyOwners;
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.recoveryScanMs = deps.recoveryScanMs ?? DEFAULT_RECOVERY_SCAN_MS;
    this.workerId = deps.workerId ?? `durable-work-driver:${crypto.randomUUID()}`;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("DurableWorkDriver concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(this.recoveryScanMs) || this.recoveryScanMs < 1) {
      throw new Error("DurableWorkDriver recoveryScanMs must be a positive integer");
    }
    for (const queue of DURABLE_WORK_QUEUES) {
      if (!this.handlers[queue]) throw new Error(`Missing durable-work handler for ${queue}`);
    }
  }

  start(): void {
    if (this.accepting) return;
    this.accepting = true;
    this.timer = setInterval(() => void this.recoverNow(), this.recoveryScanMs);
    this.timer.unref?.();
    this.kick();
  }

  notify(hint: DurableWorkReadyHint, trigger: DurableWorkTrigger = "hint"): void {
    if (!this.accepting) return;
    for (const queue of hint.queues) {
      const normalized = { owner: hint.owner, queues: [queue] };
      const key = this.hintKey(hint.owner, queue);
      if (this.pending.has(key) || this.claiming.has(key)) this.duplicateHints++;
      this.pending.set(key, { hint: normalized, trigger, notifiedAt: Date.now() });
      this.trace({
        phase: "hint.received",
        trigger,
        queue,
        owner: this.ownerKey(hint.owner),
      });
    }
    this.kick();
  }

  async recoverNow(): Promise<void> {
    if (!this.accepting) return;
    if (this.recovering) return this.recovering;
    const recovering = this.runRecovery();
    this.recovering = recovering;
    try {
      await recovering;
    } finally {
      if (this.recovering === recovering) this.recovering = null;
    }
  }

  private async runRecovery(): Promise<void> {
    this.recoveryScans++;
    try {
      const hints = await this.scanReadyOwners();
      if (!this.accepting) return;
      if (hints.length > 0) this.recoveryHits += hints.length;
      for (const hint of hints) this.notify(hint, "recovery");
    } catch (error) {
      log.warn("owner-registry recovery scan failed", error);
    }
  }

  async quiesce(): Promise<void> {
    this.accepting = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    const reason = new Error("durable work driver quiesced");
    for (const controller of this.controllers) controller.abort(reason);
    await this.pumping;
    await Promise.allSettled([...this.runners]);
    await this.recovering;
  }

  inspect(): DurableWorkDriverInspection {
    return {
      workerId: this.workerId,
      accepting: this.accepting,
      active: this.runners.size,
      pendingHints: this.pending.size,
      activeLanes: [...this.activeLanes].sort(),
      duplicateHints: this.duplicateHints,
      staleSettlements: this.staleSettlements,
      recoveryScans: this.recoveryScans,
      recoveryHits: this.recoveryHits,
      claimsByTrigger: { ...this.claimsByTrigger },
      recentTrace: [...this.recentTrace],
    };
  }

  private kick(): void {
    if (!this.accepting || this.pumping || this.runners.size >= this.concurrency) return;
    const pumping = this.pump();
    this.pumping = pumping;
    void pumping.finally(() => {
      if (this.pumping === pumping) this.pumping = null;
      if (this.accepting && this.pending.size > 0 && this.runners.size < this.concurrency) {
        this.kick();
      }
    });
  }

  private async pump(): Promise<void> {
    while (this.accepting && this.pending.size > 0 && this.runners.size < this.concurrency) {
      const entry = this.pending.entries().next().value as [string, PendingHint] | undefined;
      if (!entry) return;
      const [key, pending] = entry;
      const { hint, trigger } = pending;
      this.pending.delete(key);
      if (this.claiming.has(key)) continue;
      const queue = hint.queues[0]!;
      const handler = this.handlers[queue];
      this.claiming.add(key);
      let claims: WorkClaim[];
      const claimStartedAt = Date.now();
      this.trace({
        phase: "claim.started",
        trigger,
        queue,
        owner: this.ownerKey(hint.owner),
      });
      try {
        claims = await handler.claim(hint.owner, {
          workerId: this.workerId,
          trigger,
          now: Date.now(),
          limit: this.concurrency - this.runners.size,
        });
      } catch (error) {
        log.warn(`claim failed for ${key}`, error);
        continue;
      } finally {
        this.claiming.delete(key);
      }
      this.claimsByTrigger[trigger] += claims.length;
      this.trace({
        phase: "claim.completed",
        trigger,
        queue,
        owner: this.ownerKey(hint.owner),
        durationMs: Date.now() - claimStartedAt,
      });
      for (const claim of claims) {
        const lane = `${queue}\u0000${handler.laneKey(hint.owner, claim)}`;
        if (this.activeLanes.has(lane)) {
          await handler.fail(hint.owner, {
            workerId: this.workerId,
            itemId: claim.itemId,
            generation: claim.generation,
            error: new Error(`Queue ${queue} granted two simultaneous claims for lane ${lane}`),
          });
          continue;
        }
        this.startRunner(hint.owner, queue, claim, lane, trigger);
      }
    }
  }

  private startRunner(
    owner: DORef,
    queue: DurableWorkQueue,
    claim: WorkClaim,
    lane: string,
    trigger: DurableWorkTrigger
  ): void {
    const handler = this.handlers[queue];
    const controller = new AbortController();
    this.activeLanes.add(lane);
    this.controllers.add(controller);
    const runner = (async () => {
      const executionStartedAt = Date.now();
      this.trace({
        phase: "execution.started",
        trigger,
        queue,
        owner: this.ownerKey(owner),
        itemId: claim.itemId,
        generation: claim.generation,
      });
      try {
        const outcome = await handler.execute(owner, claim, controller.signal);
        this.trace({
          phase: "execution.completed",
          trigger,
          queue,
          owner: this.ownerKey(owner),
          itemId: claim.itemId,
          generation: claim.generation,
          durationMs: Date.now() - executionStartedAt,
        });
        const settlementStartedAt = Date.now();
        const disposition = await handler.settle(owner, {
          workerId: this.workerId,
          itemId: claim.itemId,
          generation: claim.generation,
          outcome,
        });
        if (disposition === "stale") this.staleSettlements++;
        this.trace({
          phase: "settlement.completed",
          trigger,
          queue,
          owner: this.ownerKey(owner),
          itemId: claim.itemId,
          generation: claim.generation,
          durationMs: Date.now() - settlementStartedAt,
          disposition,
        });
      } catch (error) {
        this.trace({
          phase: "execution.failed",
          trigger,
          queue,
          owner: this.ownerKey(owner),
          itemId: claim.itemId,
          generation: claim.generation,
          durationMs: Date.now() - executionStartedAt,
        });
        if (!controller.signal.aborted) {
          try {
            await handler.fail(owner, {
              workerId: this.workerId,
              itemId: claim.itemId,
              generation: claim.generation,
              error,
            });
          } catch (failureError) {
            log.warn(
              `failure settlement failed for ${queue}:${owner.source}:${owner.className}/${owner.objectKey}:${claim.itemId}`,
              failureError
            );
          }
        }
      }
    })();
    this.runners.add(runner);
    void runner.finally(() => {
      this.runners.delete(runner);
      this.controllers.delete(controller);
      this.activeLanes.delete(lane);
      if (this.accepting) {
        this.notify({ owner, queues: [queue] }, "continuation");
        this.kick();
      }
    });
  }

  private hintKey(owner: DORef, queue: DurableWorkQueue): string {
    return `${owner.source}\u0000${owner.className}\u0000${owner.objectKey}\u0000${queue}`;
  }

  private ownerKey(owner: DORef): string {
    return `${owner.source}:${owner.className}:${owner.objectKey}`;
  }

  private trace(event: Omit<DurableWorkDriverTrace, "at">): void {
    const record = { at: Date.now(), ...event };
    this.recentTrace.push(record);
    if (this.recentTrace.length > 500) this.recentTrace.splice(0, this.recentTrace.length - 500);
    log.info(`[trace] ${JSON.stringify(record)}`);
  }
}
