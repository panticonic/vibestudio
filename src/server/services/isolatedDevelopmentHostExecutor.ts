import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { HubReadyPayloadSchema } from "@vibestudio/service-schemas/hubControl";
import type { DevelopmentInstance, DevelopmentRun } from "@vibestudio/service-schemas/development";
import { DevInstanceSupervisor } from "../../dev/devInstanceSupervisor.js";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, OwnershipClaimedError } from "@vibestudio/shared/ownership";
import { pairLocalCli } from "../../cli/localPairing.js";
import { loadCliCredentials, requireDeviceCliCredentials } from "../../cli/credentialStore.js";
import { pairRemoteDevice } from "../../cli/remoteClient.js";
import { RpcClient } from "../../cli/rpcClient.js";
import {
  clearDevInstanceReady,
  devInstanceLedgerId,
  publishDevInstanceReady,
  readDevInstanceRecord,
  registerDevInstance,
  resolveDevInstance,
  unregisterDevInstance,
  type DevInstanceRecord,
} from "../../dev/instanceRegistry.js";
import { DEFAULT_WORKSPACE_TEMPLATES_ENV } from "@vibestudio/workspace/templateRelease";
import {
  WORKSPACE_SOURCES_ENV,
  serializeWorkspaceSources,
} from "@vibestudio/workspace/workspaceSources";
import type {
  DevelopmentExecutor,
  OwnedDevelopmentLaunch,
  PreparedDevelopmentBuild,
} from "./developmentExecutor.js";
import type { AttachedHostBootstrapPort, AttachedHostRoutePort } from "./attachedHostController.js";

const REDACT = /(?:token|password|secret|authorization|cookie|private[_-]?key)\s*[=:]\s*[^\s]+/giu;

interface ProcessOwner {
  stop(signal?: NodeJS.Signals): Promise<number>;
  wait(): Promise<number>;
}

interface ActiveIsolatedHost {
  instance: DevInstanceRecord;
  /** The instance's ownership claim: its reaper retires the host if this server dies. */
  ownership: Ownership;
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
    assertGeneration: () => void,
    signal: AbortSignal
  ): Promise<{ requestId: string; childRuntimeId: string; attestedAt: number }>;
}

