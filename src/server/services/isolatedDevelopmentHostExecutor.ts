import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HubReadyPayloadSchema } from "@vibestudio/service-schemas/hubControl";
import type { DevelopmentInstance, DevelopmentRun } from "@vibestudio/service-schemas/development";
import { DevInstanceSupervisor } from "../../dev/devInstanceSupervisor.js";
import {
  observeOwnedProcess,
  signalOwnedProcessIdentity,
  type OwnedProcessIdentity,
} from "../../dev/ownedProcessIdentity.js";
import { bootstrapInstanceCli } from "../../dev/bootstrapInstanceCli.js";
import { loadCliCredentials } from "../../cli/credentialStore.js";
import { pairRemoteDevice } from "../../cli/remoteClient.js";
import { RpcClient } from "../../cli/rpcClient.js";
import {
  adoptDevInstance,
  clearDevInstanceReady,
  publishDevInstanceReady,
  readDevInstanceRecord,
  registerDevInstance,
  resolveDevInstance,
  unregisterDevInstance,
  type DevInstanceRecord,
} from "../../dev/instanceRegistry.js";
import { writeFileAtomicSync } from "../../atomicFile.js";
import type {
  DevelopmentExecutor,
  OwnedDevelopmentLaunch,
  PreparedDevelopmentBuild,
} from "./developmentExecutor.js";
import type { AttachedHostBootstrapPort, AttachedHostRoutePort } from "./attachedHostController.js";

const REDACT = /(?:token|password|secret|authorization|cookie|private[_-]?key)\s*[=:]\s*[^\s]+/giu;
const PROCESS_MARKER = "development-process.json";

interface ProcessOwner {
  stop(signal?: NodeJS.Signals): Promise<number>;
  wait(): Promise<number>;
}

interface ActiveIsolatedHost {
  instance: DevInstanceRecord;
  supervisor: ProcessOwner;
  ready: boolean;
  stopping: boolean;
  manager: IsolatedDevelopmentManager | null;
  attachmentPorts: {
    bootstrap: AttachedHostBootstrapPort;
    route: AttachedHostRoutePort;
  } | null;
}

export interface IsolatedDevelopmentManager {
  mintClientInvite(ttlMs: number): Promise<string>;
  waitForClientAttestation(
    requestId: string,
    timeoutMs: number,
    assertGeneration: () => void
  ): Promise<{ requestId: string; childRuntimeId: string; attestedAt: number }>;
}

export interface IsolatedHostLifecycle {
  onRegistered(instance: DevelopmentInstance): void;
  onReady(instance: DevelopmentInstance): void | Promise<void>;
  onExit(code: number): void;
}

/**
 * Launches only the reviewed, retained server artifact for an exact
 * development run. Instance state and credentials remain below the run-owned
 * root; the parent process environment is never inherited.
 */
export class IsolatedDevelopmentHostExecutor {
  private readonly active = new Map<string, ActiveIsolatedHost>();

  constructor(
    private readonly deps: {
      controlRepoRoot: string;
      parentGatewayUrl?: string;
      buildExecutor: Pick<DevelopmentExecutor, "resolveOwnedLaunch">;
      onLog?: (runId: string, stream: "stdout" | "stderr", line: string) => void;
      register?: typeof registerDevInstance;
      readInstance?: typeof readDevInstanceRecord;
      resolve?: typeof resolveDevInstance;
      adopt?: typeof adoptDevInstance;
      unregister?: typeof unregisterDevInstance;
      bootstrap?: typeof bootstrapInstanceCli;
      supervisor?: (
        options: ConstructorParameters<typeof DevInstanceSupervisor>[0]
      ) => DevInstanceSupervisor;
      createManager?: (input: {
        credentialFile: string;
        instance: DevInstanceRecord;
        childGatewayUrl: string;
      }) => Promise<IsolatedDevelopmentManager>;
      createAttachmentPorts?: (input: {
        credentialFile: string;
        childGatewayUrl: string;
        childGenerationId: string;
      }) => {
        bootstrap: AttachedHostBootstrapPort;
        route: AttachedHostRoutePort;
      };
      now?: () => number;
    }
  ) {}

