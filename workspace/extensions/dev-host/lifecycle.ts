import type {
  DevHostProviderLaunchInput,
  DevHostProviderPreparationFailure,
  DevHostProviderPreparationInput,
  DevHostProviderPreparationResult,
  DevHostProviderRebuildInput,
  DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";
import type {
  EvalCancelInput,
  EvalEventsInput,
  EvalGetInput,
  EvalRunHandle,
  EvalRunSnapshot,
  EvalStartInput,
  EvalParentAuthorityEnvelope,
} from "@vibestudio/service-schemas/eval";

type ApprovedInput = DevHostProviderLaunchInput | DevHostProviderRebuildInput;
type CustodyInput = DevHostProviderPreparationInput["request"] | ApprovedInput;

export interface DevGeneration {
  hostBuildId: string;
  readinessIdentity: NonNullable<DevLaunchStatus["readinessIdentity"]>;
  childWorkspaceId: string | null;
  childContextId: string | null;
  clientReadinessIdentity: DevLaunchStatus["clientReadinessIdentity"];
  processIdentity: string;
}

export interface DevGenerationExit {
  launchId: string;
  hostBuildId: string;
  processIdentity: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface DevHostExecutor {
  build(
    input: DevHostProviderLaunchInput | DevHostProviderRebuildInput
  ): Promise<{ hostBuildId: string }>;
  validate(
    input: DevHostProviderLaunchInput | DevHostProviderRebuildInput,
    hostBuildId: string
  ): Promise<void>;
  start(
    input: DevHostProviderLaunchInput | DevHostProviderRebuildInput,
    hostBuildId: string
  ): Promise<DevGeneration>;
  restart(generation: DevGeneration): Promise<DevGeneration>;
  onUnexpectedExit(listener: (exit: DevGenerationExit) => void): () => void;
  stop(generation: DevGeneration): Promise<void>;
  rollbackCandidate(
    candidate: DevGeneration | null,
    previous: DevGeneration
  ): Promise<DevGeneration>;
  commitPromotion(candidate: DevGeneration, previous: DevGeneration): Promise<void>;
  /** Release an input that never became a live generation. Idempotent. */
  discard(
    input: CustodyInput,
    hostBuildId?: string
  ): Promise<void>;
  evalStart(
    generation: DevGeneration,
    input: EvalStartInput,
    authority: EvalParentAuthorityEnvelope
  ): Promise<EvalRunHandle>;
  evalGet(generation: DevGeneration, input: EvalGetInput): Promise<EvalRunSnapshot>;
  evalEvents(
    generation: DevGeneration,
    input: EvalEventsInput
  ): Promise<{ events: unknown[]; next: number }>;
  evalCancel(
    generation: DevGeneration,
    input: EvalCancelInput
  ): Promise<{ status: "requested" | "cancelled" | "terminal" }>;
  logs(
    launchId: string,
    after: number
  ): Array<{ seq: number; at: number; level: string; message: string }>;
  onLog(
    listener: (
      launchId: string,
      entry: { seq: number; at: number; level: string; message: string }
    ) => void
  ): () => void;
  appendLog?(launchId: string, level: string, message: string): void;
  reconcilePersisted(
    record: DevLaunchStatus
  ): Promise<
    | { status: "recovered"; generation: DevGeneration }
    | { status: "not-running" | "terminated" | "unverifiable" }
  >;
}

export interface DevLifecycleStore {
  load(): Promise<DevLaunchStatus[]>;
  save(records: DevLaunchStatus[]): Promise<void>;
  loadPreparations(): Promise<DevHostProviderPreparationInput[]>;
  savePreparations(preparations: DevHostProviderPreparationInput[]): Promise<void>;
}

export class DevHostLifecycle {
  private records: DevLaunchStatus[] = [];
  private generations = new Map<string, DevGeneration>();
  private preparations = new Map<string, DevHostProviderPreparationInput>();
  private serial = new Map<string, Promise<unknown>>();
  private events = new Map<
    string,
    Array<{ seq: number; state: DevLaunchStatus["state"]; at: number }>
  >();
  private readonly crashTimes = new Map<string, number[]>();
  private unsubscribeUnexpectedExit: (() => void) | null = null;
  private readonly eventListeners = new Set<
    (launchId: string, event: { seq: number; state: DevLaunchStatus["state"]; at: number }) => void
  >();

  constructor(
    private readonly store: DevLifecycleStore,
    private readonly executor: DevHostExecutor,
    private readonly now: () => number = Date.now,
    private readonly restartPolicy: {
      maximumCrashes: number;
      windowMs: number;
      delay: (attempt: number) => Promise<void>;
    } = {
      maximumCrashes: 5,
      windowMs: 60_000,
      delay: (attempt) => wait(Math.min(16_000, 1_000 * 2 ** (attempt - 1))),
    }
  ) {}

  async start(): Promise<void> {
    this.unsubscribeUnexpectedExit?.();
    this.unsubscribeUnexpectedExit = this.executor.onUnexpectedExit((exit) => {
      void this.recoverUnexpectedExit(exit);
    });
    this.records = await this.store.load();
    this.preparations = new Map(
      (await this.store.loadPreparations()).map((preparation) => [
        preparation.request.launchId,
        preparation,
      ])
    );
    const knownLaunches = new Set(this.records.map((record) => record.launchId));
    for (const [launchId, preparation] of this.preparations) {
      if (knownLaunches.has(launchId)) continue;
      await this.executor.discard(preparation.request).catch(() => undefined);
      this.preparations.delete(launchId);
    }
    for (const record of this.records) {
      if (
        record.state === "awaiting-approval" ||
        record.state === "awaiting-candidate-approval"
      ) {
        const preparation = this.preparations.get(record.launchId);
        if (preparation) {
          await this.executor.discard(preparation.request).catch(() => undefined);
          this.preparations.delete(record.launchId);
        }
        const candidate = record.state === "awaiting-candidate-approval";
        record.state = candidate ? "candidate-failed" : "failed";
        clearCandidate(record);
        record.lastError = {
          phase: "recovery",
          code: "APPROVAL_INTERRUPTED",
          message:
            "The host restarted while execution approval was pending; request the build again",
          at: this.now(),
        };
        record.updatedAt = this.now();
      }
      if (record.state !== "stopped" && record.state !== "failed") {
        const reconciliation = await this.executor.reconcilePersisted(record);
        if (reconciliation.status === "recovered") {
          const generation = reconciliation.generation;
          this.generations.set(record.launchId, generation);
          record.state = "ready";
          record.activeHostBuildId = generation.hostBuildId;
          record.candidateHostBuildId = null;
          record.readinessIdentity = generation.readinessIdentity;
          record.childWorkspaceId = generation.childWorkspaceId;
          record.childContextId = generation.childContextId;
          record.clientReadinessIdentity = generation.clientReadinessIdentity;
          record.processIdentity = generation.processIdentity;
          record.restartCount = record.restartCount ?? 0;
          if (record.lastError?.code !== "APPROVAL_INTERRUPTED") record.lastError = null;
          record.updatedAt = this.now();
          continue;
        }
        record.state = "failed";
        record.lastError = {
          phase: "recovery",
          code:
            reconciliation.status === "terminated"
              ? "RECOVERED_PROCESS_RETIRED"
              : reconciliation.status === "unverifiable"
                ? "PROCESS_IDENTITY_UNVERIFIABLE"
                : "PROCESS_NOT_RUNNING",
          message:
            reconciliation.status === "terminated"
              ? "A verified orphan generation was retired; relaunch is required"
              : reconciliation.status === "unverifiable"
                ? "A recorded process could not be verified and was left untouched for operator repair"
                : "The recorded generation is no longer running; relaunch is required",
          at: this.now(),
        };
        record.processIdentity = null;
      }
    }
    await this.persistPreparations();
    await this.persist();
  }

  status(): DevLaunchStatus[] {
    return structuredClone(this.records);
  }

  prepare(input: DevHostProviderPreparationInput): Promise<DevHostProviderPreparationResult> {
    const request = input.request;
    return this.serialize(request.launchId, async () => {
      const existing = this.find(request.launchId);
      if (input.operation === "launch") {
        if (existing) {
          if (!sameLaunchRequest(existing, input.request)) {
            throw Object.assign(
              new Error(`Idempotency key for ${request.launchId} was reused with different input`),
              { code: "EIDEMPOTENCY" }
            );
          }
          await this.executor.discard(input.request);
          return { proceed: false, status: structuredClone(existing) };
        }
        const record = initialRecord(input.request, this.now());
        this.records.push(record);
        this.preparations.set(request.launchId, input);
        await this.persistPreparations();
        await this.transition(record, "snapshotting");
        await this.transition(record, "awaiting-approval");
        return { proceed: true, status: structuredClone(record), request: input.request };
      }

      const record = this.require(request.launchId);
      const pending = this.preparations.get(request.launchId);
      if (
        record.sourceStateHash === request.sourceStateHash &&
        record.executionInputHash === request.snapshot.executionInputHash &&
        record.recipeDigest === request.snapshot.recipeDigest
      ) {
        if (pending) {
          await this.executor.discard(pending.request);
          this.preparations.delete(request.launchId);
          await this.persistPreparations();
          clearCandidate(record);
          if (record.state !== "ready") await this.transition(record, "ready");
        }
        await this.executor.discard(request);
        return { proceed: false, status: structuredClone(record) };
      }
      if (pending) {
        if (sameLogicalRequest(pending.request, request)) {
          await this.executor.discard(request);
          return {
            proceed: true,
            status: structuredClone(record),
            request: structuredClone(pending.request),
          };
        }
        await this.executor.discard(pending.request);
      }
      if (!pending && record.state !== "ready" && record.state !== "candidate-failed") {
        throw Object.assign(new Error(`Launch is not rebuildable from ${record.state}`), {
          code: "ENOTREADY",
        });
      }
      record.candidateSourceStateHash = request.sourceStateHash;
      record.candidateDirtyCount = request.dirtyCount;
      record.candidateExecutionInputHash = request.snapshot.executionInputHash;
      record.candidateRecipeDigest = request.snapshot.recipeDigest;
      record.candidateSnapshotId = request.snapshot.snapshotId;
      this.preparations.set(request.launchId, input);
      await this.persistPreparations();
      await this.transition(record, "snapshotting-candidate");
      await this.transition(record, "awaiting-candidate-approval");
      return { proceed: true, status: structuredClone(record), request: input.request };
    });
  }

  failPreparation(
    input: DevHostProviderPreparationInput,
    failure: DevHostProviderPreparationFailure
  ): Promise<DevLaunchStatus> {
    return this.serialize(input.request.launchId, async () => {
      const record = this.require(input.request.launchId);
      const pending = this.preparations.get(record.launchId);
      if (!pending || !sameExactRequest(pending.request, input.request)) {
        throw Object.assign(new Error("Pending development snapshot identity changed"), {
          code: "SNAPSHOT_IDENTITY_MISMATCH",
        });
      }
      await this.executor.discard(pending.request);
      this.preparations.delete(record.launchId);
      await this.persistPreparations();
      record.lastError = { ...failure, at: this.now() };
      clearCandidate(record);
      await this.transition(record, input.operation === "rebuild" ? "candidate-failed" : "failed");
      return structuredClone(record);
    });
  }

  launch(input: DevHostProviderLaunchInput): Promise<DevLaunchStatus> {
    return this.serialize(input.launchId, async () => {
      const existing = this.find(input.launchId);
      if (existing) {
        const pending = this.preparations.get(input.launchId);
        if (existing.state === "awaiting-approval" && pending?.operation === "launch") {
          if (!sameExactRequest(pending.request, input)) {
            await this.executor.discard(input);
            throw Object.assign(new Error("Approved development snapshot identity changed"), {
              code: "SNAPSHOT_IDENTITY_MISMATCH",
            });
          }
          try {
            return await this.buildCandidate(existing, input, true);
          } finally {
            await this.clearPreparation(input.launchId);
          }
        }
        if (!sameLaunchRequest(existing, input)) {
          await this.executor.discard(input);
          throw Object.assign(
            new Error(`Idempotency key for ${input.launchId} was reused with different input`),
            { code: "EIDEMPOTENCY" }
          );
        }
        await this.executor.discard(input);
        return structuredClone(existing);
      }
      const now = this.now();
      const record = initialRecord(input, now);
      this.records.push(record);
      await this.transition(record, "snapshotting");
      return this.buildCandidate(record, input, true);
    });
  }

  rebuild(input: DevHostProviderRebuildInput): Promise<{
    launchId: string;
    executionInputHash: string;
    hostBuildId: string | null;
    active: boolean;
    state: DevLaunchStatus["state"];
  }> {
    return this.serialize(input.launchId, async () => {
      const record = this.require(input.launchId);
      const pending = this.preparations.get(input.launchId);
      if (record.state === "awaiting-candidate-approval" && pending?.operation === "rebuild") {
        if (!sameExactRequest(pending.request, input)) {
          await this.executor.discard(input);
          throw Object.assign(new Error("Approved candidate snapshot identity changed"), {
            code: "SNAPSHOT_IDENTITY_MISMATCH",
          });
        }
        try {
          const result = await this.buildCandidate(record, input, false);
          return buildResult(result, input.snapshot.executionInputHash);
        } finally {
          await this.clearPreparation(input.launchId);
        }
      }
      if (record.state !== "ready" && record.state !== "candidate-failed") {
        throw Object.assign(new Error(`Launch is not rebuildable from ${record.state}`), {
          code: "ENOTREADY",
        });
      }
      if (
        record.state === "ready" &&
        record.sourceStateHash === input.sourceStateHash &&
        record.executionInputHash === input.snapshot.executionInputHash &&
        record.recipeDigest === input.snapshot.recipeDigest
      ) {
        await this.executor.discard(input);
        return {
          launchId: record.launchId,
          executionInputHash: record.executionInputHash,
          hostBuildId: record.activeHostBuildId,
          active: true,
          state: "ready",
        };
      }
      const result = await this.buildCandidate(record, input, false);
      return buildResult(result, input.snapshot.executionInputHash);
    });
  }

  stop(launchId: string): Promise<{ launchId: string; stopped: boolean }> {
    return this.serialize(launchId, async () => {
      const record = this.require(launchId);
      if (record.state === "stopped") return { launchId, stopped: true };
      await this.transition(record, "stopping");
      const generation = this.generations.get(launchId);
      if (generation) await this.executor.stop(generation);
      this.generations.delete(launchId);
      await this.transition(record, "stopped");
      record.processIdentity = null;
      await this.persist();
      return { launchId, stopped: true };
    });
  }

  private activeGeneration(launchId: string): DevGeneration {
    const record = this.require(launchId);
    const generation = this.generations.get(launchId);
    if (
      !activeGenerationAvailable(record) ||
      !generation ||
      generation.hostBuildId !== record.activeHostBuildId
    ) {
      throw Object.assign(new Error("No verified active generation"), { code: "ENOTREADY" });
    }
    return generation;
  }

  evalStart(
    launchId: string,
    input: EvalStartInput,
    authority: EvalParentAuthorityEnvelope
  ): Promise<EvalRunHandle> {
    return this.executor.evalStart(this.activeGeneration(launchId), input, authority);
  }

  evalGet(launchId: string, input: EvalGetInput): Promise<EvalRunSnapshot> {
    return this.executor.evalGet(this.activeGeneration(launchId), input);
  }

  evalEvents(
    launchId: string,
    input: EvalEventsInput
  ): Promise<{ events: unknown[]; next: number }> {
    return this.executor.evalEvents(this.activeGeneration(launchId), input);
  }

  evalCancel(
    launchId: string,
    input: EvalCancelInput
  ): Promise<{ status: "requested" | "cancelled" | "terminal" }> {
    return this.executor.evalCancel(this.activeGeneration(launchId), input);
  }

  logs(launchId: string, after = 0): Response {
    this.require(launchId);
    return ndjsonStream(this.executor.logs(launchId, after), (push) =>
      this.executor.onLog((entryLaunchId, entry) => {
        if (entryLaunchId === launchId && entry.seq > after) push(entry);
      })
    );
  }

  watch(launchId: string, after = 0): Response {
    this.require(launchId);
    return ndjsonStream(
      (this.events.get(launchId) ?? []).filter((entry) => entry.seq > after),
      (push) => {
        const listener = (
          eventLaunchId: string,
          event: { seq: number; state: DevLaunchStatus["state"]; at: number }
        ) => {
          if (eventLaunchId === launchId && event.seq > after) push(event);
        };
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
      }
    );
  }

  private async buildCandidate(
    record: DevLaunchStatus,
    input: DevHostProviderLaunchInput | DevHostProviderRebuildInput,
    first: boolean
  ): Promise<DevLaunchStatus> {
    const previous = this.generations.get(record.launchId);
    let candidate: DevGeneration | null = null;
    let candidateBuildId: string | undefined;
    const previousIdentity = {
      stateHash: record.sourceStateHash,
      dirtyCount: record.dirtyCount,
      inputHash: record.executionInputHash,
      recipeDigest: record.recipeDigest,
      activeBuild: record.activeHostBuildId,
      readiness: record.readinessIdentity,
      childWorkspaceId: record.childWorkspaceId,
      childContextId: record.childContextId,
      clientReadiness: record.clientReadinessIdentity,
      processIdentity: record.processIdentity,
      activeSnapshotId: record.activeSnapshotId,
    };
    try {
      if (first) await this.transition(record, "bootstrapping");
      await this.transition(record, first ? "building" : "building-candidate");
      const built = await this.executor.build(input);
      candidateBuildId = built.hostBuildId;
      record.candidateHostBuildId = built.hostBuildId;
      await this.transition(record, first ? "validating" : "validating-candidate");
      await this.executor.validate(input, built.hostBuildId);
      await this.transition(record, first ? "starting" : "starting-candidate");
      candidate = await this.executor.start(input, built.hostBuildId);
      if (
        candidate.hostBuildId !== built.hostBuildId ||
        candidate.readinessIdentity.launchId !== record.launchId ||
        candidate.readinessIdentity.hostBuildId !== built.hostBuildId
      ) {
        throw Object.assign(new Error("Candidate ready identity did not match launch/build"), {
          code: "READY_IDENTITY_MISMATCH",
        });
      }
      await this.transition(record, first ? "pairing" : "pairing-candidate");
      await this.transition(record, first ? "promoting" : "promoting-candidate");
      this.generations.set(record.launchId, candidate);
      record.sourceStateHash = input.sourceStateHash;
      record.dirtyCount = input.dirtyCount;
      record.executionInputHash = input.snapshot.executionInputHash;
      record.recipeDigest = input.snapshot.recipeDigest;
      record.activeSnapshotId = input.snapshot.snapshotId;
      record.activeHostBuildId = built.hostBuildId;
      record.candidateHostBuildId = null;
      record.readinessIdentity = candidate.readinessIdentity;
      record.childWorkspaceId = candidate.childWorkspaceId;
      record.childContextId = candidate.childContextId;
      record.clientReadinessIdentity = candidate.clientReadinessIdentity;
      record.processIdentity = candidate.processIdentity;
      record.restartCount = 0;
      record.lastError = null;
      clearCandidate(record);
      await this.transition(record, "ready");
      if (previous && previous.processIdentity !== candidate.processIdentity) {
        await this.executor.commitPromotion(candidate, previous);
        await this.transition(record, "retiring-old-generation");
        await this.executor
          .stop(previous)
          .catch((error) =>
            this.log(record.launchId, "warn", `Old generation cleanup failed: ${String(error)}`)
          );
        await this.transition(record, "ready");
      }
      return structuredClone(record);
    } catch (error) {
      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "DEV_HOST_FAILED";
      record.lastError = {
        phase: record.state,
        code,
        message: error instanceof Error ? error.message : String(error),
        at: this.now(),
      };
      if (!first && previous) {
        try {
          const restored = await this.executor.rollbackCandidate(candidate, previous);
          this.generations.set(record.launchId, restored);
          previousIdentity.processIdentity = restored.processIdentity;
          previousIdentity.readiness = restored.readinessIdentity;
          previousIdentity.childWorkspaceId = restored.childWorkspaceId;
          previousIdentity.childContextId = restored.childContextId;
          previousIdentity.clientReadiness = restored.clientReadinessIdentity;
        } catch (rollbackError) {
          this.log(record.launchId, "error", `Candidate rollback failed: ${String(rollbackError)}`);
          const rollbackCode =
            typeof (rollbackError as { code?: unknown })?.code === "string"
              ? (rollbackError as { code: string }).code
              : "ROLLBACK_FAILED";
          record.lastError = {
            phase: "rollback",
            code: rollbackCode,
            message:
              "Candidate failed and the retained last-good generation could not be restored: " +
              (rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
            at: this.now(),
          };
          await this.transition(record, "failed");
          return structuredClone(record);
        }
        if (!candidate) await this.executor.discard(input, candidateBuildId).catch(() => undefined);
        record.sourceStateHash = previousIdentity.stateHash;
        record.dirtyCount = previousIdentity.dirtyCount;
        record.executionInputHash = previousIdentity.inputHash;
        record.recipeDigest = previousIdentity.recipeDigest;
        record.activeHostBuildId = previousIdentity.activeBuild;
        record.readinessIdentity = previousIdentity.readiness;
        record.childWorkspaceId = previousIdentity.childWorkspaceId;
        record.childContextId = previousIdentity.childContextId;
        record.clientReadinessIdentity = previousIdentity.clientReadiness;
        record.processIdentity = previousIdentity.processIdentity;
        record.activeSnapshotId = previousIdentity.activeSnapshotId;
        clearCandidate(record);
        await this.transition(record, "candidate-failed");
      } else {
        if (candidate) {
          await this.executor.stop(candidate).catch(() => undefined);
          this.generations.delete(record.launchId);
        } else {
          await this.executor.discard(input, candidateBuildId).catch(() => undefined);
        }
        clearCandidate(record);
        await this.transition(record, "failed");
      }
      return structuredClone(record);
    }
  }

  private async transition(
    record: DevLaunchStatus,
    state: DevLaunchStatus["state"]
  ): Promise<void> {
    record.state = state;
    record.updatedAt = this.now();
    const events = this.events.get(record.launchId) ?? [];
    events.push({ seq: events.length + 1, state, at: record.updatedAt });
    this.events.set(record.launchId, events);
    await this.persist();
    for (const listener of this.eventListeners) listener(record.launchId, events.at(-1)!);
  }

  private recoverUnexpectedExit(exit: DevGenerationExit): Promise<void> {
    return this.serialize(exit.launchId, async () => {
      const record = this.find(exit.launchId);
      const active = this.generations.get(exit.launchId);
      if (
        !record ||
        !active ||
        active.processIdentity !== exit.processIdentity ||
        active.hostBuildId !== exit.hostBuildId ||
        record.activeHostBuildId !== exit.hostBuildId ||
        record.state === "stopping" ||
        record.state === "stopped" ||
        record.state === "failed"
      ) {
        return;
      }

      const now = this.now();
      const recent = (this.crashTimes.get(exit.launchId) ?? []).filter(
        (at) => now - at <= this.restartPolicy.windowMs
      );
      recent.push(now);
      this.crashTimes.set(exit.launchId, recent);
      record.lastError = {
        phase: "runtime",
        code: "GENERATION_EXITED",
        message: `Managed generation exited with ${exit.code ?? exit.signal ?? "unknown status"}`,
        at: now,
      };
      record.processIdentity = null;
      if (recent.length > this.restartPolicy.maximumCrashes) {
        this.log(
          exit.launchId,
          "error",
          `Restart storm cutoff reached after ${recent.length} crashes in ${this.restartPolicy.windowMs}ms`
        );
        this.generations.delete(exit.launchId);
        await this.executor.stop(active).catch(() => undefined);
        await this.transition(record, "failed");
        return;
      }

      await this.transition(record, "restarting");
      record.restartCount += 1;
      await this.persist();
      this.log(
        exit.launchId,
        "warn",
        `Restarting exact generation ${exit.hostBuildId} after unexpected process exit (attempt ${recent.length})`
      );
      await this.restartPolicy.delay(recent.length);
      try {
        const restarted = await this.executor.restart(active);
        if (
          restarted.hostBuildId !== exit.hostBuildId ||
          restarted.readinessIdentity.launchId !== exit.launchId ||
          restarted.readinessIdentity.hostBuildId !== exit.hostBuildId
        ) {
          await this.executor.stop(restarted).catch(() => undefined);
          throw Object.assign(new Error("Restarted generation identity changed"), {
            code: "RESTART_IDENTITY_MISMATCH",
          });
        }
        this.generations.set(exit.launchId, restarted);
        record.readinessIdentity = restarted.readinessIdentity;
        record.childWorkspaceId = restarted.childWorkspaceId;
        record.childContextId = restarted.childContextId;
        record.clientReadinessIdentity = restarted.clientReadinessIdentity;
        record.processIdentity = restarted.processIdentity;
        record.lastError = null;
        await this.transition(record, "ready");
      } catch (error) {
        const code =
          typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : "GENERATION_RESTART_FAILED";
        record.lastError = {
          phase: "restart",
          code,
          message: error instanceof Error ? error.message : String(error),
          at: this.now(),
        };
        this.generations.delete(exit.launchId);
        await this.executor.stop(active).catch(() => undefined);
        await this.transition(record, "failed");
      }
    });
  }

  private log(launchId: string, level: string, message: string): void {
    this.executor.appendLog?.(launchId, level, message);
  }

  private find(launchId: string): DevLaunchStatus | undefined {
    return this.records.find((record) => record.launchId === launchId);
  }

  private require(launchId: string): DevLaunchStatus {
    const record = this.find(launchId);
    if (!record)
      throw Object.assign(new Error(`Unknown development launch: ${launchId}`), { code: "ENOENT" });
    return record;
  }

  private async persist(): Promise<void> {
    await this.store.save(this.records);
  }

  private async persistPreparations(): Promise<void> {
    await this.store.savePreparations([...this.preparations.values()]);
  }

  private async clearPreparation(launchId: string): Promise<void> {
    if (!this.preparations.delete(launchId)) return;
    await this.persistPreparations();
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.serial.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    this.serial.set(key, next);
    next
      .finally(() => {
        if (this.serial.get(key) === next) this.serial.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
}

function activeGenerationAvailable(record: DevLaunchStatus): boolean {
  return (
    record.activeHostBuildId !== null &&
    [
      "ready",
      "snapshotting-candidate",
      "awaiting-candidate-approval",
      "building-candidate",
      "validating-candidate",
      "starting-candidate",
      "pairing-candidate",
      "promoting-candidate",
      "retiring-old-generation",
      "candidate-failed",
    ].includes(record.state)
  );
}

function sameLaunchRequest(
  record: DevLaunchStatus,
  input: Extract<DevHostProviderPreparationInput, { operation: "launch" }>["request"] | DevHostProviderLaunchInput
): boolean {
  return (
    record.owner.principal === input.owner.principal &&
    record.owner.workspaceId === input.owner.workspaceId &&
    record.owner.contextId === input.owner.contextId &&
    record.sourceStateHash === input.sourceStateHash &&
    record.executionInputHash === input.snapshot.executionInputHash &&
    record.recipeDigest === input.snapshot.recipeDigest &&
    JSON.stringify(record.target) === JSON.stringify(input.target)
  );
}

function sameExactRequest(left: CustodyInput, right: CustodyInput): boolean {
  return (
    left.launchId === right.launchId &&
    left.owner.principal === right.owner.principal &&
    left.owner.workspaceId === right.owner.workspaceId &&
    left.owner.contextId === right.owner.contextId &&
    left.sourceStateHash === right.sourceStateHash &&
    left.dirtyCount === right.dirtyCount &&
    left.snapshot.snapshotId === right.snapshot.snapshotId &&
    left.snapshot.executionInputHash === right.snapshot.executionInputHash &&
    left.snapshot.recipeDigest === right.snapshot.recipeDigest &&
    JSON.stringify(left.target) === JSON.stringify(right.target)
  );
}

function sameLogicalRequest(left: CustodyInput, right: CustodyInput): boolean {
  return (
    left.launchId === right.launchId &&
    left.owner.principal === right.owner.principal &&
    left.owner.workspaceId === right.owner.workspaceId &&
    left.owner.contextId === right.owner.contextId &&
    left.sourceStateHash === right.sourceStateHash &&
    left.dirtyCount === right.dirtyCount &&
    left.snapshot.executionInputHash === right.snapshot.executionInputHash &&
    left.snapshot.recipeDigest === right.snapshot.recipeDigest &&
    JSON.stringify(left.target) === JSON.stringify(right.target)
  );
}

function clearCandidate(record: DevLaunchStatus): void {
  record.candidateHostBuildId = null;
  record.candidateSourceStateHash = null;
  record.candidateDirtyCount = null;
  record.candidateExecutionInputHash = null;
  record.candidateRecipeDigest = null;
  record.candidateSnapshotId = null;
}

function buildResult(
  result: DevLaunchStatus,
  executionInputHash: string
): {
  launchId: string;
  executionInputHash: string;
  hostBuildId: string | null;
  active: boolean;
  state: DevLaunchStatus["state"];
} {
  return {
    launchId: result.launchId,
    executionInputHash,
    hostBuildId: result.activeHostBuildId,
    active: result.state === "ready" && result.executionInputHash === executionInputHash,
    state: result.state,
  };
}

function initialRecord(
  input: Extract<DevHostProviderPreparationInput, { operation: "launch" }>["request"] | DevHostProviderLaunchInput,
  now: number
): DevLaunchStatus {
  return {
    launchId: input.launchId,
    owner: input.owner,
    sourceRepoPath: "projects/vibestudio",
    sourceStateHash: input.sourceStateHash,
    dirtyCount: input.dirtyCount,
    executionInputHash: input.snapshot.executionInputHash,
    recipeDigest: input.snapshot.recipeDigest,
    activeSnapshotId: null,
    candidateSourceStateHash: null,
    candidateDirtyCount: null,
    candidateExecutionInputHash: null,
    candidateRecipeDigest: null,
    candidateSnapshotId: null,
    target: input.target,
    state: "requested",
    activeHostBuildId: null,
    candidateHostBuildId: null,
    readinessIdentity: null,
    childWorkspaceId: null,
    childContextId: null,
    clientReadinessIdentity: null,
    processIdentity: null,
    restartCount: 0,
    startedAt: now,
    updatedAt: now,
    lastError: null,
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ndjsonStream<T>(initial: readonly T[], subscribe: (push: (value: T) => void) => () => void): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (value: T) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      for (const value of initial) push(value);
      unsubscribe = subscribe(push);
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}