export interface IsolatedHostLifecycle {
  onRegistered(instance: DevelopmentInstance): void;
  onReady(instance: DevelopmentInstance): void | Promise<void>;
  onExit(code: number, instance: DevelopmentInstance): void;
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
      /** Claim an instance's ownership. Defaults to a leased claim in this profile. */
      openOwnership?: (options: {
        id: string;
        meta: Record<string, unknown>;
      }) => Promise<Ownership>;
      unregister?: typeof unregisterDevInstance;
      bootstrap?: typeof pairLocalCli;
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
    // The instance's claim comes first: nothing is registered or started
    // before its ownership is durable. Leased, so a killed server cannot leave
    // the isolated host running. Graceful kill mode is the supervisor's own.
    const ownership = await this.openOwnership(this.deps.controlRepoRoot, instanceId, {
      role: "isolated-development-host",
      runId: run.runId,
    });
    let instance: DevInstanceRecord;
    try {
      instance = register({
        id: instanceId,
        root: instanceRoot,
        repoRoot: this.deps.controlRepoRoot,
        supervisorPid: process.pid,
        kind: "server",
        lifecycle: "ephemeral",
        startedAt: now(),
        ledgerId: ownership.id,
      });
    } catch (error) {
      throw await this.closeAfterFailure(ownership, error, "Isolated host registration");
    }
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
      throw await this.closeAfterFailure(ownership, error, "Isolated host registration");
    }

    const Supervisor = this.deps.supervisor ?? ((options) => new DevInstanceSupervisor(options));
    const supervisor = Supervisor({
      ownership,
      label: `isolated-host:${run.runId}`,
      sourceRoot: launch.sourceRoot,
      command: launch.nodePath,
      args: [launch.serverEntryPath, "--ready-file", readyFile],
      env: isolatedEnvironment(
        instanceRoot,
        instanceId,
        instance.generationId,
        run.runId,
        this.deps.parentGatewayUrl,
        launch
      ),
      stdio: ["ignore", "pipe", "pipe"],
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
          const bootstrap = await (this.deps.bootstrap ?? pairLocalCli)(ready, {
            credentialFile,
          });
          if (bootstrap.status === "invite-required") {
            throw Object.assign(
              new Error("Isolated host did not provide an ordinary device pairing path"),
              { code: "ECLI_BOOTSTRAP" }
            );
          }
          // The bootstrap's own route is authoritative: a device creates the
          // account's private workspaces as it pairs, so they postdate the
          // catalog snapshot the host published at startup.
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
            workspaceId: bootstrap.workspaceId,
            workspaceName: bootstrap.workspaceName,
            gatewayUrl: ready.gatewayUrl,
            readyAt: now(),
          };
          await lifecycle.onReady(publicInstance);
        },
      },
    });
    const active: ActiveIsolatedHost = {
      instance,
      ownership,
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
      const exited = async (code: number) => {
        if (active.stopping) return;
        this.active.delete(run.runId);
        unregister(this.deps.controlRepoRoot, instanceId);
        clearDevInstanceReady(instance);
        // The host is gone; join its reaper before reporting the exit. A
        // failure to retire what it left is reported with the exit itself.
        const released = await active.ownership.close().then(
          () => undefined,
          (error: unknown) => error
        );
        if (released !== undefined) {
          this.deps.onLog?.(
            run.runId,
            "stderr",
            `isolated host ownership did not release cleanly: ${String(released)}`
          );
        }
        lifecycle.onExit(released === undefined ? code : 1, {
          ...publicInstance,
          state: "stopped",
          stoppedAt: now(),
        });
      };
      void supervisor.wait().then(exited, () => exited(1));
      return publicInstance;
    } catch (error) {
      try {
        await supervisor.stop();
        await ownership.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Isolated launch and its owned cleanup failed"
        );
      }
      this.active.delete(run.runId);
      unregister(this.deps.controlRepoRoot, instanceId);
      clearDevInstanceReady(instance);
      lifecycle.onExit(1, { ...publicInstance, state: "stopped", stoppedAt: now() });
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
    // Joins the instance's reaper: the host and anything it left are gone.
    await active.ownership.close();
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
    signal: AbortSignal,
    timeoutMs = 5 * 60_000
  ): Promise<{ requestId: string; childRuntimeId: string; attestedAt: number }> {
    const active = this.requireManagedHost(run);
    signal.throwIfAborted();
    return active.manager.waitForClientAttestation(
      requestId,
      timeoutMs,
      () => this.assertExactActive(run, active),
      signal
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

  /**
   * An isolated host is leased to the server that started it: that server's
   * reaper retires it when the server dies, so no host survives to be adopted.
   * Taking the instance's claim again proves it. A claim another live owner
   * holds is not ours to touch ("unknown"); a stale one is retired as it is
   * taken over, leaving only the registry record to remove.
   */
  async recover(
    run: DevelopmentRun,
    _onExit: (code: number) => void
  ): Promise<"owned" | "stopped" | "absent" | "unknown"> {
    if (!run.instance) return "absent";
    let recorded: DevInstanceRecord;
    try {
      recorded = (this.deps.readInstance ?? readDevInstanceRecord)(
        this.deps.controlRepoRoot,
        run.instance.instanceId
      );
      if (recorded.generationId !== run.instance.generationId) return "unknown";
    } catch {
      return "unknown";
    }
    let claim: Ownership;
    try {
      claim = await this.openOwnership(this.deps.controlRepoRoot, recorded.id, {
        role: "isolated-development-host-recovery",
        runId: run.runId,
      });
    } catch (error) {
      if (error instanceof OwnershipClaimedError) return "unknown";
      throw error;
    }
    (this.deps.unregister ?? unregisterDevInstance)(this.deps.controlRepoRoot, recorded.id);
    clearDevInstanceReady(recorded);
    await claim.close();
    return "absent";
  }

  private openOwnership(
    repoRoot: string,
    instanceId: string,
    meta: Record<string, unknown>
  ): Promise<Ownership> {
    const id = devInstanceLedgerId(repoRoot, instanceId);
    return this.deps.openOwnership
      ? this.deps.openOwnership({ id, meta })
      : Ownership.open({ profileDir: getProfileDataPath(), id, lifetime: "leased", meta });
  }

  /** Release a claim after a failure, keeping the original failure first. */
  private async closeAfterFailure(
    ownership: Ownership,
    error: unknown,
    what: string
  ): Promise<unknown> {
    try {
      await ownership.close();
    } catch (cleanupError) {
      return new AggregateError([error, cleanupError], `${what} and its ownership release failed`);
    }
    return error;
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

  /**
   * Refuse to operate on a generation other than the one this run owns.
   *
   * A run learns its instance identity from the readiness callback, so calls
   * made from inside that callback legitimately carry `instance: null` — they
   * are the calls that produce the identity. The run-keyed active record is
   * the binding in that window; once the caller has observed a generation,
   * both coordinates must still agree, which is what keeps a later call from
   * addressing a restarted host.
   */
  private assertExactActive(run: DevelopmentRun, active: ActiveIsolatedHost | undefined): void {
    const drifted =
      run.instance !== null &&
      (active?.instance.id !== run.instance.instanceId ||
        active?.instance.generationId !== run.instance.generationId);
    if (!active || drifted) {
      throw Object.assign(new Error("Exact isolated instance generation is not active"), {
        code: "EOWNERSHIP",
      });
    }
  }
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
    // The isolated host's own toolchain must win for node, but it still has to
    // find the sandbox prerequisites the parent host can: a workspace runtime
    // resolves bubblewrap through PATH, and a PATH holding only the toolchain
    // fails every workspace it starts with "bwrap is unavailable".
    PATH: [path.dirname(launch.nodePath), process.env["PATH"]]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter),
    VIBESTUDIO_APP_ROOT: launch.sourceRoot,
    [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(launch.workspaceTemplates),
    [WORKSPACE_SOURCES_ENV]: serializeWorkspaceSources(launch.workspaceSources),
    // A host refuses to start without the generation its compiled artifacts
    // come from, and a compiled server entry names its own directory.
    VIBESTUDIO_HOST_ARTIFACT_ROOT: path.dirname(launch.serverEntryPath),
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
  const loaded = loadCliCredentials(input.credentialFile);
  if (!loaded) {
    throw Object.assign(new Error("Isolated management credential was not retained"), {
      code: "ECLI_BOOTSTRAP",
    });
  }
  const credentials = requireDeviceCliCredentials(loaded, "isolated development manager");
  const client = new RpcClient(credentials);
  try {
    await client.mainCall("developmentClientExecutor.bindIsolatedManager", [
      { instanceId: input.instance.id, generationId: input.instance.generationId },
    ]);
  } finally {
    await client.close();
  }
  return {
    async mintClientInvite(ttlMs) {
      const invite = await pairRemoteDevice(credentials, {
        ttlMs,
      });
      return invite.pairing.deepLink;
    },
    async waitForClientAttestation(requestId, timeoutMs, assertGeneration, signal) {
      const rpc = new RpcClient(credentials);
      const deadline = Date.now() + timeoutMs;
      let cancelledClose: Promise<void> | undefined;
      const abort = () => {
        cancelledClose = rpc.close();
        // The finally block joins this close and reports any teardown error.
        void cancelledClose.catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          assertGeneration();
          const receipt = await rpc.mainCall("developmentClientExecutor.consumeAttestation", [
            { requestId },
          ]);
          signal.throwIfAborted();
          if (receipt) return receipt;
          await delay(100);
        }
        throw Object.assign(new Error("Isolated development client did not attest before expiry"), {
          code: "EEXECUTOR_TIMEOUT",
        });
      } finally {
        signal.removeEventListener("abort", abort);
        await (cancelledClose ?? rpc.close());
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
