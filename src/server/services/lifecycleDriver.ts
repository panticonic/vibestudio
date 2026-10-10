import { deserializeRpcFailure, serializeRpcFailure } from "@vibestudio/rpc";
import { createDevLogger } from "@vibestudio/dev-log";
import type { DORef, LifecycleDoDispatcher } from "@vibestudio/shared/doDispatcher";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { LifecycleKey } from "@panticonic/builtin/workspace-state";
import type { RestartBeginEvent, RestartReadyEvent, WorkerdManager } from "../workerdManager.js";
import { workspaceStateEngineMethods } from "@vibestudio/service-schemas/workspaceStateEngine";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

const log = createDevLogger("LifecycleDriver");
type WorkspaceStateEngineClient = TypedServiceClient<typeof workspaceStateEngineMethods>;

export interface LifecycleDriverDeps {
  workerdManager: WorkerdManager;
  doDispatch: LifecycleDoDispatcher;
  workspaceId: string;
  drainDurableWorkDeliveries: (owners: readonly DORef[], signal?: AbortSignal) => Promise<void>;
  concurrency?: number;
  prepareDurableWorkRelease: (
    owner: DORef,
    stage: import("@vibestudio/shared/durableWork").DurableWorkReleaseStage,
    signal?: AbortSignal
  ) => Promise<void>;
}

export class LifecycleDriver {
  private readonly deps: LifecycleDriverDeps;
  private readonly workspaceRef: DORef;
  private readonly workspaceState: WorkspaceStateEngineClient;
  private readonly concurrency: number;
  private readonly restartEpochs = new Map<string, string>();
  private unsubscribeBegin: (() => void) | null = null;
  private unsubscribeReady: (() => void) | null = null;

