import { createDevLogger } from "@vibestudio/dev-log";
import type { DORef, LifecycleDoDispatcher } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { LifecycleKey, LifecycleOp } from "@panticonic/builtin/workspace-state";
import type { RestartBeginEvent, RestartReadyEvent, WorkerdManager } from "../workerdManager.js";

const log = createDevLogger("LifecycleDriver");

export interface LifecycleDriverDeps {
  workerdManager: WorkerdManager;
  doDispatch: LifecycleDoDispatcher;
  workspaceId: string;
  prepareDeadlineMs?: number;
  concurrency?: number;
}

export class LifecycleDriver {
  private readonly deps: LifecycleDriverDeps;
  private readonly workspaceRef: DORef;
  private readonly prepareDeadlineMs: number;
  private readonly concurrency: number;
  private readonly restartEpochs = new Map<string, string>();
  /**
   * Ops that could not be durably recorded because the workspace DO was
   * wedged or mid-transition. Flushed (bounded) once the next generation is
   * ready; capped so a permanently broken store cannot grow without bound.
   */
  private readonly pendingOps: Array<{
    epochId: string;
    key: LifecycleKey;
    opKind: "prepare" | "resume";
    status: "ready" | "timed_out" | "failed" | "resumed";
    detail: unknown;
  }> = [];
  private static readonly MAX_PENDING_OPS = 1000;
  private unsubscribeBegin: (() => void) | null = null;
  private unsubscribeReady: (() => void) | null = null;

  constructor(deps: LifecycleDriverDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.prepareDeadlineMs = deps.prepareDeadlineMs ?? 5_000;
    this.concurrency = deps.concurrency ?? 8;
  }

  start(): void {
    this.unsubscribeBegin = this.deps.workerdManager.onRestartBegin((event) =>
      this.handleRestartBegin(event)
    );
    this.unsubscribeReady = this.deps.workerdManager.onRestartReady((event) =>
      this.handleRestartReady(event)
    );
  }

  stop(): void {
    this.unsubscribeBegin?.();
    this.unsubscribeReady?.();
    this.unsubscribeBegin = null;
    this.unsubscribeReady = null;
  }

  async recoverStartup(reason: "crash" | "server_restart" = "server_restart"): Promise<void> {
    const targets = await this.dispatchWorkspace<LifecycleKey[]>("lifecycleListResumeTargets");
    if (targets.length === 0) return;
    const epoch = await this.dispatchWorkspace<string>("lifecycleOpenEpoch", {
      kind: reason,
      reason,
      generation: this.deps.workerdManager.getBootGeneration(),
    });
    await this.resumeTargets(epoch, targets, {
      previousGeneration: null,
      currentGeneration: this.deps.workerdManager.getBootGeneration(),
      reason,
    });
    await this.dispatchWorkspace("lifecycleCompleteEpoch", epoch);
  }

  async prepareForShutdown(deadlineMs = 2_000): Promise<void> {
    const epoch = await this.withTimeout(
      this.dispatchWorkspace<string>("lifecycleOpenEpoch", {
        kind: "planned",
        reason: "server_shutdown",
        generation: this.deps.workerdManager.getBootGeneration(),
      }),
      deadlineMs
    );
    const targets = await this.withTimeout(
      this.dispatchWorkspace<LifecycleKey[]>("lifecycleListLeases"),
      deadlineMs
    );
    await this.prepareTargets(epoch, targets, deadlineMs, "server_shutdown");
  }

  private async handleRestartBegin(event: RestartBeginEvent): Promise<void> {
    // A restart that failed between begin and ready leaves its epoch behind;
    // abandon such strays before opening a new one so WorkspaceDO lifecycle
    // epochs cannot leak across failed transitions.
    await this.expireStaleEpochs();
    // This is the one irreducible process-boundary deadline: graceful
    // preparation must never prevent a crash recovery from reaching the
    // process boundary when the current workerd is alive but cannot dispatch.
    // Every dispatch on this path is deadline-bounded (and abort-aware: crash
    // preemption cancels the remaining graceful work immediately).
    const epoch = await this.withTimeout(
      this.dispatchWorkspace<string>("lifecycleOpenEpoch", {
        kind: "planned",
        reason: event.reason,
        generation: event.generation,
      }),
      this.prepareDeadlineMs,
      event.signal
    );
    this.restartEpochs.set(event.correlationId, epoch);
    const targets = await this.withTimeout(
      this.dispatchWorkspace<LifecycleKey[]>("lifecycleListLeases"),
      this.prepareDeadlineMs,
      event.signal
    );
    await this.prepareTargets(epoch, targets, this.prepareDeadlineMs, event.reason, event.signal);
  }

