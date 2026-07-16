import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@vibestudio/extension";
import {
  HubReadyPayloadSchema,
  type HubPairingInvite,
} from "@vibestudio/service-schemas/hubControl";
import type {
  DevHostProviderLaunchInput,
  DevHostProviderPreparationFailure,
  DevHostProviderPreparationInput,
  DevHostProviderRebuildInput,
  DevLaunchStatus,
} from "@vibestudio/service-schemas/devHost";
import {
  devHostProviderPreparationInputSchema,
  devLaunchStatusSchema,
} from "@vibestudio/service-schemas/devHost";
import type {
  EvalCancelInput,
  EvalEventsInput,
  EvalGetInput,
  EvalRunHandle,
  EvalRunSnapshot,
  EvalStartInput,
  EvalParentAuthorityEnvelope,
  EvalParentApprovalRouteProof,
} from "@vibestudio/service-schemas/eval";
import { domainHash, sha256 } from "@vibestudio/shared/execution/identity";
import { createNativeChildEnvironment } from "@vibestudio/shared/nativeProcessEnvironment";
import type { ApprovalDecision, PendingApproval } from "@vibestudio/shared/approvals";
import { RpcClient } from "@vibestudio/direct-client";
import { WebRtcRpcClient } from "@vibestudio/direct-client/webrtc";
import {
  DevHostLifecycle,
  type DevGeneration,
  type DevGenerationExit,
  type DevHostExecutor,
  type DevLifecycleStore,
} from "./lifecycle.js";

const RECORDS_FILE = "launches.json";
const PREPARATIONS_FILE = "preparations.json";
const READY_TIMEOUT_MS = 120_000;

interface ManagedGeneration extends DevGeneration {
  launchId: string;
  input: BuildInput;
  buildRoot: string;
  children: ChildProcess[];
  root: string;
  readyFile: string;
  client: RpcClient | null;
  running: boolean;
}

interface ManagedClientStartResult {
  child: ChildProcess;
  readyFile: string;
  ready: NonNullable<DevLaunchStatus["clientReadinessIdentity"]>;
}

type BuildInput = DevHostProviderLaunchInput | DevHostProviderRebuildInput;
type CustodyInput = DevHostProviderPreparationInput["request"] | BuildInput;

interface RetainedCandidate {
  version: 1;
  launchId: string;
  hostBuildId: string;
  buildRoot: string;
  input: BuildInput;
}

interface RetainedHandoffJournal {
  version: 1;
  phase: "quiescing" | "quiesced" | "backed-up" | "candidate-running";
  launchId: string;
  oldHostBuildId: string;
  candidateHostBuildId: string;
  oldBuildRoot: string;
  oldInput: BuildInput;
  oldProcessIdentity: string;
  candidateProcessIdentity: string | null;
  dataRoot: string;
  backupRoot: string;
  backupDigest: string | null;
}

