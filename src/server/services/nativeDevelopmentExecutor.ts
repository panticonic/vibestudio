import { createHash } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { VcsImportSnapshotResult, VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import type { RpcCausalParent } from "@vibestudio/rpc";
import { canonicalJson, compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { domainHash } from "@vibestudio/shared/execution/identity";
import { semanticVcsPathAdmission } from "@vibestudio/shared/vcs/pathAdmission";
import { putFile } from "./blobstoreService.js";
import { writeFileAtomicSync } from "../../atomicFile.js";

const SESSION_ID = /^[A-Za-z0-9._-]{1,160}$/u;
const MARKER_FILE = "SESSION.json";
const REPOSITORY_DIRECTORY = "repository";
const HOME_DIRECTORY = "home";
const CHECKPOINT_DIRECTORY = "checkpoints";

export type NativeDevelopmentToolId = "claude-code" | "system-editor";

export interface NativeDevelopmentSourcePlan {
  version: 1;
  contextId: string;
  repositoryId: string;
  repoPath: string;
  sourceState: VcsStateNodeRef;
  planDigest: string;
}

export interface NativeSnapshotFile {
  path: string;
  contentHash: string;
  /** Exact canonical semantic permission bits. Special native mode bits are rejected. */
  mode: number;
}

export interface NativeSnapshotDescriptor {
  version: 1;
  repositoryId: string;
  repoPath: string;
  source: {
    kind: "filesystem";
    uri: string;
    snapshotRevision: string;
  };
  files: NativeSnapshotFile[];
  descriptorDigest: string;
}

export interface NativeDevelopmentCheckpointReceipt {
  version: 1;
  sessionId: string;
  idempotencyKey: string;
  commandId: string;
  snapshotRevision: string;
  descriptorDigest: string;
  imported: VcsImportSnapshotResult;
  checkpointedAt: number;
}

export interface NativeDevelopmentProcessIdentity {
  /**
   * Opaque identity minted by the reviewed tool driver. It must identify the
   * exact process group/job object, not merely a reusable numeric pid.
   */
  ownershipToken: string;
  processId: string;
  terminalSessionId?: string;
}

export interface NativeDevelopmentTerminalSnapshot {
  terminalSessionId: string;
  cursor: number;
  text: string;
  alive: boolean;
  exit: { code: number; signal?: number } | null;
}

export interface NativeDevelopmentTerminalSurface {
  read(input: {
    terminalSessionId: string;
    after?: number;
    maxBytes?: number;
  }): NativeDevelopmentTerminalSnapshot;
  write(input: { terminalSessionId: string; writeId: string; data: string }): void;
  resize(input: { terminalSessionId: string; columns: number; rows: number }): void;
}

export interface NativeDevelopmentToolHandle {
  readonly identity: NativeDevelopmentProcessIdentity;
  /**
   * Resolve only after the complete owned process tree has acknowledged that
   * it will not write until resumeCheckpoint resolves.
   */
  freezeForCheckpoint(): Promise<void>;
  resumeCheckpoint(): Promise<void>;
  stop(): Promise<void>;
  /** Release the surfaced terminal only when the owning session is retired. */
  retire(): Promise<void>;
}

export interface NativeDevelopmentToolDriver {
  readonly toolId: NativeDevelopmentToolId;
  readonly executorId: string;
  readonly terminalSurface?: NativeDevelopmentTerminalSurface;
  availability(): Promise<
    | { available: true }
    | {
        available: false;
        reason: NativeDevelopmentExecutorUnavailableError["reason"];
      }
  >;
  launch(input: {
    sessionId: string;
    ownedRootId: string;
    repositoryRoot: string;
    homeRoot: string;
  }): Promise<NativeDevelopmentToolHandle>;
}

export class NativeDevelopmentExecutorUnavailableError extends Error {
  readonly code = "EEXECUTOR_UNAVAILABLE";

  constructor(
    readonly toolId: NativeDevelopmentToolId,
    readonly executorId: string,
    readonly reason:
      | "not-installed"
      | "checkpoint-protocol-unavailable"
      | "platform-unsupported"
      | "version-unsupported"
  ) {
    super(`Native tool ${toolId} is unavailable on executor ${executorId}: ${reason}`);
    this.name = "NativeDevelopmentExecutorUnavailableError";
  }
}

/**
 * Registering an unavailable reviewed target keeps product behavior typed and
 * inspectable. We never fall back to EDITOR/PATH or launch a tool that cannot
 * prove the cooperative checkpoint protocol.
 */
export class UnavailableNativeDevelopmentToolDriver implements NativeDevelopmentToolDriver {
  constructor(
    readonly toolId: NativeDevelopmentToolId,
    readonly executorId: string,
    readonly reason: NativeDevelopmentExecutorUnavailableError["reason"]
  ) {}

  availability(): Promise<{
    available: false;
    reason: NativeDevelopmentExecutorUnavailableError["reason"];
  }> {
    return Promise.resolve({ available: false, reason: this.reason });
  }

  launch(): Promise<NativeDevelopmentToolHandle> {
    return Promise.reject(
      new NativeDevelopmentExecutorUnavailableError(this.toolId, this.executorId, this.reason)
    );
  }
}

/**
 * The allowlist boundary. Callers select a reviewed id; executable, arguments,
 * environment, and checkpoint mechanics remain sealed in the driver.
 */
export class ReviewedNativeDevelopmentTools {
  private readonly drivers = new Map<NativeDevelopmentToolId, NativeDevelopmentToolDriver>();

  constructor(drivers: readonly NativeDevelopmentToolDriver[]) {
    for (const driver of drivers) {
      if (this.drivers.has(driver.toolId)) {
        throw coded("EINVAL", `Duplicate native development tool ${driver.toolId}`);
      }
      this.drivers.set(driver.toolId, driver);
    }
  }

  get(toolId: NativeDevelopmentToolId): NativeDevelopmentToolDriver {
    const driver = this.drivers.get(toolId);
    if (!driver) throw coded("EEXECUTOR_UNAVAILABLE", `Native tool ${toolId} is not reviewed`);
    return driver;
  }
}

export interface NativeDevelopmentSemanticAdapter {
  commitChildBase(input: {
    developmentContextId: string;
    expectedWorkingHead: VcsStateNodeRef;
    commandId: string;
    message: string;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<VcsStateNodeRef>;
  importSnapshot(input: {
    developmentContextId: string;
    repositoryId: string;
    expectedWorkingHead: VcsStateNodeRef;
    commandId: string;
    descriptor: NativeSnapshotDescriptor;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<VcsImportSnapshotResult>;
}

export interface NativeDevelopmentSemanticIngress {
  causalParent: RpcCausalParent | null;
  contextIntegrity:
    | { class: "internal"; externalKeys: readonly [] }
    | { class: "external"; externalKeys: readonly string[] };
}

export interface NativeDevelopmentSessionReceipt {
  version: 1;
  sessionId: string;
  ownedRootId: string;
  executorId: string;
  toolId: NativeDevelopmentToolId;
  developmentContextId: string;
  repositoryId: string;
  /** Canonical semantic repository coordinate, never a host filesystem path. */
  repoPath: string;
  baseEvent: VcsStateNodeRef;
  baseSnapshotRevision: string;
  state: NativeSessionMarker["state"];
  process: NativeDevelopmentProcessIdentity | null;
  lastCheckpoint: NativeDevelopmentCheckpointReceipt | null;
  pendingChanges: "none" | "present" | "unknown";
  repair: NativeRepair | null;
}

interface NativeRepair {
  phase: string;
  primaryError: string;
  cleanupErrors: string[];
  attention: "actionable" | "kept";
  knownEffects: {
    nativeTree: "owned" | "absent" | "unknown";
    process: "owned" | "absent" | "unknown";
    importedEvent: "present" | "absent" | "unknown";
  };
}

interface PendingCheckpoint {
  idempotencyKey: string;
  commandId: string;
  phase: "freezing" | "prepared" | "imported";
  expectedWorkingHead: VcsStateNodeRef;
  snapshotRevision?: string;
  descriptorDigest?: string;
  imported?: VcsImportSnapshotResult;
  checkpointedAt?: number;
}

interface NativeSessionMarker {
  version: 1;
  sessionId: string;
  ownedRootId: string;
  executorId: string;
  toolId: NativeDevelopmentToolId;
  developmentContextId: string;
  repositoryId: string;
  /** Canonical semantic repository coordinate, never a host filesystem path. */
  repoPath: string;
  openIntentDigest: string;
  planDigest: string;
  baseEvent: VcsStateNodeRef;
  baseSnapshotRevision: string;
  state:
    | "opening"
    | "launching"
    | "ready"
    | "checkpointing"
    | "stopping"
    | "stopped"
    | "requires-repair";
  process: NativeDevelopmentProcessIdentity | null;
  pendingChanges: "none" | "present" | "unknown";
  pendingCheckpoint: PendingCheckpoint | null;
  lastCheckpoint: NativeDevelopmentCheckpointReceipt | null;
  repair: NativeRepair | null;
  createdAt: number;
  updatedAt: number;
}

interface ActiveTool {
  handle: NativeDevelopmentToolHandle;
  repoPath: string;
}

export class NativeDevelopmentExecutor<TPlan extends NativeDevelopmentSourcePlan> {
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      root: string;
      blobsDir: string;
      executorId: string;
      tools: ReviewedNativeDevelopmentTools;
      semantic: NativeDevelopmentSemanticAdapter;
      planSource(input: { developmentContextId: string; repositoryId: string }): Promise<TPlan>;
      materializeSource(plan: TPlan, destination: string): Promise<void>;
      now?: () => number;
    }
  ) {}

  async describeTool(toolId: NativeDevelopmentToolId): Promise<{
    toolId: NativeDevelopmentToolId;
    executorId: string;
    available: boolean;
    unavailableReason?: NativeDevelopmentExecutorUnavailableError["reason"];
    interactiveTerminal: boolean;
  }> {
    const driver = this.deps.tools.get(toolId);
    const availability = await driver.availability();
    return {
      toolId,
      executorId: driver.executorId,
      available: availability.available,
      ...(availability.available ? {} : { unavailableReason: availability.reason }),
      interactiveTerminal: driver.terminalSurface !== undefined,
    };
  }

  async readTerminal(input: {
    sessionId: string;
    after?: number;
    maxBytes?: number;
  }): Promise<NativeDevelopmentTerminalSnapshot> {
    const marker = await this.requireMarker(input.sessionId);
    const terminalSessionId = marker.process?.terminalSessionId;
    if (!terminalSessionId) {
      throw coded("ETERMINAL_UNAVAILABLE", "Native session has no interactive terminal");
    }
    const driver = this.deps.tools.get(marker.toolId);
    if (!driver.terminalSurface) {
      throw coded("ETERMINAL_UNAVAILABLE", "Native tool driver has no terminal surface");
    }
    return driver.terminalSurface.read({
      terminalSessionId,
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    });
  }

  async writeTerminal(input: { sessionId: string; writeId: string; data: string }): Promise<void> {
    const marker = await this.requireMarker(input.sessionId);
    const terminalSessionId = marker.process?.terminalSessionId;
    if (!terminalSessionId) {
      throw coded("ETERMINAL_UNAVAILABLE", "Native session has no interactive terminal");
    }
    const driver = this.deps.tools.get(marker.toolId);
    if (!driver.terminalSurface) {
      throw coded("ETERMINAL_UNAVAILABLE", "Native tool driver has no terminal surface");
    }
    driver.terminalSurface.write({
      terminalSessionId,
      writeId: input.writeId,
      data: input.data,
    });
  }

  async resizeTerminal(input: { sessionId: string; columns: number; rows: number }): Promise<void> {
    const marker = await this.requireMarker(input.sessionId);
    const terminalSessionId = marker.process?.terminalSessionId;
    if (!terminalSessionId) {
      throw coded("ETERMINAL_UNAVAILABLE", "Native session has no interactive terminal");
    }
    const driver = this.deps.tools.get(marker.toolId);
    if (!driver.terminalSurface) {
      throw coded("ETERMINAL_UNAVAILABLE", "Native tool driver has no terminal surface");
    }
    driver.terminalSurface.resize({
      terminalSessionId,
      columns: input.columns,
      rows: input.rows,
    });
  }

  async open(input: {
    sessionId: string;
    developmentContextId: string;
    repositoryId: string;
    childWorkingHead: VcsStateNodeRef;
    toolId: NativeDevelopmentToolId;
    idempotencyKey: string;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<NativeDevelopmentSessionReceipt> {
    return this.locked(input.sessionId, async () => {
      this.assertOpaqueId(input.sessionId, "session id");
      this.assertOpaqueId(input.idempotencyKey, "idempotency key");
      const existing = await this.readMarker(input.sessionId, false);
      if (existing) {
        this.assertOpenIdentity(existing, input);
        if (existing.state === "ready" && this.activeTools.has(input.sessionId)) {
          return publicReceipt(existing);
        }
        if (existing.state === "stopped" || existing.state === "requires-repair") {
          return publicReceipt(existing);
        }
        return publicReceipt(
          await this.requireRepair(
            existing,
            "open-recovery",
            "Native tool launch outcome cannot be proven after executor interruption"
          )
        );
      }
      const driver = this.deps.tools.get(input.toolId);
      if (driver.executorId !== this.deps.executorId) {
        throw coded("EEXECUTOR_UNAVAILABLE", "Native tool belongs to another executor");
      }
      const availability = await driver.availability();
      if (!availability.available) {
        throw new NativeDevelopmentExecutorUnavailableError(
          driver.toolId,
          driver.executorId,
          availability.reason
        );
      }

      const baseCommandId = stableCommandId("base", input.sessionId, input.idempotencyKey);
      const baseEvent = await this.deps.semantic.commitChildBase({
        developmentContextId: input.developmentContextId,
        expectedWorkingHead: input.childWorkingHead,
        commandId: baseCommandId,
        message: `Development session base ${input.sessionId}`,
        ingress: input.ingress,
      });
      assertEvent(baseEvent, "Native development base");
      const plan = await this.deps.planSource({
        developmentContextId: input.developmentContextId,
        repositoryId: input.repositoryId,
      });
      if (
        plan.contextId !== input.developmentContextId ||
        plan.repositoryId !== input.repositoryId ||
        canonicalJson(plan.sourceState) !== canonicalJson(baseEvent)
      ) {
        throw coded("EIDENTITYDRIFT", "Native materialization plan does not bind the child base");
      }

      const root = await this.claimRoot(input.sessionId);
      const now = this.now();
      let marker: NativeSessionMarker = {
        version: 1,
        sessionId: input.sessionId,
        ownedRootId: nativeDevelopmentOwnedRootId(this.deps.executorId, input.sessionId),
        executorId: this.deps.executorId,
        toolId: input.toolId,
        developmentContextId: input.developmentContextId,
        repositoryId: input.repositoryId,
        repoPath: plan.repoPath,
        openIntentDigest: nativeOpenIntentDigest(input),
        planDigest: plan.planDigest,
        baseEvent,
        baseSnapshotRevision: "",
        state: "opening",
        process: null,
        pendingChanges: "none",
        pendingCheckpoint: null,
        lastCheckpoint: null,
        repair: null,
        createdAt: now,
        updatedAt: now,
      };
      this.writeMarker(root, marker);

      const repositoryRoot = path.join(root, REPOSITORY_DIRECTORY);
      await fs.mkdir(repositoryRoot, { mode: 0o700 });
      await this.deps.materializeSource(plan, repositoryRoot);
      const initial = await scanNativeSnapshot({
        repositoryRoot,
        repositoryId: input.repositoryId,
        repoPath: plan.repoPath,
        sessionId: input.sessionId,
        blobsDir: this.deps.blobsDir,
        persist: false,
      });
      marker = {
        ...marker,
        baseSnapshotRevision: initial.source.snapshotRevision,
        state: "launching",
        updatedAt: this.now(),
      };
      this.writeMarker(root, marker);
      await fs.mkdir(path.join(root, HOME_DIRECTORY), { mode: 0o700 });

      try {
        const handle = await driver.launch({
          sessionId: input.sessionId,
          ownedRootId: marker.ownedRootId,
          repositoryRoot,
          homeRoot: path.join(root, HOME_DIRECTORY),
        });
        assertProcessIdentity(handle.identity);
        marker = {
          ...marker,
          state: "ready",
          process: handle.identity,
          pendingChanges: "unknown",
          updatedAt: this.now(),
        };
        this.writeMarker(root, marker);
        this.activeTools.set(input.sessionId, { handle, repoPath: marker.repoPath });
        return publicReceipt(marker);
      } catch (error) {
        marker = await this.requireRepair(marker, "native-tool-launch", errorMessage(error), [], {
          process: "unknown",
        });
        throw Object.assign(error instanceof Error ? error : new Error(errorMessage(error)), {
          session: publicReceipt(marker),
        });
      }
    });
  }

  async checkpoint(input: {
    sessionId: string;
    idempotencyKey: string;
    ingress: NativeDevelopmentSemanticIngress;
  }): Promise<NativeDevelopmentCheckpointReceipt> {
    return this.locked(input.sessionId, async () => {
      this.assertOpaqueId(input.idempotencyKey, "idempotency key");
      let marker = await this.requireMarker(input.sessionId);
      if (marker.lastCheckpoint?.idempotencyKey === input.idempotencyKey) {
        return marker.lastCheckpoint;
      }
      if (
        marker.pendingCheckpoint &&
        marker.pendingCheckpoint.idempotencyKey !== input.idempotencyKey
      ) {
        throw coded(
          "ECHECKPOINT_PENDING",
          `Checkpoint ${marker.pendingCheckpoint.idempotencyKey} must be retried or repaired first`
        );
      }
      const active = this.requireActiveTool(marker);
      const root = await this.assertOwnedRoot(input.sessionId, marker);
      let frozen = false;
      let pending = marker.pendingCheckpoint;

      try {
        if (!pending || pending.phase === "freezing") {
          pending = {
            idempotencyKey: input.idempotencyKey,
            commandId: stableCommandId("checkpoint", marker.sessionId, input.idempotencyKey),
            phase: "freezing",
            expectedWorkingHead: marker.lastCheckpoint
              ? eventRef(marker.lastCheckpoint.imported.eventId)
              : marker.baseEvent,
          };
          marker = {
            ...marker,
            state: "checkpointing",
            pendingCheckpoint: pending,
            updatedAt: this.now(),
          };
          this.writeMarker(root, marker);
          await active.handle.freezeForCheckpoint();
          frozen = true;
          const descriptor = await scanNativeSnapshot({
            repositoryRoot: path.join(root, REPOSITORY_DIRECTORY),
            repositoryId: marker.repositoryId,
            repoPath: active.repoPath,
            sessionId: marker.sessionId,
            blobsDir: this.deps.blobsDir,
            persist: true,
          });
          this.writeDescriptor(root, descriptor);
          pending = {
            ...pending,
            phase: "prepared",
            snapshotRevision: descriptor.source.snapshotRevision,
            descriptorDigest: descriptor.descriptorDigest,
          };
          marker = { ...marker, pendingCheckpoint: pending, updatedAt: this.now() };
          this.writeMarker(root, marker);
        }

        const descriptor = this.readDescriptor(root, pending);
        if (!frozen) {
          // A prepared retry imports the exact already-frozen descriptor. It
          // deliberately does not rescan a tree that may since have changed.
          await active.handle.freezeForCheckpoint();
          frozen = true;
        }
        let imported = pending.imported;
        let checkpointedAt = pending.checkpointedAt;
        if (!imported) {
          imported = await this.deps.semantic.importSnapshot({
            developmentContextId: marker.developmentContextId,
            repositoryId: marker.repositoryId,
            expectedWorkingHead: pending.expectedWorkingHead,
            commandId: pending.commandId,
            descriptor,
            ingress: input.ingress,
          });
          if (
            imported.contextId !== marker.developmentContextId ||
            !imported.importedRepositoryIds.includes(marker.repositoryId) ||
            imported.externalSnapshot.snapshotRevision !== descriptor.source.snapshotRevision
          ) {
            throw coded("EINTEGRITY", "Semantic import receipt does not match native checkpoint");
          }
          checkpointedAt = this.now();
          pending = {
            ...pending,
            phase: "imported",
            imported,
            checkpointedAt,
          };
          marker = { ...marker, pendingCheckpoint: pending, updatedAt: this.now() };
          this.writeMarker(root, marker);
        }
        await active.handle.resumeCheckpoint();
        frozen = false;
        const receipt: NativeDevelopmentCheckpointReceipt = {
          version: 1,
          sessionId: marker.sessionId,
          idempotencyKey: pending.idempotencyKey,
          commandId: pending.commandId,
          snapshotRevision: descriptor.source.snapshotRevision,
          descriptorDigest: descriptor.descriptorDigest,
          imported,
          checkpointedAt: checkpointedAt ?? this.now(),
        };
        marker = {
          ...marker,
          state: "ready",
          pendingChanges: "unknown",
          pendingCheckpoint: null,
          lastCheckpoint: receipt,
          repair: null,
          updatedAt: this.now(),
        };
        this.writeMarker(root, marker);
        return receipt;
      } catch (error) {
        const cleanupErrors: string[] = [];
        if (frozen) {
          try {
            await active.handle.resumeCheckpoint();
            frozen = false;
          } catch (resumeError) {
            cleanupErrors.push(errorMessage(resumeError));
          }
        }
        if (cleanupErrors.length > 0) {
          await this.requireRepair(
            marker,
            "checkpoint-resume",
            errorMessage(error),
            cleanupErrors,
            { process: "unknown" }
          );
        } else if (marker.pendingCheckpoint?.phase === "freezing") {
          marker = {
            ...marker,
            state: "ready",
            pendingCheckpoint: null,
            pendingChanges: "unknown",
            updatedAt: this.now(),
          };
          this.writeMarker(root, marker);
        }
        throw error;
      }
    });
  }

  async inspect(
    sessionId: string,
    options: { assessPendingChanges?: boolean } = {}
  ): Promise<NativeDevelopmentSessionReceipt> {
    return this.locked(sessionId, async () => {
      let marker = await this.requireMarker(sessionId);
      if (!options.assessPendingChanges || marker.state !== "ready") {
        return publicReceipt(marker);
      }
      const active = this.requireActiveTool(marker);
      const root = await this.assertOwnedRoot(sessionId, marker);
      let frozen = false;
      let primaryError: unknown = null;
      let pendingChanges: NativeSessionMarker["pendingChanges"] = marker.pendingChanges;
      try {
        await active.handle.freezeForCheckpoint();
        frozen = true;
        const descriptor = await scanNativeSnapshot({
          repositoryRoot: path.join(root, REPOSITORY_DIRECTORY),
          repositoryId: marker.repositoryId,
          repoPath: active.repoPath,
          sessionId: marker.sessionId,
          blobsDir: this.deps.blobsDir,
          persist: false,
        });
        const basis = marker.lastCheckpoint?.snapshotRevision ?? marker.baseSnapshotRevision;
        pendingChanges = descriptor.source.snapshotRevision === basis ? "none" : "present";
      } catch (error) {
        primaryError = error;
      }
      if (frozen) {
        try {
          await active.handle.resumeCheckpoint();
        } catch (resumeError) {
          marker = await this.requireRepair(
            marker,
            "pending-change-resume",
            primaryError ? errorMessage(primaryError) : errorMessage(resumeError),
            primaryError ? [errorMessage(resumeError)] : [],
            { process: "unknown" }
          );
          if (primaryError) throw primaryError;
          return publicReceipt(marker);
        }
      }
      if (primaryError) throw primaryError;
      marker = { ...marker, pendingChanges, updatedAt: this.now() };
      this.writeMarker(root, marker);
      return publicReceipt(marker);
    });
  }

  async stop(sessionId: string): Promise<NativeDevelopmentSessionReceipt> {
    return this.locked(sessionId, async () => {
      let marker = await this.requireMarker(sessionId);
      if (marker.state === "stopped") return publicReceipt(marker);
      const active = this.requireActiveTool(marker);
      const root = await this.assertOwnedRoot(sessionId, marker);
      marker = { ...marker, state: "stopping", updatedAt: this.now() };
      this.writeMarker(root, marker);
      try {
        await active.handle.stop();
        marker = {
          ...marker,
          state: "stopped",
          updatedAt: this.now(),
        };
        this.writeMarker(root, marker);
        return publicReceipt(marker);
      } catch (error) {
        return publicReceipt(
          await this.requireRepair(marker, "native-tool-stop", errorMessage(error), [], {
            process: "unknown",
          })
        );
      }
    });
  }

  /**
   * Cold recovery never signals a persisted pid. Without the exact live handle
   * the provider cannot prove process ownership, so it preserves the tree and
   * exposes repair instead of guessing.
   */
  async recover(sessionId: string): Promise<NativeDevelopmentSessionReceipt> {
    return this.locked(sessionId, async () => {
      const marker = await this.requireMarker(sessionId);
      if (marker.state === "stopped" || marker.state === "requires-repair") {
        return publicReceipt(marker);
      }
      if (this.activeTools.has(sessionId) && marker.state === "ready") {
        return publicReceipt(marker);
      }
      return publicReceipt(
        await this.requireRepair(
          marker,
          "cold-recovery",
          "Exact native process ownership is unavailable after restart",
          [],
          { process: marker.process ? "unknown" : "absent" }
        )
      );
    });
  }

  async keep(sessionId: string): Promise<NativeDevelopmentSessionReceipt> {
    return this.locked(sessionId, async () => {
      const marker = await this.requireMarker(sessionId);
      if (!marker.repair) return publicReceipt(marker);
      const root = await this.assertOwnedRoot(sessionId, marker);
      const next = {
        ...marker,
        repair: { ...marker.repair, attention: "kept" as const },
        updatedAt: this.now(),
      };
      this.writeMarker(root, next);
      return publicReceipt(next);
    });
  }

  async forceRetire(sessionId: string): Promise<{
    retired: boolean;
    cleanupErrors: string[];
  }> {
    return this.locked(sessionId, async () => {
      let marker = await this.requireMarker(sessionId);
      const root = await this.assertOwnedRoot(sessionId, marker);
      const cleanupErrors: string[] = [];
      const active = this.activeTools.get(sessionId);
      if (active) {
        if (
          !marker.process ||
          active.handle.identity.ownershipToken !== marker.process.ownershipToken
        ) {
          cleanupErrors.push("Live native tool handle does not match the owner marker");
        } else {
          try {
            await active.handle.stop();
            await active.handle.retire();
            this.activeTools.delete(sessionId);
            marker = { ...marker, process: null, state: "stopped", updatedAt: this.now() };
            this.writeMarker(root, marker);
          } catch (error) {
            cleanupErrors.push(errorMessage(error));
          }
        }
      } else if (marker.process && marker.state !== "stopped") {
        cleanupErrors.push(
          "Persisted native process identity has no exact live handle; tree was preserved"
        );
      }
      if (cleanupErrors.length === 0) {
        for (const ownedName of [REPOSITORY_DIRECTORY, HOME_DIRECTORY, CHECKPOINT_DIRECTORY]) {
          try {
            await fs.rm(path.join(root, ownedName), { recursive: true, force: true });
          } catch (error) {
            cleanupErrors.push(`${ownedName}: ${errorMessage(error)}`);
          }
        }
      }
      if (cleanupErrors.length === 0) {
        const unexpected = (await fs.readdir(root)).filter((name) => name !== MARKER_FILE);
        if (unexpected.length > 0) {
          cleanupErrors.push(
            `Owned root contains unexpected entries: ${unexpected.sort().join(", ")}`
          );
        }
      }
      if (cleanupErrors.length === 0) {
        try {
          await fs.unlink(path.join(root, MARKER_FILE));
          await fs.rmdir(root);
          return { retired: true, cleanupErrors };
        } catch (error) {
          cleanupErrors.push(errorMessage(error));
          // If removal stopped after unlinking the marker, restore the exact
          // durable ownership/repair anchor before reporting failure.
          try {
            await fs.stat(root);
            this.writeMarker(root, marker);
          } catch {
            // A missing root is a completed retirement despite an ambiguous
            // final directory result.
            return { retired: true, cleanupErrors: [] };
          }
        }
      }
      await this.requireRepair(
        marker,
        "force-retire",
        "Owned cleanup was incomplete",
        cleanupErrors,
        { process: marker.process ? "unknown" : "absent" }
      );
      return { retired: false, cleanupErrors };
    });
  }

  private requireActiveTool(marker: NativeSessionMarker): ActiveTool {
    const active = this.activeTools.get(marker.sessionId);
    if (
      !active ||
      !marker.process ||
      active.handle.identity.ownershipToken !== marker.process.ownershipToken
    ) {
      throw coded(
        "EREQUIRES_REPAIR",
        "Exact native process handle is unavailable; inspect or force-retire the session"
      );
    }
    return active;
  }

  private async claimRoot(sessionId: string): Promise<string> {
    await fs.mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const base = await fs.realpath(this.deps.root);
    const root = path.join(base, sessionId);
    assertDescendant(base, root);
    await fs.mkdir(root, { mode: 0o700 });
    return root;
  }

  private async assertOwnedRoot(sessionId: string, expected: NativeSessionMarker): Promise<string> {
    const base = await fs.realpath(this.deps.root);
    const root = path.join(base, sessionId);
    assertDescendant(base, root);
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw coded("EOWNERSHIP", "Native development root is not an owned directory");
    }
    const actual = await this.readMarker(sessionId, true);
    if (
      !actual ||
      actual.sessionId !== expected.sessionId ||
      actual.sessionId !== sessionId ||
      actual.ownedRootId !== expected.ownedRootId ||
      actual.ownedRootId !== nativeDevelopmentOwnedRootId(this.deps.executorId, sessionId) ||
      actual.executorId !== expected.executorId ||
      actual.executorId !== this.deps.executorId ||
      actual.repositoryId !== expected.repositoryId ||
      actual.developmentContextId !== expected.developmentContextId
    ) {
      throw coded("EOWNERSHIP", "Native development root has a foreign owner marker");
    }
    return root;
  }

  private async requireMarker(sessionId: string): Promise<NativeSessionMarker> {
    const marker = await this.readMarker(sessionId, true);
    if (!marker) throw coded("ENOENT", `Unknown native development session ${sessionId}`);
    return marker;
  }

  private async readMarker(
    sessionId: string,
    required: boolean
  ): Promise<NativeSessionMarker | null> {
    this.assertOpaqueId(sessionId, "session id");
    const markerPath = path.join(this.deps.root, sessionId, MARKER_FILE);
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(markerPath, "utf8"));
      return parseMarker(parsed);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private writeMarker(root: string, marker: NativeSessionMarker): void {
    writeFileAtomicSync(path.join(root, MARKER_FILE), `${canonicalJson(marker)}\n`, {
      mode: 0o600,
    });
  }

  private writeDescriptor(root: string, descriptor: NativeSnapshotDescriptor): void {
    writeFileAtomicSync(
      path.join(root, CHECKPOINT_DIRECTORY, `${descriptor.source.snapshotRevision}.json`),
      `${canonicalJson(descriptor)}\n`,
      { mode: 0o600 }
    );
  }

  private readDescriptor(root: string, pending: PendingCheckpoint): NativeSnapshotDescriptor {
    if (!pending.snapshotRevision || !pending.descriptorDigest) {
      throw coded("ECORRUPT", "Prepared checkpoint lacks exact descriptor identity");
    }
    const raw = fsSync.readFileSync(
      path.join(root, CHECKPOINT_DIRECTORY, `${pending.snapshotRevision}.json`),
      "utf8"
    );
    const descriptor = parseDescriptor(JSON.parse(raw));
    if (
      descriptor.source.snapshotRevision !== pending.snapshotRevision ||
      descriptor.descriptorDigest !== pending.descriptorDigest ||
      descriptorDigest(descriptor) !== descriptor.descriptorDigest
    ) {
      throw coded("ECORRUPT", "Stored native checkpoint descriptor failed verification");
    }
    return descriptor;
  }

  private async requireRepair(
    marker: NativeSessionMarker,
    phase: string,
    primaryError: string,
    cleanupErrors: string[] = [],
    knownOverrides: Partial<NativeRepair["knownEffects"]> = {}
  ): Promise<NativeSessionMarker> {
    const root = await this.assertOwnedRoot(marker.sessionId, marker);
    const next: NativeSessionMarker = {
      ...marker,
      state: "requires-repair",
      repair: {
        phase,
        primaryError,
        cleanupErrors,
        attention: "actionable",
        knownEffects: {
          nativeTree: "owned",
          process: marker.process ? "owned" : "absent",
          importedEvent: marker.pendingCheckpoint?.imported
            ? "present"
            : marker.pendingCheckpoint?.phase === "prepared"
              ? "unknown"
              : "absent",
          ...knownOverrides,
        },
      },
      updatedAt: this.now(),
    };
    this.writeMarker(root, next);
    return next;
  }

  private assertOpenIdentity(
    marker: NativeSessionMarker,
    input: {
      developmentContextId: string;
      repositoryId: string;
      toolId: NativeDevelopmentToolId;
      idempotencyKey: string;
    }
  ): void {
    if (
      marker.executorId !== this.deps.executorId ||
      marker.ownedRootId !== nativeDevelopmentOwnedRootId(this.deps.executorId, marker.sessionId) ||
      marker.openIntentDigest !== nativeOpenIntentDigest(input) ||
      marker.developmentContextId !== input.developmentContextId ||
      marker.repositoryId !== input.repositoryId ||
      marker.toolId !== input.toolId
    ) {
      throw coded("EIDEMPOTENCYDRIFT", "Native session id was reused with different intent");
    }
  }

  private assertOpaqueId(value: string, label: string): void {
    if (!SESSION_ID.test(value)) throw coded("EINVAL", `Invalid native development ${label}`);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private locked<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const barrier = current.then(
      () => undefined,
      () => undefined
    );
    this.locks.set(sessionId, barrier);
    void barrier.finally(() => {
      if (this.locks.get(sessionId) === barrier) this.locks.delete(sessionId);
    });
    return current;
  }
}

export async function scanNativeSnapshot(input: {
  repositoryRoot: string;
  repositoryId: string;
  repoPath: string;
  sessionId: string;
  blobsDir: string;
  persist: boolean;
}): Promise<NativeSnapshotDescriptor> {
  const rootStat = await fs.lstat(input.repositoryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw coded("EUNSUPPORTED_NATIVE_ENTRY", "Native repository root is not a directory");
  }
  const observations: Array<{
    path: string;
    mode: number;
    absolutePath: string;
    stat: fsSync.Stats;
  }> = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const directoryBefore = await fs.lstat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw coded(
        "EUNSUPPORTED_NATIVE_ENTRY",
        `Native snapshot directory changed type: ${prefix || "."}`
      );
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const admission = semanticVcsPathAdmission(relativePath);
      if (!admission.admissible) {
        throw coded("EUNSUPPORTED_NATIVE_ENTRY", admission.message);
      }
      const absolutePath = path.join(directory, entry.name);
      const before = await fs.lstat(absolutePath);
      if (before.isSymbolicLink()) {
        throw coded("EUNSUPPORTED_NATIVE_ENTRY", `Native snapshot rejects symlink ${relativePath}`);
      }
      if (before.isDirectory()) {
        if ((before.mode & 0o7000) !== 0) {
          throw coded(
            "EUNSUPPORTED_NATIVE_ENTRY",
            `Native snapshot rejects directory mode ${octal(before.mode)} at ${relativePath}`
          );
        }
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!before.isFile()) {
        throw coded(
          "EUNSUPPORTED_NATIVE_ENTRY",
          `Native snapshot rejects ${entryKind(before)} ${relativePath}`
        );
      }
      if ((before.mode & 0o7000) !== 0) {
        throw coded(
          "EUNSUPPORTED_NATIVE_ENTRY",
          `Native snapshot rejects file mode ${octal(before.mode)} at ${relativePath}`
        );
      }
      const permission = before.mode & 0o777;
      observations.push({
        path: relativePath,
        mode: permission,
        absolutePath,
        stat: before,
      });
    }
    const directoryAfter = await fs.lstat(directory);
    if (!sameDirectoryObservation(directoryBefore, directoryAfter)) {
      throw coded(
        "ENATIVE_TREE_CHANGED",
        `Native directory changed during checkpoint: ${prefix || "."}`
      );
    }
  };
  await walk(input.repositoryRoot, "");
  if (!sameDirectoryObservation(rootStat, await fs.lstat(input.repositoryRoot))) {
    throw coded("ENATIVE_TREE_CHANGED", "Native repository root changed during checkpoint");
  }
  // Content persistence is deliberately a second phase. Unsupported paths,
  // entry types, modes, and directory swaps are all rejected before any
  // checkpoint blob is admitted to CAS.
  const files: NativeSnapshotFile[] = [];
  for (const observation of observations) {
    if (!sameFileObservation(observation.stat, await fs.lstat(observation.absolutePath))) {
      throw coded(
        "ENATIVE_TREE_CHANGED",
        `Native file changed before checkpoint capture: ${observation.path}`
      );
    }
    const contentHash = input.persist
      ? (await putFile(input.blobsDir, observation.absolutePath)).digest
      : await hashFile(observation.absolutePath);
    const after = await fs.lstat(observation.absolutePath);
    if (!sameFileObservation(observation.stat, after)) {
      throw coded(
        "ENATIVE_TREE_CHANGED",
        `Native file changed while capturing checkpoint: ${observation.path}`
      );
    }
    files.push({ path: observation.path, contentHash, mode: observation.mode });
  }
  files.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  const snapshotRevision = domainHash(
    "vibestudio/native-development-snapshot-revision/v1",
    canonicalJson({ repositoryId: input.repositoryId, files })
  );
  const base = {
    version: 1 as const,
    repositoryId: input.repositoryId,
    repoPath: input.repoPath,
    source: {
      kind: "filesystem" as const,
      uri: `vibestudio-development://session/${encodeURIComponent(input.sessionId)}`,
      snapshotRevision,
    },
    files,
  };
  return {
    ...base,
    descriptorDigest: domainHash(
      "vibestudio/native-development-snapshot-descriptor/v1",
      canonicalJson(base)
    ),
  };
}

function descriptorDigest(descriptor: NativeSnapshotDescriptor): string {
  const { descriptorDigest: _digest, ...base } = descriptor;
  return domainHash("vibestudio/native-development-snapshot-descriptor/v1", canonicalJson(base));
}

function parseDescriptor(value: unknown): NativeSnapshotDescriptor {
  if (!value || typeof value !== "object") throw coded("ECORRUPT", "Invalid checkpoint descriptor");
  const descriptor = value as Partial<NativeSnapshotDescriptor>;
  if (
    descriptor.version !== 1 ||
    typeof descriptor.repositoryId !== "string" ||
    typeof descriptor.repoPath !== "string" ||
    typeof descriptor.descriptorDigest !== "string" ||
    !descriptor.source ||
    descriptor.source.kind !== "filesystem" ||
    !Array.isArray(descriptor.files)
  ) {
    throw coded("ECORRUPT", "Invalid checkpoint descriptor");
  }
  let previous = "";
  for (const file of descriptor.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.contentHash !== "string" ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      (previous && compareUtf16CodeUnits(previous, file.path) >= 0)
    ) {
      throw coded("ECORRUPT", "Invalid ordered checkpoint file descriptor");
    }
    previous = file.path;
  }
  return descriptor as NativeSnapshotDescriptor;
}

function parseMarker(value: unknown): NativeSessionMarker {
  if (!value || typeof value !== "object") throw coded("ECORRUPT", "Invalid native session marker");
  const marker = value as Partial<NativeSessionMarker>;
  if (
    marker.version !== 1 ||
    typeof marker.sessionId !== "string" ||
    typeof marker.ownedRootId !== "string" ||
    typeof marker.executorId !== "string" ||
    (marker.toolId !== "claude-code" && marker.toolId !== "system-editor") ||
    typeof marker.developmentContextId !== "string" ||
    typeof marker.repositoryId !== "string" ||
    typeof marker.repoPath !== "string" ||
    marker.repoPath.length === 0 ||
    typeof marker.openIntentDigest !== "string" ||
    typeof marker.planDigest !== "string" ||
    !marker.baseEvent ||
    typeof marker.baseSnapshotRevision !== "string" ||
    ![
      "opening",
      "launching",
      "ready",
      "checkpointing",
      "stopping",
      "stopped",
      "requires-repair",
    ].includes(String(marker.state)) ||
    !["none", "present", "unknown"].includes(String(marker.pendingChanges)) ||
    typeof marker.createdAt !== "number" ||
    typeof marker.updatedAt !== "number"
  ) {
    throw coded("ECORRUPT", "Invalid native session marker");
  }
  if (marker.process) assertProcessIdentity(marker.process);
  return marker as NativeSessionMarker;
}

function publicReceipt(marker: NativeSessionMarker): NativeDevelopmentSessionReceipt {
  return {
    version: 1,
    sessionId: marker.sessionId,
    ownedRootId: marker.ownedRootId,
    executorId: marker.executorId,
    toolId: marker.toolId,
    developmentContextId: marker.developmentContextId,
    repositoryId: marker.repositoryId,
    repoPath: marker.repoPath,
    baseEvent: marker.baseEvent,
    baseSnapshotRevision: marker.baseSnapshotRevision,
    state: marker.state,
    process: marker.process,
    lastCheckpoint: marker.lastCheckpoint,
    pendingChanges: marker.pendingChanges,
    repair: marker.repair,
  };
}

function assertProcessIdentity(value: NativeDevelopmentProcessIdentity): void {
  if (
    !value ||
    typeof value.ownershipToken !== "string" ||
    value.ownershipToken.length === 0 ||
    typeof value.processId !== "string" ||
    value.processId.length === 0 ||
    (value.terminalSessionId !== undefined &&
      (typeof value.terminalSessionId !== "string" || value.terminalSessionId.length === 0))
  ) {
    throw coded("EOWNERSHIP", "Native tool returned an invalid process identity");
  }
}

function assertEvent(ref: VcsStateNodeRef, label: string): void {
  if (ref.kind !== "event") throw coded("ECORRUPT", `${label} is not a committed event`);
}

function eventRef(eventId: string): VcsStateNodeRef {
  return { kind: "event", eventId };
}

function stableCommandId(
  kind: "base" | "checkpoint",
  sessionId: string,
  idempotencyKey: string
): string {
  return `${kind}:${domainHash(
    `vibestudio/native-development-${kind}-command/v1`,
    canonicalJson({ sessionId, idempotencyKey })
  )}`;
}

function nativeOpenIntentDigest(input: {
  developmentContextId: string;
  repositoryId: string;
  toolId: NativeDevelopmentToolId;
  idempotencyKey: string;
}): string {
  return domainHash(
    "vibestudio/native-development-open-intent/v1",
    canonicalJson({
      developmentContextId: input.developmentContextId,
      repositoryId: input.repositoryId,
      toolId: input.toolId,
      idempotencyKey: input.idempotencyKey,
    })
  );
}

export function nativeDevelopmentOwnedRootId(executorId: string, sessionId: string): string {
  return domainHash(
    "vibestudio/native-development-owned-root/v1",
    canonicalJson({ executorId, sessionId })
  );
}

function assertDescendant(base: string, candidate: string): void {
  const relative = path.relative(base, path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw coded("EACCES", "Native development root escaped its executor owner");
  }
}

function sameFileObservation(left: fsSync.Stats, right: fsSync.Stats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink
  );
}

function sameDirectoryObservation(left: fsSync.Stats, right: fsSync.Stats): boolean {
  return (
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function hashFile(filePath: string): Promise<string> {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0)
  );
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function entryKind(stat: fsSync.Stats): string {
  if (stat.isSocket()) return "socket";
  if (stat.isFIFO()) return "fifo";
  if (stat.isCharacterDevice()) return "character device";
  if (stat.isBlockDevice()) return "block device";
  return "unsupported entry";
}

function octal(mode: number): string {
  return `0o${(mode & 0o7777).toString(8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