  private async handleRestartReady(event: RestartReadyEvent): Promise<void> {
    const epoch = this.restartEpochs.get(event.correlationId);
    this.restartEpochs.delete(event.correlationId);
    // Everything still mapped belongs to transitions that never became ready.
    await this.expireStaleEpochs();
    // The new generation is up: durably record any ops that could not be
    // written while the previous generation was wedged.
    await this.flushPendingOps();
    if (!epoch || event.reason === "crash") {
      // Crash-style ready: the old generation could not (or only partially)
      // participate in graceful prepare — either no epoch was opened, or the
      // prepared epoch is unreliable because the manager degraded the restart.
      // Abandon it and reconstruct leases directly from durable state.
      if (epoch) await this.completeEpochBestEffort(epoch);
      if (event.reason === "crash") await this.recoverStartup("crash");
      return;
    }
    const ops = await this.dispatchWorkspace<LifecycleOp[]>("lifecycleListOps", epoch);
    const targets = this.dedupe(
      ops
        .filter((op) => op.opKind === "resume")
        .map((op) => ({
          source: op.source,
          className: op.className,
          objectKey: op.objectKey,
        }))
    );
    await this.resumeTargets(epoch, targets, {
      previousGeneration: event.previousGeneration,
      currentGeneration: event.generation,
      reason: "planned",
    });
    await this.dispatchWorkspace("lifecycleCompleteEpoch", epoch);
  }

  private async prepareTargets(
    epoch: string,
    targets: LifecycleKey[],
    deadlineMs: number,
    reason: string,
    signal?: AbortSignal
  ): Promise<void> {
    const deadlineAt = Date.now() + deadlineMs;
    let deadlineExhausted = false;
    const failures: string[] = [];
    await this.runPool(targets, async (target) => {
      const label = `${target.source}:${target.className}/${target.objectKey}`;
      try {
        if (signal?.aborted) deadlineExhausted = true;
        if (deadlineExhausted) {
          await this.recordOp(
            epoch,
            target,
            "prepare",
            "timed_out",
            { error: "lifecycle timeout" },
            signal
          );
          failures.push(`${label}: lifecycle timeout`);
          return;
        }
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        if (remainingMs <= 0) {
          deadlineExhausted = true;
          await this.recordOp(
            epoch,
            target,
            "prepare",
            "timed_out",
            { error: "lifecycle timeout" },
            signal
          );
          failures.push(`${label}: lifecycle timeout`);
          return;
        }
        const result = await this.withTimeout(
          this.deps.doDispatch.dispatchLifecycle(this.toRef(target), "prepare", {
            epoch,
            mode: "suspend",
            reason,
            deadlineMs: remainingMs,
          }),
          remainingMs,
          signal
        );
        const status =
          result &&
          typeof result === "object" &&
          (result as { status?: unknown }).status === "failed"
            ? "failed"
            : "ready";
        await this.recordOp(epoch, target, "prepare", status, result, signal);
        if (status === "failed") failures.push(`${label}: release refused`);
      } catch (err) {
        const timedOut =
          err instanceof Error &&
          (err.message === "lifecycle timeout" || err.message === "lifecycle aborted");
        if (timedOut) deadlineExhausted = true;
        const message = err instanceof Error ? err.message : String(err);
        await this.recordOp(
          epoch,
          target,
          "prepare",
          timedOut ? "timed_out" : "failed",
          { error: message },
          signal
        );
        failures.push(`${label}: ${message}`);
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => new Error(failure)),
        `Lifecycle release failed for ${failures.length} target(s)`
      );
    }
  }