interface RetainedHandoffState {
  journal: RetainedHandoffJournal;
  previous: ManagedGeneration;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isEvalRunChallenge(
  entry: PendingApproval,
  runId: string
): entry is Extract<PendingApproval, { kind: "capability" }> {
  return entry.kind === "capability" && entry.operation?.groupKey?.startsWith(`${runId}:`) === true;
}

function storage(ctx: ExtensionContext): DevLifecycleStore {
  return {
    async load() {
      try {
        const bytes = await ctx.storage.readFile(RECORDS_FILE, "utf8");
        return devLaunchStatusSchema
          .array()
          .parse(JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error(
          `Development launch journal is incompatible; remove only derived dev-host state (${RECORDS_FILE}) before restart`,
          { cause: error }
        );
      }
    },
    save(records) {
      return ctx.storage.writeFile(RECORDS_FILE, JSON.stringify(records, null, 2));
    },
    async loadPreparations() {
      try {
        const bytes = await ctx.storage.readFile(PREPARATIONS_FILE, "utf8");
        return devHostProviderPreparationInputSchema
          .array()
          .parse(JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new Error(
          `Development preparation journal is incompatible; remove only derived dev-host state (${PREPARATIONS_FILE}) before restart`,
          { cause: error }
        );
      }
    },
    savePreparations(preparations) {
      return ctx.storage.writeFile(PREPARATIONS_FILE, JSON.stringify(preparations, null, 2));
    },
  };
}

export class NativeDevHostExecutor implements DevHostExecutor {
  private readonly builds = new Map<string, { root: string; hostBuildId: string }>();
  /** Active and candidate processes coexist until lifecycle promotion. */
  private readonly generations = new Map<string, ManagedGeneration>();
  private readonly logsByLaunch = new Map<
    string,
    Array<{ seq: number; at: number; level: string; message: string }>
  >();
  private readonly retainedHandoffs = new Map<string, RetainedHandoffState>();
  private readonly restoredGenerations = new Map<string, ManagedGeneration>();
  private readonly childApprovalBridges = new Map<string, Promise<void>>();
  private readonly activeChildChallenges = new Map<
    string,
    {
      generation: DevGeneration;
      runId: string;
      challengeId: string;
      authority: EvalParentAuthorityEnvelope;
    }
  >();
  private readonly unexpectedExitListeners = new Set<(exit: DevGenerationExit) => void>();
  private readonly logListeners = new Set<
    (launchId: string, entry: { seq: number; at: number; level: string; message: string }) => void
  >();

  constructor(private readonly ctx: ExtensionContext) {}

  onUnexpectedExit(listener: (exit: DevGenerationExit) => void): () => void {
    this.unexpectedExitListeners.add(listener);
    return () => this.unexpectedExitListeners.delete(listener);
  }

  onLog(
    listener: (
      launchId: string,
      entry: { seq: number; at: number; level: string; message: string }
    ) => void
  ): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  async build(input: BuildInput): Promise<{ hostBuildId: string }> {
    const manifest = JSON.parse(await fs.readFile(input.snapshot.manifestPath, "utf8")) as {
      snapshotId?: unknown;
      executionInputHash?: unknown;
      recipeDigest?: unknown;
    };
    if (
      manifest.snapshotId !== input.snapshot.snapshotId ||
      manifest.executionInputHash !== input.snapshot.executionInputHash ||
      manifest.recipeDigest !== input.snapshot.recipeDigest
    ) {
      throw Object.assign(new Error("Execution snapshot identity does not match provider grant"), {
        code: "SNAPSHOT_IDENTITY_MISMATCH",
      });
    }
    if (
      !input.executionGrant.resource.endsWith(`/execution:${input.snapshot.executionInputHash}`)
    ) {
      throw Object.assign(new Error("Execution grant is not bound to this snapshot"), {
        code: "EXECUTION_GRANT_MISMATCH",
      });
    }

    const root = path.join(input.snapshot.scratchRoot, "worktree");
    await fs.rm(root, { recursive: true, force: true });
    await fs.cp(input.snapshot.sourceRoot, root, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await makeWritable(root);

    const pnpmPath = process.env["VIBESTUDIO_PNPM_PATH"];
    if (!pnpmPath || !path.isAbsolute(pnpmPath)) {
      throw Object.assign(
        new Error("The host toolchain did not publish an exact pnpm executable"),
        {
          code: "TOOLCHAIN_INCOMPLETE",
        }
      );
    }
    const environment = createNativeChildEnvironment({
      purpose: "build",
      declared: { CI: "1", NODE_ENV: "production" },
    });
    await this.run(input.launchId, pnpmPath, ["bootstrap:frozen"], root, environment.env);
    await this.run(input.launchId, pnpmPath, ["build"], root, environment.env);

    const required = ["dist/server.mjs", "dist/main.cjs", "dist/cli/client.mjs"];
    const artifacts: Array<{ path: string; digest: string }> = [];
    for (const relative of required) {
      const bytes = await fs.readFile(path.join(root, relative)).catch(() => null);
      if (!bytes) {
        throw Object.assign(new Error(`Build did not emit required role artifact ${relative}`), {
          code: "ARTIFACT_ROLE_MISSING",
        });
      }
      artifacts.push({ path: relative, digest: sha256(bytes) });
    }
    const hostBuildId = domainHash(
      "vibestudio/dev-host-build/v1",
      input.snapshot.executionInputHash,
      JSON.stringify(artifacts)
    );
    this.builds.set(input.launchId, { root, hostBuildId });
    return { hostBuildId };
  }

  async validate(input: BuildInput, hostBuildId: string): Promise<void> {
    const build = this.builds.get(input.launchId);
    if (!build || build.hostBuildId !== hostBuildId) {
      throw Object.assign(new Error("Candidate artifact is not the validated build result"), {
        code: "ARTIFACT_IDENTITY_MISMATCH",
      });
    }
    await fs.access(path.join(build.root, "dist", "server.mjs"));
  }

  async start(input: BuildInput, hostBuildId: string): Promise<DevGeneration> {
    const handoff = await this.beginRetainedHandoff(input, hostBuildId);
    try {
      const generation = await this.startPrepared(input, hostBuildId);
      if (handoff) {
        handoff.journal.phase = "candidate-running";
        handoff.journal.candidateProcessIdentity = generation.processIdentity;
        await this.writeRetainedHandoff(handoff.journal);
      }
      return generation;
    } catch (error) {
      if (handoff) {
        const restored = await this.restoreRetainedHandoff(handoff, null);
        this.restoredGenerations.set(input.launchId, restored);
      }
      throw error;
    }
  }

  private async startPrepared(input: BuildInput, hostBuildId: string): Promise<ManagedGeneration> {
    const build = this.builds.get(input.launchId);
    if (!build || build.hostBuildId !== hostBuildId) {
      throw Object.assign(new Error("Cannot start an unknown candidate build"), {
        code: "ENOARTIFACT",
      });
    }
    const generationRoot = path.join(input.snapshot.scratchRoot, `generation-${hostBuildId}`);
    if (input.target.kind === "current-host-client") {
      if (!input.currentHostPairing) {
        throw Object.assign(new Error("Current-host client has no host-minted pairing invite"), {
          code: "PAIRING_INVITE_REQUIRED",
        });
      }
      const managed = await this.startManagedClient({
        input,
        hostBuildId,
        buildRoot: build.root,
        generationRoot,
        invite: input.currentHostPairing.invite,
        expectedHost: input.currentHostPairing.expectedHost,
      });
      const generation: ManagedGeneration = {
        launchId: input.launchId,
        input,
        buildRoot: build.root,
        hostBuildId,
        readinessIdentity: {
          launchId: input.launchId,
          hostBuildId,
          serverId: managed.ready.serverId,
          endpoint: `webrtc://${input.currentHostPairing.invite.room}`,
          evalAuthorityRecipientKey: null,
        },
        childWorkspaceId: managed.ready.workspaceId,
        childContextId: input.owner.contextId,
        clientReadinessIdentity: managed.ready,
        processIdentity: `${managed.child.pid}:${managed.ready.profileId}`,
        children: [managed.child],
        root: generationRoot,
        readyFile: managed.readyFile,
        client: null,
        running: true,
      };
      this.generations.set(generation.processIdentity, generation);
      this.superviseGeneration(generation);
      return generation;
    }

    const configRoot =
      input.target.persistence === "retained"
        ? this.retainedDataRoot(input.launchId)
        : path.join(generationRoot, "config");
    const readyFile = path.join(generationRoot, "ready.json");
    await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
    await fs.rm(readyFile, { force: true });
    const runtime = toolchainRuntime();
    const environment = createNativeChildEnvironment({
      purpose: "child-hub",
      declared: {
        HOME: configRoot,
        XDG_CONFIG_HOME: configRoot,
        NODE_ENV: "production",
        VIBESTUDIO_APP_ROOT: build.root,
        VIBESTUDIO_MANAGED_DEV_LAUNCH_ID: input.launchId,
        VIBESTUDIO_MANAGED_DEV_BUILD_ID: hostBuildId,
        VIBESTUDIO_MANAGED_DEV_PARENT_HOST_ID: input.evalAuthorityBridge.parentHostId,
        VIBESTUDIO_MANAGED_DEV_PARENT_AUTHORITY_KEY: input.evalAuthorityBridge.publicKeySpki,
        ...(process.env["VIBESTUDIO_TOOLCHAIN_RUNTIME_NODE_MODE"] === "1"
          ? { ELECTRON_RUN_AS_NODE: "1" }
          : {}),
      },
    });
    const args = [
      path.join(build.root, "dist", "server.mjs"),
      "--app-root",
      build.root,
      "--ready-file",
      readyFile,
      "--host",
      "127.0.0.1",
      "--bind-host",
      "127.0.0.1",
      "--bootstrap-workspace",
      "vibestudio-dev",
    ];
    if (input.target.persistence === "ephemeral") args.push("--ephemeral");
    const child = spawn(runtime, args, {
      cwd: build.root,
      env: environment.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    if (child.pid !== undefined) {
      await this.recordRetainedCandidateProcess(input, hostBuildId, child.pid);
    }
    this.capture(input.launchId, "stdout", child.stdout);
    this.capture(input.launchId, "stderr", child.stderr);
    const ready = await waitForReadyFile(readyFile, child);
    if (child.pid === undefined || ready.pid !== child.pid) {
      await stopChild(child);
      throw Object.assign(new Error("Child ready PID did not match the supervised process"), {
        code: "READY_IDENTITY_MISMATCH",
      });
    }
    const client = await pairChild(ready.rootInvites?.desktop ?? null, ready.serverId).catch(
      async (error) => {
        await stopChild(child);
        throw error;
      }
    );
    let managedClient: ManagedClientStartResult | null = null;
    if (input.target.client === "electron") {
      try {
        const paired = await client.call<{ pairing: HubPairingInvite }>("hubControl.pairDevice", [
          {},
        ]);
        managedClient = await this.startManagedClient({
          input,
          hostBuildId,
          buildRoot: build.root,
          generationRoot,
          invite: paired.pairing,
          expectedHost: {
            serverId: ready.serverId,
            workspaceId: ready.workspaces[0]?.workspaceId ?? "",
          },
        });
      } catch (error) {
        await client.close().catch(() => undefined);
        await stopChild(child);
        throw error;
      }
    }
    const generation: ManagedGeneration = {
      launchId: input.launchId,
      input,
      buildRoot: build.root,
      hostBuildId,
      readinessIdentity: {
        launchId: input.launchId,
        hostBuildId,
        serverId: ready.serverId,
        endpoint: ready.gatewayUrl,
        evalAuthorityRecipientKey: ready.evalAuthorityRecipientKey ?? null,
      },
      childWorkspaceId: ready.workspaces[0]?.workspaceId ?? null,
      childContextId: null,
      clientReadinessIdentity: managedClient?.ready ?? null,
      processIdentity: `${child.pid}:${ready.serverBootId}`,
      children: managedClient ? [child, managedClient.child] : [child],
      root: generationRoot,
      readyFile,
      client,
      running: true,
    };
    this.generations.set(generation.processIdentity, generation);
    this.superviseGeneration(generation);
    if (input.target.persistence === "retained") {
      try {
        await this.persistRetainedCandidate({
          version: 1,
          launchId: input.launchId,
          hostBuildId,
          buildRoot: build.root,
          input,
        });
      } catch (error) {
        await this.stop(generation).catch(() => undefined);
        throw error;
      }
    }
    return generation;
  }

  async stop(generation: DevGeneration): Promise<void> {
    const managed = this.generations.get(generation.processIdentity);
    if (!managed) return;
    await this.quiesce(managed);
    await this.cleanupGeneration(managed, false);
  }

  async restart(generation: DevGeneration): Promise<DevGeneration> {
    const managed = this.generations.get(generation.processIdentity);
    if (!managed) {
      throw Object.assign(new Error("Cannot restart an unknown managed generation"), {
        code: "ENOENT",
      });
    }
    await this.stopManagedChildren(managed);
    const restarted = await this.startPrepared(managed.input, managed.hostBuildId);
    this.generations.delete(managed.processIdentity);
    return restarted;
  }

  private async quiesce(managed: ManagedGeneration): Promise<void> {
    if (!managed.running) return;
    managed.running = false;
    await this.stopManagedChildren(managed);
  }

  private async stopManagedChildren(managed: ManagedGeneration): Promise<void> {
    await this.cancelParentChallenges(managed);
    await managed.client?.close().catch(() => undefined);
    for (const child of [...managed.children].reverse()) await stopChild(child);
  }

  private async cancelParentChallenges(managed: ManagedGeneration): Promise<void> {
    const challenges = [...this.activeChildChallenges.entries()].filter(
      ([, challenge]) => challenge.generation.processIdentity === managed.processIdentity
    );
    await Promise.allSettled(
      challenges.map(async ([key, challenge]) => {
        try {
          await this.ctx.rpc.call("main", "devHost.eval.cancelChildChallenge", {
            launchId: challenge.generation.readinessIdentity.launchId,
            hostBuildId: challenge.generation.hostBuildId,
            processIdentity: challenge.generation.processIdentity,
            runId: challenge.runId,
            challengeId: challenge.challengeId,
            authority: challenge.authority,
          });
        } finally {
          this.activeChildChallenges.delete(key);
        }
      })
    );
  }

  private superviseGeneration(managed: ManagedGeneration): void {
    let reported = false;
    for (const child of managed.children) {
      child.once("exit", (code, signal) => {
        if (!managed.running || reported) return;
        reported = true;
        managed.running = false;
        void this.stopManagedChildren(managed).finally(() => {
          const exit: DevGenerationExit = {
            launchId: managed.launchId,
            hostBuildId: managed.hostBuildId,
            processIdentity: managed.processIdentity,
            code,
            signal,
          };
          for (const listener of this.unexpectedExitListeners) listener(exit);
        });
      });
    }
  }

  private async cleanupGeneration(
    managed: ManagedGeneration,
    preserveRetainedData: boolean
  ): Promise<void> {
    this.generations.delete(managed.processIdentity);
    const build = this.builds.get(managed.launchId);
    if (build?.hostBuildId === managed.hostBuildId) this.builds.delete(managed.launchId);
    if (
      managed.input.target.kind === "isolated-host" &&
      managed.input.target.persistence === "retained"
    ) {
      await fs
        .rm(this.retainedCandidateFile(managed.launchId, managed.hostBuildId), { force: true })
        .catch(() => undefined);
      const anotherGeneration = [...this.generations.values()].some(
        (candidate) => candidate.launchId === managed.launchId
      );
      if (!preserveRetainedData && !anotherGeneration) {
        await fs.rm(this.retainedDataRoot(managed.launchId), { recursive: true, force: true });
      }
    }
    await releaseOwnedSnapshot(managed.input);
  }

  async rollbackCandidate(
    candidate: DevGeneration | null,
    previous: DevGeneration
  ): Promise<DevGeneration> {
    const restored = this.restoredGenerations.get(previous.readinessIdentity.launchId);
    if (restored) {
      this.restoredGenerations.delete(previous.readinessIdentity.launchId);
      return restored;
    }
    const handoff = this.retainedHandoffs.get(previous.readinessIdentity.launchId);
    if (handoff) {
      const managedCandidate = candidate
        ? (this.generations.get(candidate.processIdentity) ?? null)
        : null;
      return this.restoreRetainedHandoff(handoff, managedCandidate);
    }
    if (candidate && candidate.processIdentity !== previous.processIdentity) {
      await this.stop(candidate);
    }
    return previous;
  }

  async commitPromotion(candidate: DevGeneration, _previous: DevGeneration): Promise<void> {
    const launchId = candidate.readinessIdentity.launchId;
    const handoff = this.retainedHandoffs.get(launchId);
    if (!handoff) return;
    await this.removeRetainedHandoff(handoff.journal);
    this.retainedHandoffs.delete(launchId);
  }

  private retainedDataRoot(launchId: string): string {
    return this.ctx.storage.resolvePath(path.join("retained-data", sha256(launchId)));
  }

  private retainedHandoffRoot(launchId: string): string {
    return this.ctx.storage.resolvePath(path.join("retained-handoffs", sha256(launchId)));
  }

  private async beginRetainedHandoff(
    input: BuildInput,
    candidateHostBuildId: string
  ): Promise<RetainedHandoffState | null> {
    if (input.target.kind !== "isolated-host" || input.target.persistence !== "retained") {
      return null;
    }
    const previous = [...this.generations.values()].find(
      (generation) =>
        generation.launchId === input.launchId && generation.hostBuildId !== candidateHostBuildId
    );
    if (!previous) return null;
    if (
      previous.input.target.kind !== "isolated-host" ||
      previous.input.target.persistence !== "retained"
    ) {
      throw Object.assign(new Error("Retained candidate cannot replace an ephemeral generation"), {
        code: "PERSISTENCE_MODE_MISMATCH",
      });
    }

    const handoffRoot = this.retainedHandoffRoot(input.launchId);
    const dataRoot = this.retainedDataRoot(input.launchId);
    const backupRoot = path.join(handoffRoot, "data-backup");
    const journal: RetainedHandoffJournal = {
      version: 1,
      phase: "quiescing",
      launchId: input.launchId,
      oldHostBuildId: previous.hostBuildId,
      candidateHostBuildId,
      oldBuildRoot: previous.buildRoot,
      oldInput: previous.input,
      oldProcessIdentity: previous.processIdentity,
      candidateProcessIdentity: null,
      dataRoot,
      backupRoot,
      backupDigest: null,
    };
    const state = { journal, previous } satisfies RetainedHandoffState;
    this.retainedHandoffs.set(input.launchId, state);
    try {
      await this.writeRetainedHandoff(journal);
      await this.quiesce(previous);
      journal.phase = "quiesced";
      await this.writeRetainedHandoff(journal);
      await fs.rm(backupRoot, { recursive: true, force: true });
      if (await pathExists(dataRoot)) {
        await fs.cp(dataRoot, backupRoot, { recursive: true, force: false, errorOnExist: true });
      } else {
        await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
        await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
      }
      journal.backupDigest = await directoryDigest(backupRoot);
      journal.phase = "backed-up";
      await this.writeRetainedHandoff(journal);
      return state;
    } catch (error) {
      if (!previous.running) {
        this.generations.delete(previous.processIdentity);
        this.builds.set(previous.launchId, {
          root: previous.buildRoot,
          hostBuildId: previous.hostBuildId,
        });
        const restored = await this.startPrepared(previous.input, previous.hostBuildId);
        this.restoredGenerations.set(previous.launchId, restored);
      }
      await this.removeRetainedHandoff(journal).catch(() => undefined);
      this.retainedHandoffs.delete(input.launchId);
      throw error;
    }
  }

  private async restoreRetainedHandoff(
    handoff: RetainedHandoffState,
    candidate: ManagedGeneration | null
  ): Promise<ManagedGeneration> {
    if (candidate) {
      await this.quiesce(candidate);
      await this.cleanupGeneration(candidate, true);
    }
    const { journal, previous } = handoff;
    if (journal.backupDigest) {
      const observedBackup = await directoryDigest(journal.backupRoot);
      if (observedBackup !== journal.backupDigest) {
        throw Object.assign(new Error("Retained rollback data failed integrity verification"), {
          code: "RETAINED_ROLLBACK_INTEGRITY",
        });
      }
      await fs.rm(journal.dataRoot, { recursive: true, force: true });
      await fs.cp(journal.backupRoot, journal.dataRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      if ((await directoryDigest(journal.dataRoot)) !== journal.backupDigest) {
        throw Object.assign(new Error("Restored retained data failed integrity verification"), {
          code: "RETAINED_ROLLBACK_INTEGRITY",
        });
      }
    }
    this.generations.delete(previous.processIdentity);
    this.builds.set(previous.launchId, {
      root: previous.buildRoot,
      hostBuildId: previous.hostBuildId,
    });
    const restored = await this.startPrepared(previous.input, previous.hostBuildId);
    await this.removeRetainedHandoff(journal);
    this.retainedHandoffs.delete(previous.launchId);
    return restored;
  }

  private async writeRetainedHandoff(journal: RetainedHandoffJournal): Promise<void> {
    const root = this.retainedHandoffRoot(journal.launchId);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "journal.json");
    const temp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
  }

  private async removeRetainedHandoff(journal: RetainedHandoffJournal): Promise<void> {
    await fs.rm(this.retainedHandoffRoot(journal.launchId), { recursive: true, force: true });
  }

  async discard(input: CustodyInput, hostBuildId?: string): Promise<void> {
    const build = this.builds.get(input.launchId);
    if (
      build &&
      (!hostBuildId || build.hostBuildId === hostBuildId) &&
      isPathWithin(input.snapshot.scratchRoot, build.root)
    ) {
      this.builds.delete(input.launchId);
    }
    await releaseOwnedSnapshot(input);
  }

  private activeEvalClient(generation: DevGeneration): RpcClient {
    const managed = this.generations.get(generation.processIdentity);
    if (!managed?.client) {
      throw Object.assign(new Error("Verified child connection is not active"), {
        code: "ENOTREADY",
      });
    }
    return managed.client;
  }

  async evalStart(
    generation: DevGeneration,
    input: EvalStartInput,
    authority: EvalParentAuthorityEnvelope
  ): Promise<EvalRunHandle> {
    const client = this.activeEvalClient(generation);
    const approvalRoute =
      input.authority?.approvals === "pregranted-only"
        ? undefined
        : (
            await this.ctx.rpc.call<{ proof: EvalParentApprovalRouteProof }>(
              "main",
              "devHost.eval.confirmChildRoute",
              {
                launchId: generation.readinessIdentity.launchId,
                hostBuildId: generation.hostBuildId,
                processIdentity: generation.processIdentity,
                authority,
              }
            )
          ).proof;
    return client
      .call<EvalRunHandle>("eval.delegatedStart", [
        { input, authority, ...(approvalRoute ? { approvalRoute } : {}) },
      ])
      .then((handle) => {
        const key = `${generation.processIdentity}\0${handle.runId}`;
        const bridge = this.bridgeChildApprovals(generation, input, authority, handle)
          .catch(async (error) => {
            this.appendLog(
              generation.readinessIdentity.launchId,
              "error",
              `Child eval approval bridge stopped: ${safeError(error)}`
            );
            await this.evalCancel(generation, { runId: handle.runId }).catch(() => undefined);
          })
          .finally(async () => {
            await this.ctx.rpc
              .call("main", "devHost.eval.completeChildRun", {
                launchId: generation.readinessIdentity.launchId,
                hostBuildId: generation.hostBuildId,
                processIdentity: generation.processIdentity,
                runId: handle.runId,
                authority,
              })
              .catch(() => undefined);
            this.childApprovalBridges.delete(key);
          });
        this.childApprovalBridges.set(key, bridge);
        return handle;
      });
  }

  private async bridgeChildApprovals(
    generation: DevGeneration,
    start: EvalStartInput,
    authority: EvalParentAuthorityEnvelope,
    handle: EvalRunHandle
  ): Promise<void> {
    const client = this.activeEvalClient(generation);
    const resolved = new Set<string>();
    const route = {
      target: start.target,
      scope: start.scope ? { key: start.scope.key } : undefined,
    };
    while (true) {
      const managed = this.generations.get(generation.processIdentity);
      if (!managed?.running || managed.client !== client) return;
      const pending = await client.call<PendingApproval[]>("shellApproval.listPending", []);
      const challenges = pending.filter(
        (entry): entry is Extract<PendingApproval, { kind: "capability" }> =>
          isEvalRunChallenge(entry, handle.runId) && !resolved.has(entry.approvalId)
      );
      for (const challenge of challenges) {
        if (!challenge.resource) {
          await client.call("shellApproval.resolve", [challenge.approvalId, "dismiss"]);
          throw new Error("Child supplied a capability challenge without a canonical resource");
        }
        const allowed = challenge.allowedDecisions ?? ["once", "run", "deny", "dismiss"];
        const challengeKey = `${generation.processIdentity}\0${handle.runId}\0${challenge.approvalId}`;
        this.activeChildChallenges.set(challengeKey, {
          generation,
          runId: handle.runId,
          challengeId: challenge.approvalId,
          authority,
        });
        let result: { decision: ApprovalDecision };
        try {
          result = await this.ctx.rpc.call<{ decision: ApprovalDecision }>(
            "main",
            "devHost.eval.resolveChildChallenge",
            {
              launchId: generation.readinessIdentity.launchId,
              hostBuildId: generation.hostBuildId,
              processIdentity: generation.processIdentity,
              runId: handle.runId,
              challengeId: challenge.approvalId,
              capability: challenge.capability,
              resource: {
                ...challenge.resource,
                key: challenge.grantResourceKey ?? challenge.resource.value,
              },
              allowedDecisions: allowed,
              authority,
            }
          );
        } finally {
          this.activeChildChallenges.delete(challengeKey);
        }
        if (!allowed.includes(result.decision)) {
          await client.call("shellApproval.resolve", [challenge.approvalId, "dismiss"]);
          throw new Error("Parent returned a decision the child challenge did not offer");
        }
        await client.call("shellApproval.resolve", [challenge.approvalId, result.decision]);
        resolved.add(challenge.approvalId);
      }
      const snapshot = await client.call<EvalRunSnapshot>("eval.get", [
        { runId: handle.runId, ...route },
      ]);
      if (
        snapshot.status === "succeeded" ||
        snapshot.status === "failed" ||
        snapshot.status === "cancelled" ||
        snapshot.status === "expired" ||
        snapshot.status === "interrupted"
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }

  evalGet(generation: DevGeneration, input: EvalGetInput): Promise<EvalRunSnapshot> {
    return this.activeEvalClient(generation).call("eval.get", [input]);
  }

  evalEvents(
    generation: DevGeneration,
    input: EvalEventsInput
  ): Promise<{ events: unknown[]; next: number }> {
    return this.activeEvalClient(generation).call("eval.events", [input]);
  }

  evalCancel(
    generation: DevGeneration,
    input: EvalCancelInput
  ): Promise<{ status: "requested" | "cancelled" | "terminal" }> {
    return this.activeEvalClient(generation).call("eval.cancel", [input]);
  }

  logs(
    launchId: string,
    after: number
  ): Array<{ seq: number; at: number; level: string; message: string }> {
    return (this.logsByLaunch.get(launchId) ?? []).filter((entry) => entry.seq > after);
  }

  appendLog(launchId: string, level: string, rawMessage: string): void {
    const entries = this.logsByLaunch.get(launchId) ?? [];
    const message = redactDevHostLog(rawMessage);
    if (!message) return;
    const entry = {
      seq: (entries.at(-1)?.seq ?? 0) + 1,
      at: Date.now(),
      level,
      message,
    };
    entries.push(entry);
    if (entries.length > 10_000) entries.splice(0, entries.length - 10_000);
    this.logsByLaunch.set(launchId, entries);
    for (const listener of this.logListeners) listener(launchId, entry);
  }

  async reconcilePersisted(
    record: DevLaunchStatus
  ): Promise<
    | { status: "recovered"; generation: DevGeneration }
    | { status: "not-running" | "terminated" | "unverifiable" }
  > {
    const handoffRecovery = await this.recoverInterruptedHandoff(record);
    if (handoffRecovery) return handoffRecovery;
    const pid = Number.parseInt(record.processIdentity?.split(":", 1)[0] ?? "", 10);
    const alive = Number.isInteger(pid) && pid > 0 && processIsAlive(pid);
    let verified = false;
    if (alive && record.target.kind === "isolated-host" && record.readinessIdentity) {
      try {
        const response = await fetch(new URL("/healthz", record.readinessIdentity.endpoint), {
          signal: AbortSignal.timeout(2_000),
        });
        const health = (await response.json()) as { pid?: unknown; serverId?: unknown };
        verified =
          response.ok &&
          health.pid === pid &&
          health.serverId === record.readinessIdentity.serverId;
      } catch {
        verified = false;
      }
    } else if (alive && process.platform === "linux") {
      try {
        const environment = await fs.readFile(`/proc/${pid}/environ`);
        const entries = environment.toString("utf8").split("\0");
        verified =
          entries.includes(`VIBESTUDIO_MANAGED_DEV_LAUNCH_ID=${record.launchId}`) &&
          entries.includes(
            `VIBESTUDIO_MANAGED_DEV_CLIENT_BUILD_ID=${record.activeHostBuildId ?? ""}`
          );
      } catch {
        verified = false;
      }
    }
    if (alive && !verified) return { status: "unverifiable" };
    if (alive) {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else process.kill(pid, "SIGTERM");
        await waitForPidExit(pid, 5_000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }

    if (
      record.target.kind === "isolated-host" &&
      record.target.persistence === "retained" &&
      record.activeHostBuildId
    ) {
      try {
        const retained = await this.readRetainedCandidate(
          record.launchId,
          record.activeHostBuildId
        );
        if (
          retained.launchId !== record.launchId ||
          retained.hostBuildId !== record.activeHostBuildId ||
          retained.input.snapshot.executionInputHash !== record.executionInputHash ||
          retained.input.sourceStateHash !== record.sourceStateHash ||
          retained.input.target.kind !== "isolated-host" ||
          retained.input.target.persistence !== "retained"
        ) {
          throw Object.assign(
            new Error("Retained generation identity does not match launch record"),
            {
              code: "RETAINED_IDENTITY_MISMATCH",
            }
          );
        }
        this.builds.set(record.launchId, {
          root: retained.buildRoot,
          hostBuildId: retained.hostBuildId,
        });
        await this.validate(retained.input, retained.hostBuildId);
        const generation = await this.start(retained.input, retained.hostBuildId);
        return { status: "recovered", generation };
      } catch (error) {
        this.ctx.log.error(`[dev-host:${record.launchId}:recovery] ${safeError(error)}`);
        return { status: alive ? "terminated" : "not-running" };
      }
    }
    return { status: alive ? "terminated" : "not-running" };
  }

  private retainedCandidateFile(launchId: string, hostBuildId: string): string {
    return this.ctx.storage.resolvePath(
      path.join("retained", sha256(launchId), `${hostBuildId}.json`)
    );
  }

  private async recordRetainedCandidateProcess(
    input: BuildInput,
    hostBuildId: string,
    pid: number
  ): Promise<void> {
    const handoff = this.retainedHandoffs.get(input.launchId);
    if (!handoff || handoff.journal.candidateHostBuildId !== hostBuildId) return;
    handoff.journal.candidateProcessIdentity = `${pid}:starting`;
    await this.writeRetainedHandoff(handoff.journal);
  }

  private async recoverInterruptedHandoff(
    record: DevLaunchStatus
  ): Promise<
    { status: "recovered"; generation: DevGeneration } | { status: "unverifiable" } | null
  > {
    const file = path.join(this.retainedHandoffRoot(record.launchId), "journal.json");
    let journal: RetainedHandoffJournal;
    try {
      journal = JSON.parse(await fs.readFile(file, "utf8")) as RetainedHandoffJournal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const expectedDataRoot = this.retainedDataRoot(record.launchId);
    const expectedBackupRoot = path.join(this.retainedHandoffRoot(record.launchId), "data-backup");
    const oldSelected = record.activeHostBuildId === journal.oldHostBuildId;
    const candidateSelected = record.activeHostBuildId === journal.candidateHostBuildId;
    if (
      journal.version !== 1 ||
      journal.launchId !== record.launchId ||
      (!oldSelected && !candidateSelected) ||
      journal.dataRoot !== expectedDataRoot ||
      journal.backupRoot !== expectedBackupRoot ||
      journal.oldInput.launchId !== record.launchId ||
      (oldSelected &&
        (journal.oldInput.snapshot.executionInputHash !== record.executionInputHash ||
          journal.oldInput.snapshot.recipeDigest !== record.recipeDigest)) ||
      (candidateSelected && journal.phase !== "candidate-running")
    ) {
      throw Object.assign(new Error("Retained handoff journal does not match the launch record"), {
        code: "RETAINED_HANDOFF_IDENTITY_MISMATCH",
      });
    }
    for (const identity of [journal.candidateProcessIdentity, journal.oldProcessIdentity]) {
      const pid = Number.parseInt(identity?.split(":", 1)[0] ?? "", 10);
      if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid)) continue;
      const buildId =
        identity === journal.candidateProcessIdentity
          ? journal.candidateHostBuildId
          : journal.oldHostBuildId;
      if (!(await isVerifiedManagedProcess(pid, journal.launchId, buildId))) {
        return { status: "unverifiable" };
      }
      await terminateProcessGroup(pid);
    }
    if (candidateSelected) {
      const retained = await this.readRetainedCandidate(
        record.launchId,
        journal.candidateHostBuildId
      );
      if (
        retained.launchId !== record.launchId ||
        retained.hostBuildId !== journal.candidateHostBuildId ||
        retained.input.snapshot.executionInputHash !== record.executionInputHash ||
        retained.input.snapshot.recipeDigest !== record.recipeDigest ||
        retained.input.sourceStateHash !== record.sourceStateHash ||
        retained.input.target.kind !== "isolated-host" ||
        retained.input.target.persistence !== "retained"
      ) {
        throw Object.assign(
          new Error("Selected retained candidate does not match the durable launch record"),
          { code: "RETAINED_HANDOFF_IDENTITY_MISMATCH" }
        );
      }
      this.builds.set(record.launchId, {
        root: retained.buildRoot,
        hostBuildId: retained.hostBuildId,
      });
      await this.validate(retained.input, retained.hostBuildId);
      const generation = await this.startPrepared(retained.input, retained.hostBuildId);
      await this.removeRetainedHandoff(journal);
      return { status: "recovered", generation };
    }
    if (
      (journal.phase === "backed-up" || journal.phase === "candidate-running") &&
      journal.backupDigest
    ) {
      if ((await directoryDigest(journal.backupRoot)) !== journal.backupDigest) {
        throw Object.assign(new Error("Retained handoff backup failed integrity verification"), {
          code: "RETAINED_ROLLBACK_INTEGRITY",
        });
      }
      await fs.rm(journal.dataRoot, { recursive: true, force: true });
      await fs.cp(journal.backupRoot, journal.dataRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    this.builds.set(record.launchId, {
      root: journal.oldBuildRoot,
      hostBuildId: journal.oldHostBuildId,
    });
    await this.validate(journal.oldInput, journal.oldHostBuildId);
    const generation = await this.startPrepared(journal.oldInput, journal.oldHostBuildId);
    await this.removeRetainedHandoff(journal);
    return { status: "recovered", generation };
  }

  private async persistRetainedCandidate(candidate: RetainedCandidate): Promise<void> {
    const file = this.retainedCandidateFile(candidate.launchId, candidate.hostBuildId);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp.${process.pid}`;
    await fs.writeFile(temp, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, file);
  }

  private async readRetainedCandidate(
    launchId: string,
    hostBuildId: string
  ): Promise<RetainedCandidate> {
    const parsed = JSON.parse(
      await fs.readFile(this.retainedCandidateFile(launchId, hostBuildId), "utf8")
    ) as RetainedCandidate;
    if (parsed.version !== 1 || !parsed.input || typeof parsed.buildRoot !== "string") {
      throw Object.assign(new Error("Retained generation journal is invalid"), {
        code: "RETAINED_JOURNAL_INVALID",
      });
    }
    return parsed;
  }

  private async run(
    launchId: string,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.capture(launchId, "stdout", child.stdout);
      this.capture(launchId, "stderr", child.stderr);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            Object.assign(
              new Error(
                `${path.basename(command)} ${args.join(" ")} exited with ${code ?? signal}`
              ),
              { code: "BUILD_COMMAND_FAILED" }
            )
          );
      });
    });
  }

  private async startManagedClient(input: {
    input: BuildInput;
    hostBuildId: string;
    buildRoot: string;
    generationRoot: string;
    invite: HubPairingInvite;
    expectedHost: { serverId: string; workspaceId: string };
  }): Promise<ManagedClientStartResult> {
    if (!input.expectedHost.workspaceId) {
      throw Object.assign(new Error("Managed client target workspace identity is missing"), {
        code: "READY_IDENTITY_MISMATCH",
      });
    }
    const clientRoot = path.join(input.generationRoot, "electron");
    const profileDir = path.join(clientRoot, "profile");
    const pairingFile = path.join(clientRoot, "pairing.json");
    const readyFile = path.join(clientRoot, "ready.json");
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(pairingFile, JSON.stringify(input.invite), { mode: 0o600 });
    await fs.rm(readyFile, { force: true });
    const environment = createNativeChildEnvironment({
      purpose: "electron",
      declared: {
        NODE_ENV: "production",
        VIBESTUDIO_MANAGED_DEV: "1",
        VIBESTUDIO_MANAGED_DEV_LAUNCH_ID: input.input.launchId,
        VIBESTUDIO_MANAGED_DEV_CLIENT_BUILD_ID: input.hostBuildId,
        VIBESTUDIO_MANAGED_DEV_PROFILE_DIR: profileDir,
        VIBESTUDIO_MANAGED_DEV_PAIRING_FILE: pairingFile,
        VIBESTUDIO_MANAGED_DEV_READY_FILE: readyFile,
        VIBESTUDIO_MANAGED_DEV_EXPECTED_SERVER_ID: input.expectedHost.serverId,
        VIBESTUDIO_MANAGED_DEV_EXPECTED_WORKSPACE_ID: input.expectedHost.workspaceId,
      },
    });
    // The host-owned runtime is Electron in desktop distributions. Child-hub
    // launches opt into Node mode; managed clients deliberately do not.
    delete environment.env["ELECTRON_RUN_AS_NODE"];
    const child = spawn(toolchainRuntime(), [input.buildRoot], {
      cwd: input.buildRoot,
      env: environment.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.capture(input.input.launchId, "electron-stdout", child.stdout);
    this.capture(input.input.launchId, "electron-stderr", child.stderr);
    const ready = await waitForManagedClientReady(readyFile, child);
    if (
      ready.launchId !== input.input.launchId ||
      ready.clientBuildId !== input.hostBuildId ||
      ready.pid !== child.pid ||
      ready.serverId !== input.expectedHost.serverId ||
      ready.workspaceId !== input.expectedHost.workspaceId
    ) {
      await stopChild(child);
      throw Object.assign(new Error("Managed Electron ready identity did not match its launch"), {
        code: "READY_IDENTITY_MISMATCH",
      });
    }
    return { child, readyFile, ready };
  }

  private capture(launchId: string, source: string, stream: NodeJS.ReadableStream | null): void {
    stream?.on("data", (chunk) => {
      const message = redactDevHostLog(String(chunk));
      if (message) {
        this.appendLog(
          launchId,
          source.includes("stderr") ? "error" : "info",
          `${source}: ${message}`
        );
        this.ctx.log.info(`[dev-host:${launchId}:${source}] ${message}`);
      }
    });
  }
}

function redactDevHostLog(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(admin|agent|refresh|gateway|access)[_-]?(token|secret)\s*[:=]\s*[^\s"']+/gi,
      "$1_$2=[REDACTED]"
    )
    .replace(/([?&](?:token|secret|invite|code)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:agent|refresh|admin):[^\s"']+/gi, "[REDACTED]")
    .trim();
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isVerifiedManagedProcess(
  pid: number,
  launchId: string,
  hostBuildId: string
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const environment = (await fs.readFile(`/proc/${pid}/environ`)).toString("utf8").split("\0");
    return (
      environment.includes(`VIBESTUDIO_MANAGED_DEV_LAUNCH_ID=${launchId}`) &&
      (environment.includes(`VIBESTUDIO_MANAGED_DEV_BUILD_ID=${hostBuildId}`) ||
        environment.includes(`VIBESTUDIO_MANAGED_DEV_CLIENT_BUILD_ID=${hostBuildId}`))
    );
  } catch {
    return false;
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else process.kill(pid, "SIGTERM");
    await waitForPidExit(pid, 5_000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function directoryDigest(root: string): Promise<string> {
  const files: Array<{ path: string; mode: number; digest: string }> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw Object.assign(new Error(`Retained data contains unsupported entry ${relative}`), {
          code: "RETAINED_DATA_UNSUPPORTED",
        });
      }
      const stat = await fs.stat(absolute);
      files.push({
        path: relative,
        mode: stat.mode & 0o777,
        digest: sha256(await fs.readFile(absolute)),
      });
    }
  };
  await visit(root, "");
  return domainHash("vibestudio/dev-host-retained-data/v1", JSON.stringify(files));
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error(`Timed out waiting for retained process ${pid} to stop`), {
    code: "PROCESS_STOP_TIMEOUT",
  });
}

async function pairChild(invite: HubPairingInvite | null, serverId: string): Promise<RpcClient> {
  if (!invite) {
    throw Object.assign(new Error("Child hub did not publish an ordinary root-device invite"), {
      code: "PAIRING_INVITE_MISSING",
    });
  }
  const issued: { current: { deviceId: string; refreshToken: string } | null } = {
    current: null,
  };
  const client = new WebRtcRpcClient({
    pairing: invite,
    callerId: "shell:dev-host-supervisor",
    getToken: () => invite.code,
    clientLabel: "Vibestudio dev-host supervisor",
    onPaired: (credential) => {
      issued.current = credential;
    },
  });
  try {
    await client.ready();
    const credential = issued.current;
    if (!credential) throw new Error("Pairing completed without issuing a device credential");
    const route = await client.call<{
      workspace: string;
      workspaceId: string;
      serverId: string;
      workspaceReach: HubPairingInvite;
    }>("hubControl.routeWorkspace", [{ workspace: "vibestudio-dev" }]);
    if (route.serverId !== serverId) throw new Error("Child workspace route changed host identity");
    return new RpcClient(
      {
        url: route.workspaceReach.deepLink,
        deviceId: credential.deviceId,
        refreshToken: credential.refreshToken,
        workspacePairing: route.workspaceReach,
      },
      {
        expectedHost: { serverId, workspaceId: route.workspaceId },
        clientLabel: "Vibestudio dev-host",
      }
    );
  } finally {
    await client.close();
  }
}

async function waitForReadyFile(file: string, child: ChildProcess) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw Object.assign(
        new Error(`Child hub exited before readiness (${child.exitCode ?? child.signalCode})`),
        {
          code: "CHILD_EXITED",
        }
      );
    }
    try {
      const parsed = HubReadyPayloadSchema.safeParse(JSON.parse(await fs.readFile(file, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // The ready file is atomically replaced; absence during startup is expected.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopChild(child);
  throw Object.assign(new Error("Timed out waiting for child hub readiness"), {
    code: "READY_TIMEOUT",
  });
}

async function waitForManagedClientReady(
  file: string,
  child: ChildProcess
): Promise<NonNullable<DevLaunchStatus["clientReadinessIdentity"]>> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw Object.assign(
        new Error(
          `Managed Electron exited before readiness (${child.exitCode ?? child.signalCode})`
        ),
        { code: "CHILD_EXITED" }
      );
    }
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      if (
        value["version"] === 1 &&
        typeof value["launchId"] === "string" &&
        typeof value["clientBuildId"] === "string" &&
        typeof value["profileId"] === "string" &&
        typeof value["pid"] === "number" &&
        typeof value["serverId"] === "string" &&
        typeof value["workspaceId"] === "string"
      ) {
        return {
          launchId: value["launchId"],
          clientBuildId: value["clientBuildId"],
          profileId: value["profileId"],
          pid: value["pid"],
          serverId: value["serverId"],
          workspaceId: value["workspaceId"],
        };
      }
    } catch {
      // Atomic publication means absence and partial timing are ordinary here.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stopChild(child);
  throw Object.assign(new Error("Timed out waiting for managed Electron readiness"), {
    code: "READY_TIMEOUT",
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
  else child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function toolchainRuntime(): string {
  const root = process.env["VIBESTUDIO_TOOLCHAIN_DIR"];
  if (!root)
    throw Object.assign(new Error("Host toolchain is not available"), {
      code: "TOOLCHAIN_INCOMPLETE",
    });
  return path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
}

async function makeWritable(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  await fs.chmod(root, 0o700);
  await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(root, entry.name);
      if (entry.isDirectory()) return makeWritable(child);
      if (entry.isFile())
        return fs.chmod(child, (await fs.stat(child)).mode & 0o111 ? 0o700 : 0o600);
      throw new Error(`Unsupported execution snapshot entry: ${child}`);
    })
  );
}

async function releaseOwnedSnapshot(input: CustodyInput): Promise<void> {
  const root = path.resolve(path.dirname(input.snapshot.manifestPath));
  const expectedManifest = path.join(root, "snapshot.json");
  if (
    path.resolve(input.snapshot.manifestPath) !== expectedManifest ||
    path.resolve(input.snapshot.sourceRoot) !== path.join(root, "source") ||
    path.resolve(input.snapshot.scratchRoot) !== path.join(root, "scratch")
  ) {
    throw Object.assign(new Error("Refusing to release a malformed execution snapshot layout"), {
      code: "SNAPSHOT_OWNERSHIP_MISMATCH",
    });
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await fs.readFile(expectedManifest, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    manifest["version"] !== 1 ||
    manifest["snapshotId"] !== input.snapshot.snapshotId ||
    manifest["executionInputHash"] !== input.snapshot.executionInputHash ||
    manifest["recipeDigest"] !== input.snapshot.recipeDigest ||
    typeof manifest["ownershipNonce"] !== "string"
  ) {
    throw Object.assign(
      new Error("Refusing to release an execution snapshot with mismatched ownership"),
      {
        code: "SNAPSHOT_OWNERSHIP_MISMATCH",
      }
    );
  }
  await makeWritable(input.snapshot.sourceRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await makeWritable(input.snapshot.scratchRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await fs.rm(root, { recursive: true, force: false });
  await fs.rmdir(path.dirname(root)).catch(() => undefined);
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export type Api = Awaited<ReturnType<typeof activate>>;

export async function activate(ctx: ExtensionContext) {
  const lifecycle = new DevHostLifecycle(storage(ctx), new NativeDevHostExecutor(ctx));
  await lifecycle.start();
  ctx.health.healthy({ summary: "Exact-state development host supervisor is ready" });
  return {
    providerContracts: {
      devHost: {
        prepare: (input: DevHostProviderPreparationInput) => lifecycle.prepare(input),
        failPreparation: (
          input: DevHostProviderPreparationInput,
          failure: DevHostProviderPreparationFailure
        ) => lifecycle.failPreparation(input, failure),
        launch: (input: DevHostProviderLaunchInput) => lifecycle.launch(input),
        status: async () => lifecycle.status(),
        rebuild: (input: DevHostProviderRebuildInput) => lifecycle.rebuild(input),
        stop: (launchId: string) => lifecycle.stop(launchId),
        evalStart: (
          launchId: string,
          input: EvalStartInput,
          authority: EvalParentAuthorityEnvelope
        ) => lifecycle.evalStart(launchId, input, authority),
        evalGet: (launchId: string, input: EvalGetInput) => lifecycle.evalGet(launchId, input),
        evalEvents: (launchId: string, input: EvalEventsInput) =>
          lifecycle.evalEvents(launchId, input),
        evalCancel: (launchId: string, input: EvalCancelInput) =>
          lifecycle.evalCancel(launchId, input),
        logs: (launchId: string, after?: number) => lifecycle.logs(launchId, after),
        watch: (launchId: string, after?: number) => lifecycle.watch(launchId, after),
      },
    },
  };
}