  async start(
    run: DevelopmentRun,
    plan: PreparedDevelopmentBuild,
    lifecycle: IsolatedHostLifecycle
  ): Promise<DevelopmentInstance> {
    if (process.platform === "win32") {
      throw Object.assign(
        new Error("Isolated development hosts require a Windows job-object executor"),
        { code: "EEXECUTOR_UNAVAILABLE" }
      );
    }
    if (run.target.kind !== "isolated-host") {
      throw Object.assign(new Error("This reviewed executor only starts an isolated host"), {
        code: "EUNSUPPORTED_TARGET",
      });
    }
    if (this.active.has(run.runId)) {
      throw Object.assign(new Error(`Development run ${run.runId} already owns an instance`), {
        code: "EALREADY",
      });
    }

    const launch = await this.deps.buildExecutor.resolveOwnedLaunch(run, plan);
    const instanceId = isolatedInstanceId(run.runId);
    const instanceRoot = path.join(launch.runRoot, "isolated-instance");
    const readyFile = path.join(instanceRoot, "server-auth", "hub-ready.json");
    const credentialFile = path.join(instanceRoot, "cli", "credentials.json");
    const now = this.deps.now ?? Date.now;
    await fs.promises.mkdir(instanceRoot, { recursive: true, mode: 0o700 });

    const register = this.deps.register ?? registerDevInstance;
    const unregister = this.deps.unregister ?? unregisterDevInstance;
    const instance = register({
      id: instanceId,
      root: instanceRoot,
      repoRoot: this.deps.controlRepoRoot,
      supervisorPid: process.pid,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: now(),
    });
    clearDevInstanceReady(instance);

    let publicInstance: DevelopmentInstance = {
      instanceId,
      generationId: instance.generationId,
      lifecycle: "ephemeral",
      state: "registered",
      executionDigest: run.artifact!.executionDigest,
      serverBuildId: launch.serverBuildId,
      serverId: null,
      serverBootId: null,
      workspaceId: null,
      workspaceName: null,
      gatewayUrl: null,
      registeredAt: now(),
      readyAt: null,
      stoppedAt: null,
    };
    try {
      // Registration is a durable commit point before process creation.
      lifecycle.onRegistered(publicInstance);
    } catch (error) {
      unregister(this.deps.controlRepoRoot, instanceId);
      throw error;
    }

    const Supervisor = this.deps.supervisor ?? ((options) => new DevInstanceSupervisor(options));
    const supervisor = Supervisor({
      sourceRoot: launch.sourceRoot,
      command: launch.nodePath,
      args: [launch.serverEntryPath, "--ephemeral", "--ready-file", readyFile],
      env: isolatedEnvironment(
        instanceRoot,
        instanceId,
        instance.generationId,
        run.runId,
        this.deps.parentGatewayUrl,
        launch
      ),
      stdio: ["ignore", "pipe", "pipe"],
      onSpawn: (identity) => {
        writeFileAtomicSync(
          path.join(instanceRoot, PROCESS_MARKER),
          `${JSON.stringify(
            {
              version: 1,
              runId: run.runId,
              snapshotDigest: run.snapshot.snapshotDigest,
              instanceId,
              generationId: instance.generationId,
              identity,
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        );
      },
      readiness: {
        file: readyFile,
        onReady: async (rawReady) => {
          const ready = HubReadyPayloadSchema.parse(rawReady);
          const childPid = supervisor.process?.pid;
          if (childPid === undefined || ready.pid !== childPid) {
            throw Object.assign(new Error("Readiness belongs to a different child process"), {
              code: "EREADINESS_DRIFT",
            });
          }
          if (ready.buildId !== launch.serverBuildId) {
            throw Object.assign(
              new Error("Ready host execution digest does not match the retained server artifact"),
              { code: "EREADINESS_DRIFT" }
            );
          }
          assertLoopbackGateway(ready.gatewayUrl);
          const bootstrap = await (this.deps.bootstrap ?? bootstrapInstanceCli)(ready, {
            credentialFile,
          });
          if (bootstrap.status === "invite-required") {
            throw Object.assign(
              new Error("Isolated host did not provide an ordinary device pairing path"),
              { code: "ECLI_BOOTSTRAP" }
            );
          }
          const workspace = ready.workspaces.find(
            (candidate) => candidate.name === bootstrap.workspaceName
          );
          if (!workspace) {
            throw Object.assign(new Error("Paired workspace is absent from exact readiness"), {
              code: "EREADINESS_DRIFT",
            });
          }
          publishDevInstanceReady(instance, bootstrap);
          active.manager = await (this.deps.createManager ?? createIsolatedDevelopmentManager)({
            credentialFile,
            instance,
            childGatewayUrl: ready.gatewayUrl,
          });
          active.attachmentPorts =
            this.deps.createAttachmentPorts?.({
              credentialFile,
              childGatewayUrl: ready.gatewayUrl,
              childGenerationId: instance.generationId,
            }) ?? null;
          active.ready = true;
          publicInstance = {
            ...publicInstance,
            state: "ready",
            serverId: ready.serverId,
            serverBootId: ready.serverBootId,
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.name,
            gatewayUrl: ready.gatewayUrl,
            readyAt: now(),
          };
          await lifecycle.onReady(publicInstance);
        },
      },
    });
    const active: ActiveIsolatedHost = {
      instance,
      supervisor,
      ready: false,
      stopping: false,
      manager: null,
      attachmentPorts: null,
    };
    this.active.set(run.runId, active);
    try {
      const startup = supervisor.start();
      this.captureLogs(run.runId, supervisor);
      await startup;
      active.ready = true;
      void supervisor.wait().then(
        (code) => {
          if (active.stopping) return;
          this.active.delete(run.runId);
          unregister(this.deps.controlRepoRoot, instanceId);
          clearDevInstanceReady(instance);
          lifecycle.onExit(code);
        },
        () => {
          if (active.stopping) return;
          this.active.delete(run.runId);
          unregister(this.deps.controlRepoRoot, instanceId);
          clearDevInstanceReady(instance);
          lifecycle.onExit(1);
        }
      );
      return publicInstance;
    } catch (error) {
      this.active.delete(run.runId);
      await supervisor.stop().catch(() => undefined);
      unregister(this.deps.controlRepoRoot, instanceId);
      clearDevInstanceReady(instance);
      throw error;
    }
  }

  async stop(run: DevelopmentRun): Promise<DevelopmentInstance | null> {
    const recorded = run.instance;
    if (!recorded) return null;
    const active = this.active.get(run.runId);
    if (
      !active ||
      active.instance.id !== recorded.instanceId ||
      active.instance.generationId !== recorded.generationId
    ) {
      // A registry record owned by another generation is observation only. It
      // is never sufficient authority to signal or delete that process.
      const resolve = this.deps.resolve ?? resolveDevInstance;
      try {
        const observed = resolve(this.deps.controlRepoRoot, recorded.instanceId);
        if (observed.generationId !== recorded.generationId) {
          throw Object.assign(new Error("A different instance generation owns this id"), {
            code: "EOWNERSHIP",
          });
        }
      } catch (error) {
        throw Object.assign(new Error("Exact isolated-host process ownership is unavailable"), {
          code: "EOWNERSHIP",
          cause: error,
        });
      }
      throw Object.assign(new Error("The exact instance has no live supervisor handle"), {
        code: "EOWNERSHIP",
      });
    }
    active.stopping = true;
    await active.supervisor.stop();
    this.active.delete(run.runId);
    (this.deps.unregister ?? unregisterDevInstance)(this.deps.controlRepoRoot, recorded.instanceId);
    clearDevInstanceReady(active.instance);
    const stoppedAt = (this.deps.now ?? Date.now)();
    return { ...recorded, state: "stopped", stoppedAt };
  }

  async mintClientInvite(run: DevelopmentRun, ttlMs = 5 * 60_000): Promise<string> {
    const active = this.requireManagedHost(run);
    return active.manager.mintClientInvite(ttlMs);
  }

  async waitForClientAttestation(
    run: DevelopmentRun,
    requestId: string,
    timeoutMs = 5 * 60_000
  ): Promise<{ requestId: string; childRuntimeId: string; attestedAt: number }> {
    const active = this.requireManagedHost(run);
    return active.manager.waitForClientAttestation(requestId, timeoutMs, () =>
      this.assertExactActive(run, active)
    );
  }

  takeAttachmentPorts(run: DevelopmentRun): {
    bootstrap: AttachedHostBootstrapPort;
    route: AttachedHostRoutePort;
  } {
    const active = this.requireManagedHost(run);
    if (!active.attachmentPorts) {
      throw Object.assign(new Error("Attached-host publication transport is unavailable"), {
        code: "EATTACHED_ROUTE",
      });
    }
    return active.attachmentPorts;
  }

  retireManagementChannel(run: DevelopmentRun): void {
    const active = this.active.get(run.runId);
    this.assertExactActive(run, active);
    if (active) {
      active.manager = null;
      active.attachmentPorts = null;
    }
  }

  recoveryOwnership(run: DevelopmentRun): "owned" | "unknown" | "absent" {
    if (!run.instance) return "absent";
    const active = this.active.get(run.runId);
    if (
      active?.instance.id === run.instance.instanceId &&
      active.instance.generationId === run.instance.generationId
    ) {
      return "owned";
    }
    return "unknown";
  }

  async recover(
    run: DevelopmentRun,
    onExit: (code: number) => void
  ): Promise<"owned" | "stopped" | "absent" | "unknown"> {
    if (!run.instance) return "absent";
    let recorded: DevInstanceRecord;
    let marker: ProcessMarker;
    try {
      recorded = (this.deps.readInstance ?? readDevInstanceRecord)(
        this.deps.controlRepoRoot,
        run.instance.instanceId
      );
      if (recorded.generationId !== run.instance.generationId) return "unknown";
      marker = readProcessMarker(path.join(recorded.root, PROCESS_MARKER), run);
    } catch {
      return "unknown";
    }
    const observation = observeOwnedProcess(marker.identity);
    if (observation === "unknown") return "unknown";
    if (observation === "absent") {
      (this.deps.unregister ?? unregisterDevInstance)(this.deps.controlRepoRoot, recorded.id);
      return "absent";
    }
    let adopted: DevInstanceRecord;
    try {
      adopted = (this.deps.adopt ?? adoptDevInstance)(
        this.deps.controlRepoRoot,
        recorded,
        process.pid
      );
    } catch {
      return "unknown";
    }
    const owner = new AdoptedProcessOwner(marker.identity);
    this.active.set(run.runId, {
      instance: adopted,
      supervisor: owner,
      ready: run.hostReadiness === "ready",
      stopping: false,
      manager:
        run.hostReadiness === "ready"
          ? await (this.deps.createManager ?? createIsolatedDevelopmentManager)({
              credentialFile: path.join(adopted.root, "cli", "credentials.json"),
              instance: adopted,
              childGatewayUrl: run.instance?.gatewayUrl ?? "",
            }).catch(() => null)
          : null,
      attachmentPorts:
        run.hostReadiness === "ready" && run.instance?.gatewayUrl && this.deps.createAttachmentPorts
          ? this.deps.createAttachmentPorts({
              credentialFile: path.join(adopted.root, "cli", "credentials.json"),
              childGatewayUrl: run.instance.gatewayUrl,
              childGenerationId: adopted.generationId,
            })
          : null,
    });
    if (run.hostReadiness !== "ready") {
      await owner.stop();
      this.active.delete(run.runId);
      (this.deps.unregister ?? unregisterDevInstance)(this.deps.controlRepoRoot, adopted.id);
      clearDevInstanceReady(adopted);
      return "stopped";
    }
    void owner.wait().then(
      (code) => {
        const active = this.active.get(run.runId);
        if (active?.stopping) return;
        this.active.delete(run.runId);
        (this.deps.unregister ?? unregisterDevInstance)(this.deps.controlRepoRoot, adopted.id);
        clearDevInstanceReady(adopted);
        onExit(code);
      },
      () => {
        const active = this.active.get(run.runId);
        if (active?.stopping) return;
        this.active.delete(run.runId);
        onExit(1);
      }
    );
    return "owned";
  }

  private captureLogs(runId: string, supervisor: DevInstanceSupervisor): void {
    const child = supervisor.process;
    if (!child) return;
    for (const [streamName, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const) {
      if (!stream) continue;
      let buffered = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/u);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          this.deps.onLog?.(runId, streamName, redact(line));
        }
      });
      stream.on("end", () => {
        if (buffered) this.deps.onLog?.(runId, streamName, redact(buffered));
      });
    }
  }

  private requireManagedHost(
    run: DevelopmentRun
  ): ActiveIsolatedHost & { manager: IsolatedDevelopmentManager } {
    const active = this.active.get(run.runId);
    this.assertExactActive(run, active);
    if (!active?.ready || !active.manager) {
      throw Object.assign(new Error("Exact isolated management channel is not ready"), {
        code: "ESTATE",
      });
    }
    return active as ActiveIsolatedHost & { manager: IsolatedDevelopmentManager };
  }

  private assertExactActive(run: DevelopmentRun, active: ActiveIsolatedHost | undefined): void {
    if (
      !run.instance ||
      !active ||
      active.instance.id !== run.instance.instanceId ||
      active.instance.generationId !== run.instance.generationId
    ) {
      throw Object.assign(new Error("Exact isolated instance generation is not active"), {
        code: "EOWNERSHIP",
      });
    }
  }
}

interface ProcessMarker {
  version: 1;
  runId: string;
  snapshotDigest: string;
  instanceId: string;
  generationId: string;
  identity: OwnedProcessIdentity;
}

function readProcessMarker(filePath: string, run: DevelopmentRun): ProcessMarker {
  const marker = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ProcessMarker>;
  if (
    marker.version !== 1 ||
    marker.runId !== run.runId ||
    marker.snapshotDigest !== run.snapshot.snapshotDigest ||
    marker.instanceId !== run.instance?.instanceId ||
    marker.generationId !== run.instance?.generationId ||
    !marker.identity
  ) {
    throw Object.assign(new Error("Isolated-host process marker does not match the run"), {
      code: "EOWNERSHIP",
    });
  }
  return marker as ProcessMarker;
}

class AdoptedProcessOwner implements ProcessOwner {
  constructor(private readonly identity: OwnedProcessIdentity) {}

  async wait(): Promise<number> {
    for (;;) {
      const observation = observeOwnedProcess(this.identity);
      if (observation === "absent") return 1;
      if (observation === "unknown") {
        throw Object.assign(new Error("Adopted process ownership became ambiguous"), {
          code: "EOWNERSHIP",
        });
      }
      await delay(100);
    }
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    signalOwnedProcessIdentity(this.identity, signal);
    if (signal !== "SIGKILL" && !(await waitForAbsence(this.identity, 10_000))) {
      signalOwnedProcessIdentity(this.identity, "SIGKILL");
    }
    if (!(await waitForAbsence(this.identity, 10_000))) {
      throw Object.assign(new Error("Adopted process group did not exit"), {
        code: "EOWNERSHIP",
      });
    }
    return 0;
  }
}

async function waitForAbsence(identity: OwnedProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = observeOwnedProcess(identity);
    if (observation === "absent") return true;
    if (observation === "unknown") {
      throw Object.assign(new Error("Exact process ownership became ambiguous during stop"), {
        code: "EOWNERSHIP",
      });
    }
    await delay(50);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isolatedInstanceId(runId: string): string {
  return `development-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
}

function isolatedEnvironment(
  instanceRoot: string,
  instanceId: string,
  generationId: string,
  runId: string,
  parentGatewayUrl: string | undefined,
  launch: OwnedDevelopmentLaunch
): NodeJS.ProcessEnv {
  const home = path.join(instanceRoot, "home");
  const temp = path.join(instanceRoot, "tmp");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  return {
    NODE_ENV: "development",
    HOME: home,
    XDG_CONFIG_HOME: path.join(instanceRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(instanceRoot, "xdg-data"),
    XDG_CACHE_HOME: path.join(instanceRoot, "xdg-cache"),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    PATH: path.dirname(launch.nodePath),
    VIBESTUDIO_APP_ROOT: launch.sourceRoot,
    VIBESTUDIO_INSTANCE_ROOT: instanceRoot,
    VIBESTUDIO_INSTANCE: instanceId,
    VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION: generationId,
    VIBESTUDIO_DEVELOPMENT_PARENT_RUN: runId,
    ...(parentGatewayUrl ? { VIBESTUDIO_ATTACHED_PARENT_GATEWAY_URL: parentGatewayUrl } : {}),
    VIBESTUDIO_SOURCE_INSTANCE: "0",
  };
}

async function createIsolatedDevelopmentManager(input: {
  credentialFile: string;
  instance: DevInstanceRecord;
  childGatewayUrl: string;
}): Promise<IsolatedDevelopmentManager> {
  const credentials = loadCliCredentials(input.credentialFile);
  if (!credentials) {
    throw Object.assign(new Error("Isolated management credential was not retained"), {
      code: "ECLI_BOOTSTRAP",
    });
  }
  const client = new RpcClient(credentials);
  try {
    await client.call("developmentClientExecutor.bindIsolatedManager", [
      { instanceId: input.instance.id, generationId: input.instance.generationId },
    ]);
  } finally {
    await client.close();
  }
  return {
    async mintClientInvite(ttlMs) {
      const invite = await pairRemoteDevice(credentials, {
        workspace: credentials.workspaceName,
        ttlMs,
      });
      return invite.pairing.deepLink;
    },
    async waitForClientAttestation(requestId, timeoutMs, assertGeneration) {
      const rpc = new RpcClient(credentials);
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          assertGeneration();
          const receipt = await rpc.call<{
            requestId: string;
            childRuntimeId: string;
            attestedAt: number;
          } | null>("developmentClientExecutor.consumeAttestation", [{ requestId }]);
          if (receipt) return receipt;
          await delay(100);
        }
        throw Object.assign(new Error("Isolated development client did not attest before expiry"), {
          code: "EEXECUTOR_TIMEOUT",
        });
      } finally {
        await rpc.close();
      }
    },
  };
}

function assertLoopbackGateway(rawUrl: string): void {
  const hostname = new URL(rawUrl).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw Object.assign(new Error("Isolated development host exposed a non-loopback gateway"), {
      code: "EREADINESS_DRIFT",
    });
  }
}

function redact(line: string): string {
  return line.replace(REDACT, "[redacted]").slice(0, 8_192);
}