  private async resumeTargets(
    epoch: string,
    targets: LifecycleKey[],
    input: {
      previousGeneration: number | null;
      currentGeneration: number;
      reason: "planned" | "crash" | "server_restart";
    }
  ): Promise<void> {
    const failures: Array<{ target: string; error: string }> = [];
    await this.runPool(this.dedupe(targets), async (target) => {
      try {
        await this.deps.doDispatch.dispatchLifecycle(this.toRef(target), "resume", {
          epoch,
          ...input,
        });
        await this.recordOp(epoch, target, "resume", "resumed", null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.recordOp(epoch, target, "resume", "failed", {
          error: message,
        });
        failures.push({
          target: `${target.source}:${target.className}/${target.objectKey}`,
          error: message,
        });
      }
    });
    if (failures.length > 0) {
      log.warn(
        `lifecycle resume failed for ${failures.length}/${targets.length} target(s); sample=${JSON.stringify(failures.slice(0, 5))}`
      );
    }
  }

  /**
   * Best-effort, deadline-bounded op bookkeeping. On the path where a prepare
   * just timed out against a wedged workerd, this dispatch would hang against
   * the same wedged DO and hold the restart owner forever — so it is bounded,
   * and a failed write is buffered locally and flushed after the next
   * generation is ready. It never throws.
   */
  private async recordOp(
    epochId: string,
    key: LifecycleKey,
    opKind: "prepare" | "resume",
    status: "ready" | "timed_out" | "failed" | "resumed",
    detail: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    const op = { epochId, key, opKind, status, detail };
    try {
      await this.withTimeout(
        this.dispatchWorkspace("lifecycleRecordOp", op),
        this.prepareDeadlineMs,
        signal
      );
    } catch (err) {
      this.bufferPendingOp(op);
      log.warn(
        `lifecycleRecordOp deferred (${key.source}:${key.className}/${key.objectKey} ${opKind}=${status}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private bufferPendingOp(op: LifecycleDriver["pendingOps"][number]): void {
    if (this.pendingOps.length >= LifecycleDriver.MAX_PENDING_OPS) this.pendingOps.shift();
    this.pendingOps.push(op);
  }

  /** Bounded, swallowed flush of locally buffered ops (new generation ready). */
  private async flushPendingOps(): Promise<void> {
    const ops = this.pendingOps.splice(0, this.pendingOps.length);
    for (const op of ops) {
      try {
        await this.withTimeout(
          this.dispatchWorkspace("lifecycleRecordOp", op),
          this.prepareDeadlineMs
        );
      } catch (err) {
        this.bufferPendingOp(op);
        log.warn(
          `lifecycle op flush failed; will retry on next restart-ready: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }
    }
  }

  /** Abandon epochs left behind by restarts that failed between begin/ready. */
  private async expireStaleEpochs(): Promise<void> {
    for (const [correlationId, epoch] of [...this.restartEpochs]) {
      this.restartEpochs.delete(correlationId);
      log.warn(`abandoning stale lifecycle epoch ${epoch} from restart ${correlationId}`);
      await this.completeEpochBestEffort(epoch);
    }
  }

  private async completeEpochBestEffort(epoch: string): Promise<void> {
    try {
      await this.withTimeout(
        this.dispatchWorkspace("lifecycleCompleteEpoch", epoch),
        this.prepareDeadlineMs
      );
    } catch (err) {
      log.warn(
        `failed to complete lifecycle epoch ${epoch}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private toRef(key: LifecycleKey): DORef {
    return { source: key.source, className: key.className, objectKey: key.objectKey };
  }

  private dispatchWorkspace<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args) as Promise<T>;
  }

  private dedupe(targets: LifecycleKey[]): LifecycleKey[] {
    const seen = new Set<string>();
    const result: LifecycleKey[] = [];
    for (const target of targets) {
      const key = `${target.source}\0${target.className}\0${target.objectKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(target);
    }
    return result;
  }

  private async runPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("lifecycle timeout")), timeoutMs);
          if (signal) {
            if (signal.aborted) reject(new Error("lifecycle aborted"));
            else {
              onAbort = () => reject(new Error("lifecycle aborted"));
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      // The losing promise may still reject after the race is decided; that
      // late rejection must never surface as an unhandled rejection.
      promise.catch(() => {});
    }
  }
}