  constructor(deps: LifecycleDriverDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.workspaceState = createTypedServiceClient(
      "workspace-state",
      workspaceStateEngineMethods,
      (_service, method, args) => this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args)
    );
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
    const targets = await this.workspaceState.lifecycleListResumeTargets();
    if (targets.length === 0) return;
    const epoch = await this.workspaceState.lifecycleOpenEpoch({
      kind: reason,
      reason,
      generation: this.deps.workerdManager.getBootGeneration(),
    });
    await this.resumeTargets(epoch, targets, {
      previousGeneration: null,
      currentGeneration: this.deps.workerdManager.getBootGeneration(),
      reason,
    });
    await this.workspaceState.lifecycleCompleteEpoch(epoch);
  }

  async prepareForShutdown(): Promise<void> {
    const epoch = await this.workspaceState.lifecycleOpenEpoch({
      kind: "planned",
      reason: "server_shutdown",
      generation: this.deps.workerdManager.getBootGeneration(),
    });
    const targets = await this.workspaceState.lifecycleListLeases();
    await this.prepareTargets(epoch, targets, "server_shutdown");
  }

  private async handleRestartBegin(event: RestartBeginEvent): Promise<void> {
    event.signal?.throwIfAborted();
    await this.expireStaleEpochs();
    event.signal?.throwIfAborted();
    const epoch = await this.workspaceState.lifecycleOpenEpoch({
      kind: "planned",
      reason: event.reason,
      generation: event.generation,
    });
    this.restartEpochs.set(event.correlationId, epoch);
    event.signal?.throwIfAborted();
    const targets = await this.workspaceState.lifecycleListLeases();
    event.signal?.throwIfAborted();
    // Planned replacement joins genuine release. Only the manager's actual
    // crash preemption may stop admission into this generation; its process
    // destruction settles any dispatch already owned by this hook.
    await this.prepareTargets(epoch, targets, event.reason, event.signal);
  }

  private async handleRestartReady(event: RestartReadyEvent): Promise<void> {
    const epoch = this.restartEpochs.get(event.correlationId);
    this.restartEpochs.delete(event.correlationId);
    // Everything still mapped belongs to transitions that never became ready.
    await this.expireStaleEpochs();
    if (!epoch || event.reason === "crash") {
      // Crash-style ready: the old generation could not (or only partially)
      // participate in graceful prepare — either no epoch was opened, or the
      // prepared epoch is unreliable because the manager degraded the restart.
      // Abandon it and reconstruct leases directly from durable state.
      if (epoch) await this.completeEpochBestEffort(epoch);
      if (event.reason === "crash") await this.recoverStartup("crash");
      return;
    }
    const ops = await this.workspaceState.lifecycleListOps(epoch);
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
    await this.workspaceState.lifecycleCompleteEpoch(epoch);
  }

  private async prepareTargets(
    epoch: string,
    targets: LifecycleKey[],
    reason: string,
    signal?: AbortSignal
  ): Promise<void> {
    const ordered = this.dedupe(targets);
    const phaseResults = new Map<LifecycleKey, unknown>();
    const quiesced = new Set<LifecycleKey>();
    const cancelPreparation = async (): Promise<unknown[]> => {
      const results = await Promise.allSettled(
        [...quiesced].map((target) =>
          this.deps.doDispatch
            .dispatchLifecycle(this.toRef(target), "prepare", {
              epoch,
              phase: "cancel",
              mode: "suspend",
              reason,
              deadlineMs: 0,
            })
            .then((result) => {
              if (result.status !== "ready")
                throw new Error("Lifecycle cancellation refused", { cause: result });
            })
        )
      );
      return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    };
    for (const phase of [
      "quiesce",
      "peer-obligations",
      "peer-durable-work",
      "delivery",
      "durable-work",
      "release",
    ] as const) {
      const failures: unknown[] = [];
      const failedTargets = new Set<LifecycleKey>();
      phaseResults.clear();
      if (phase === "delivery") {
        try {
          await this.deps.drainDurableWorkDeliveries(
            ordered.map((target) => this.toRef(target)),
            signal
          );
        } catch (original) {
          const cleanup = signal?.aborted ? [] : await cancelPreparation();
          if (cleanup.length)
            throw new AggregateError(
              [original, ...cleanup],
              "Lifecycle delivery preparation failed",
              { cause: original }
            );
          throw original;
        }
        continue;
      }
      await this.runPool(ordered, async (target) => {
        if (signal?.aborted) return;
        let result: unknown;
        if (phase === "quiesce") quiesced.add(target);
        try {
          if (phase === "durable-work" || phase === "peer-durable-work") {
            const ref = this.toRef(target);
            await this.deps.prepareDurableWorkRelease(
              ref,
              phase === "peer-durable-work" ? "peer-obligations" : "owner",
              signal
            );
            result = { status: "ready" };
          } else {
            result = await this.deps.doDispatch.dispatchLifecycle(this.toRef(target), "prepare", {
              epoch,
              phase,
              mode: "suspend",
              reason,
              deadlineMs: 0,
            });
          }
          if (
            !result ||
            typeof result !== "object" ||
            ((result as { status?: unknown }).status !== "ready" &&
              (result as { status?: unknown }).status !== "failed")
          ) {
            throw new Error("Lifecycle prepare returned no valid release receipt", {
              cause: result,
            });
          }
          if ((result as { status: string }).status === "failed") {
            const failure = deserializeRpcFailure((result as { failure: unknown }).failure);
            throw new Error(
              `Lifecycle ${phase} refused for ${target.source}:${target.className}/${target.objectKey}: ${failure.message}`,
              { cause: failure }
            );
          }
          phaseResults.set(target, result);
          if (phase === "quiesce") quiesced.add(target);
        } catch (original) {
          failures.push(original);
          failedTargets.add(target);
          phaseResults.set(target, serializeRpcFailure(original));
        }
      });
      // Destroyed-generation bookkeeping is invalid, but an owned dispatch's
      // original failure must still reach the restart owner after it joins.
      if (signal?.aborted) {
        if (failures.length)
          throw new AggregateError(failures, `Lifecycle ${phase} failed`, { cause: failures[0] });
        signal.throwIfAborted();
      }
      if (failures.length) {
        if (phase !== "release") failures.push(...(await cancelPreparation()));
        const bookkeeping = await Promise.allSettled(
          ordered.map((target) =>
            this.recordOp(
              epoch,
              target,
              "prepare",
              failedTargets.has(target) ? "failed" : "ready",
              {
                phase,
                result: phaseResults.get(target) ?? null,
              }
            )
          )
        );
        for (const result of bookkeeping)
          if (result.status === "rejected") failures.push(result.reason);
        throw new AggregateError(failures, `Lifecycle ${phase} failed`, { cause: failures[0] });
      }
    }
    const bookkeeping = await Promise.allSettled(
      ordered.map((target) =>
        this.recordOp(epoch, target, "prepare", "ready", {
          phase: "release",
          result: phaseResults.get(target) ?? null,
        })
      )
    );
    const failures = bookkeeping.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length)
      throw new AggregateError(failures, "Lifecycle prepare journal failed", {
        cause: failures[0],
      });
    signal?.throwIfAborted();
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
    const failures: unknown[] = [];
    await this.runPool(this.dedupe(targets), async (target) => {
      let originalFailure: unknown;
      let failed = false;
      try {
        await this.deps.doDispatch.dispatchLifecycle(this.toRef(target), "resume", {
          epoch,
          ...input,
        });
      } catch (original) {
        failed = true;
        originalFailure = original;
        failures.push(original);
      }
      try {
        await this.recordOp(
          epoch,
          target,
          "resume",
          failed ? "failed" : "resumed",
          failed
            ? {
                error:
                  originalFailure instanceof Error
                    ? originalFailure.message
                    : String(originalFailure),
              }
            : null
        );
      } catch (original) {
        failures.push(original);
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Lifecycle resume failed for ${failures.length} operation(s)`,
        {
          cause: failures[0],
        }
      );
    }
  }

  private async recordOp(
    epochId: string,
    key: LifecycleKey,
    opKind: "prepare" | "resume",
    status: "ready" | "failed" | "resumed",
    detail: unknown
  ): Promise<void> {
    await this.workspaceState.lifecycleRecordOp({ epochId, key, opKind, status, detail });
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
      await this.workspaceState.lifecycleCompleteEpoch(epoch);
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
}
