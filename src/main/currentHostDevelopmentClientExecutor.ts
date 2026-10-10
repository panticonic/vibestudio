import { spawn, type ChildProcess } from "node:child_process";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerClient } from "./serverClient.js";
import { developmentClientExecutorMethods } from "@vibestudio/service-schemas/developmentClientExecutor";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";
import { createOwnedProcessGroupReceiver } from "@vibestudio/shared/ownedProcessRegistration";

const MARKER = ".vibestudio-development-client.json";
const CHUNK_BYTES = 1024 * 1024;

type ExecutorClient = TypedServiceClient<typeof developmentClientExecutorMethods>;
type LaunchClaim = Awaited<ReturnType<ExecutorClient["claim"]>>;

interface OwnedClient {
  requestId: string;
  child: ChildProcess;
  root: string;
  completion: Promise<void> | null;
  group: OwnedProcessGroup;
  registered: ReturnType<typeof createOwnedProcessGroupReceiver> | null;
  retirement: Promise<void> | null;
}

export class CurrentHostDevelopmentClientExecutor {
  private readonly children = new Map<string, OwnedClient>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly heartbeatRegistrations = new Set<Promise<void>>();
  private closed = false;
  private readonly pendingLaunches = new Map<string, Promise<void>>();
  private startup: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private readonly executorDigest: string;
  private readonly providerId: string;
  private readonly executor: ExecutorClient;

  constructor(
    private readonly deps: {
      client: Pick<ServerClient, "call">;
      stateRoot: string;
      electronExecutable?: string;
      spawnProcess?: typeof spawn;
      /** Native dependency realm a launched client resolves through. */
      nativeModulesRoot?: string | null;
      /** Argv this executor was started with, for device-scoped switches. */
      processArgv?: readonly string[];
      now?: () => number;
      log?: (message: string) => void;
    }
  ) {
    this.executor = createTypedServiceClient(
      "developmentClientExecutor",
      developmentClientExecutorMethods,
      (service, method, args) => deps.client.call(service, method, args)
    );
    const executable = fs.realpathSync(deps.electronExecutable ?? process.execPath);
    this.executorDigest = sha256(fs.readFileSync(executable));
    this.providerId = `electron-${this.executorDigest.slice(0, 24)}`;
  }

  start(): Promise<void> {
    if (this.closed)
      return Promise.reject(coded("ESHUTDOWN", "Development client executor is closed"));
    this.startup ??= this.startOnce();
    return this.startup;
  }

  private async startOnce(): Promise<void> {
    await this.register();
    if (this.closed) return;
    this.heartbeat = setInterval(() => {
      const registration = this.register().catch((error) => {
        if (this.closed) return;
        this.deps.log?.(`Development client executor heartbeat failed: ${message(error)}`);
      });
      this.heartbeatRegistrations.add(registration);
      void registration.then(() => {
        this.heartbeatRegistrations.delete(registration);
      });
    }, 20_000);
    this.heartbeat.unref();
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const inflight = await Promise.allSettled([
      this.startup,
      ...this.heartbeatRegistrations,
      ...this.pendingLaunches.values(),
    ]);
    const retired = await Promise.allSettled(
      [...this.children.entries()].map(async ([requestId, owned]) => {
        await this.retireClient(owned);
        await this.reportExit(requestId, owned.child.exitCode, owned.child.signalCode);
      })
    );
    const failures = [...inflight, ...retired].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length)
      throw Object.assign(
        new AggregateError(failures, "Development client executor retirement failed"),
        { code: "EOWNERSHIP" }
      );
  }

  handleLaunchRequest(payload: unknown): Promise<void> {
    if (this.closed)
      return Promise.reject(coded("ESHUTDOWN", "Development client executor is closed"));
    const requestId = requestIdFrom(payload);
    const pending = this.pendingLaunches.get(requestId);
    if (pending) return pending;
    const owned = this.children.get(requestId);
    if (owned) return owned.completion ?? Promise.resolve();
    const operation = this.executeLaunchRequest(payload);
    this.pendingLaunches.set(requestId, operation);
    return operation.finally(() => {
      this.pendingLaunches.delete(requestId);
    });
  }

  private async executeLaunchRequest(payload: unknown): Promise<void> {
    const requestId = requestIdFrom(payload);
    let preparedRoot: string | null = null;
    let launchedClient: OwnedClient | null = null;
    try {
      if (this.closed) throw coded("ESHUTDOWN", "Development client executor is closed");
      const claim = await this.executor.claim({ requestId });
      if (claim.requestId !== requestId || claim.expiresAt <= this.now()) {
        throw coded("ESTALE", "Development client launch request expired");
      }
      if (this.closed) throw coded("ESHUTDOWN", "Development client executor is closing");
      const root = await this.materialize(claim);
      preparedRoot = root;
      if (this.closed) throw coded("ESHUTDOWN", "Development client executor is closing");
      const child = await this.launch(root, claim);
      const group = OwnedProcessGroup.create(child);
      const registered = group.identity
        ? createOwnedProcessGroupReceiver(
            child,
            group.identity,
            (identity) => OwnedProcessGroup.adopt(identity),
            { forwardToParent: typeof process.send === "function" }
          )
        : null;
      launchedClient = {
        requestId,
        child,
        root,
        group,
        registered,
        retirement: null,
        completion: null,
      };
      this.children.set(requestId, launchedClient);
      const identity = group.identity;
      if (!identity)
        throw coded(
          "EEXECUTOR_UNAVAILABLE",
          "Durable client ownership is unavailable on this platform"
        );
      child.once("exit", (exitCode, signal) => {
        void this.reportExit(requestId, exitCode, signal).catch((error) => {
          this.deps.log?.(`Development client exit receipt failed: ${message(error)}`);
        });
      });
      if (this.closed) throw coded("ESHUTDOWN", "Development client executor is closing");
      fs.writeFileSync(
        path.join(root, MARKER),
        `${JSON.stringify({
          version: 1,
          requestId,
          executionDigest: claim.executionDigest,
          identity,
        })}\n`,
        { mode: 0o600 }
      );
      const ownershipDigest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
      await this.executor.launched({
        requestId,
        childPid: identity.pid,
        ownershipDigest,
      });
    } catch (error) {
      const owned = launchedClient ?? this.children.get(requestId);
      if (owned) {
        await this.completeClient(owned, async (cleanupError) => {
          const failure = cleanupError
            ? Object.assign(
                new AggregateError([error, cleanupError], "Client launch and retirement failed"),
                { code: "EOWNERSHIP" }
              )
            : error;
          await this.executor.fail({
            requestId,
            failure: Object.assign(serializeRpcFailure(failure), { code: code(failure) }),
          });
        });
        return;
      }
      let failure = error;
      try {
        if (preparedRoot && fs.existsSync(preparedRoot)) {
          cleanupOwnedRoot(this.deps.stateRoot, preparedRoot, requestId);
        }
      } catch (cleanupError) {
        failure = Object.assign(
          new AggregateError(
            [error, cleanupError],
            "Development client launch and retirement failed"
          ),
          { code: "EOWNERSHIP" }
        );
      }
      await this.executor.fail({
        requestId,
        failure: Object.assign(serializeRpcFailure(failure), { code: code(failure) }),
      });
    }
  }

  async handleStopRequest(payload: unknown): Promise<void> {
    const requestId = requestIdFrom(payload);
    const owned = this.children.get(requestId);
    if (!owned?.child.pid) return;
    const expectedPid =
      payload && typeof payload === "object"
        ? (payload as { childPid?: unknown }).childPid
        : undefined;
    if (expectedPid !== owned.child.pid) {
      throw coded("EOWNERSHIP", "Development client stop PID does not match its launch");
    }
    await this.retireClient(owned);
    await this.reportExit(requestId, owned.child.exitCode, owned.child.signalCode);
  }

  private async register(): Promise<void> {
    await this.executor.register({
      providerId: this.providerId,
      platform: process.platform,
      arch: process.arch,
      executorDigest: this.executorDigest,
    });
  }

  private async materialize(claim: LaunchClaim): Promise<string> {
    const root = path.join(this.deps.stateRoot, claim.requestId);
    assertOwnedRootCoordinate(this.deps.stateRoot, root);
    fs.mkdirSync(this.deps.stateRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(root, { mode: 0o700 });
    try {
      fs.writeFileSync(
        path.join(root, MARKER),
        `${JSON.stringify({
          version: 1,
          requestId: claim.requestId,
          executionDigest: claim.executionDigest,
        })}\n`,
        { mode: 0o600, flag: "wx" }
      );
      const seen = new Set<string>();
      for (const artifact of claim.artifacts) {
        const relative = canonicalArtifactPath(artifact.path);
        if (seen.has(relative)) throw coded("EARTIFACT_DRIFT", "Duplicate client artifact path");
        seen.add(relative);
        const target = path.join(root, ...relative.split("/"));
        assertOwnedRootCoordinate(root, target);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(target, "wx", 0o600);
        const hash = createHash("sha256");
        let offset = 0;
        try {
          while (offset < artifact.byteLength) {
            if (this.closed)
              throw coded("ESHUTDOWN", "Client materialization cancelled by owner closure");
            const chunk = await this.executor.readArtifact({
              requestId: claim.requestId,
              path: artifact.path,
              offset,
              length: Math.min(CHUNK_BYTES, artifact.byteLength - offset),
            });
            if (this.closed)
              throw coded("ESHUTDOWN", "Client materialization cancelled by owner closure");
            const bytes = Buffer.from(chunk.base64, "base64");
            if (bytes.length === 0 || chunk.nextOffset !== offset + bytes.length) {
              throw coded("EARTIFACT_DRIFT", "Client artifact transport returned a bad range");
            }
            fs.writeSync(fd, bytes);
            hash.update(bytes);
            offset = chunk.nextOffset;
            if (chunk.eof !== (offset === artifact.byteLength)) {
              throw coded("EARTIFACT_DRIFT", "Client artifact transport returned a bad EOF");
            }
          }
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (`sha256-${hash.digest("hex")}` !== artifact.integrity) {
          throw coded("EARTIFACT_DRIFT", `Client artifact integrity failed: ${artifact.path}`);
        }
        fs.chmodSync(target, artifact.path === "dist/main.cjs" ? 0o500 : 0o400);
      }
      if (!seen.has("dist/main.cjs")) {
        throw coded("EARTIFACT_DRIFT", "Client bundle has no exact main entry");
      }
      fs.writeFileSync(
        path.join(root, "package.json"),
        `${JSON.stringify({
          name: "vibestudio-development-client",
          private: true,
          main: "dist/main.cjs",
        })}\n`,
        { mode: 0o400, flag: "wx" }
      );
      linkNativeDependencies(root, this.deps.nativeModulesRoot ?? nativeModulesRoot());
      return root;
    } catch (error) {
      // The factory owns this newly created directory; no child has been
      // launched. Roll back partial bytes even if marker creation failed.
      try {
        fs.rmSync(root, { recursive: true });
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError([error, cleanupError], "Client materialization rollback failed"),
          { code: "EOWNERSHIP" }
        );
      }
      throw error;
    }
  }

  private async launch(root: string, claim: LaunchClaim): Promise<ChildProcess> {
    const executable = fs.realpathSync(this.deps.electronExecutable ?? process.execPath);
    if (sha256(fs.readFileSync(executable)) !== this.executorDigest) {
      throw coded("EEXECUTOR_DRIFT", "Electron executor changed after registration");
    }
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const child = (this.deps.spawnProcess ?? spawn)(
      executable,
      [
        ...inheritedDeviceSwitches(this.deps.processArgv ?? process.argv),
        `--user-data-dir=${profile}`,
        root,
        claim.pairingDeepLink,
      ],
      {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: clientEnvironment(claim),
        windowsHide: true,
      }
    );
    // spawn() returns before the kernel launch result. Its error is asynchronous;
    // a failed launch still owns an IPC handle until ChildProcess emits close.
    return await new Promise<ChildProcess>((resolve, reject) => {
      let failure: Error | null = null;
      const onError = (error: Error) => {
        failure = error;
      };
      const onClose = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        reject(failure ?? coded("ESPAWN", "Client closed before its spawn receipt"));
      };
      const onSpawn = () => {
        child.off("close", onClose);
        child.off("error", onError);
        resolve(child);
      };
      child.once("error", onError);
      child.once("close", onClose);
      child.once("spawn", onSpawn);
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private retireClient(owned: OwnedClient): Promise<void> {
    owned.retirement ??= (async () => {
      const results = await Promise.allSettled([owned.group.retire(), owned.registered?.close()]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length)
        throw Object.assign(
          new AggregateError(failures, "Development client resources did not retire"),
          { code: "EOWNERSHIP" }
        );
      cleanupOwnedRoot(this.deps.stateRoot, owned.root, owned.requestId);
    })();
    return owned.retirement;
  }

  private reportExit(
    requestId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const owned = this.children.get(requestId);
    const childPid = owned?.child.pid;
    if (!owned || childPid === undefined) return Promise.resolve();
    return this.completeClient(owned, async (cleanupError) => {
      await this.executor.exited({
        requestId,
        childPid,
        exitCode,
        signal,
        ...(cleanupError ? { cleanupError: serializeRpcFailure(cleanupError) } : {}),
      });
    });
  }

  private completeClient(
    owned: OwnedClient,
    report: (cleanupError: unknown | null) => Promise<void>
  ): Promise<void> {
    // Select the terminal path before signaling the native group: termination
    // can produce an exit event while a failed launch is still completing.
    owned.completion ??= Promise.resolve().then(async () => {
      let cleanupError: unknown | null = null;
      try {
        await this.retireClient(owned);
      } catch (error) {
        cleanupError = error;
      }
      try {
        await report(cleanupError);
      } catch (error) {
        if (cleanupError !== null) {
          throw Object.assign(
            new AggregateError(
              [cleanupError, error],
              "Development client retirement and receipt delivery failed",
              { cause: cleanupError }
            ),
            { code: "EOWNERSHIP" }
          );
        }
        throw error;
      } finally {
        // Failed receipt delivery must not retain an already retired client.
        // Retirement failures retain their known owner/root for diagnosis.
        if (!cleanupError) this.children.delete(owned.requestId);
      }
      if (cleanupError)
        throw Object.assign(
          new Error("Development client resources did not retire", { cause: cleanupError }),
          { code: "EOWNERSHIP" }
        );
    });
    return owned.completion;
  }
}

/**
 * Electron switches that describe this device rather than this app instance.
 *
 * Which secret store holds a device credential is a property of the session
 * the executor was started in, and a client it launches saves its own
 * credential into that same store before it can pair at all. Without the
 * selection the launched client finds no usable store, refuses to pair, and
 * exits — leaving the run to report an executor that never completed it.
 */
function inheritedDeviceSwitches(argv: readonly string[]): string[] {
  return argv.filter((argument) => argument.startsWith("--password-store="));
}

/**
 * Where this executor's own native dependencies are installed.
 *
 * A client bundle resolves native modules next to itself, which is how an
 * installed host finds them. A development client is materialized into a
 * private directory with nothing next to it, so it cannot open the Iroh
 * transport it is told to pair over and exits before readiness.
 */
function nativeModulesRoot(): string | null {
  try {
    // <root>/node_modules/@number0/iroh/package.json
    return path.resolve(path.dirname(require.resolve("@number0/iroh/package.json")), "..", "..");
  } catch {
    return null;
  }
}

/**
 * Point the client at them, rather than copying a native realm per launch.
 *
 * The executor and the client it launches are the same build on the same
 * device — the executor refuses to launch a binary whose digest differs from
 * its own — so the modules it resolves are exactly the ones the client needs.
 * The host build already stages each of its generations this way.
 */
function linkNativeDependencies(root: string, modulesRoot: string | null): void {
  if (!modulesRoot || !fs.existsSync(modulesRoot)) return;
  const link = path.join(root, "node_modules");
  assertOwnedRootCoordinate(root, link);
  fs.symlinkSync(modulesRoot, link, "junction");
}

function clientEnvironment(claim: LaunchClaim): NodeJS.ProcessEnv {
  const allowed = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "HOME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env["VIBESTUDIO_DEVELOPMENT_LAUNCH_REQUEST"] = claim.requestId;
  env["VIBESTUDIO_DEVELOPMENT_EXECUTION_DIGEST"] = claim.executionDigest;
  env["VIBESTUDIO_DEVELOPMENT_MAIN_BUILD_ID"] = claim.mainEntryBuildId;
  return env;
}

function canonicalArtifactPath(value: string): string {
  if (
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw coded("EARTIFACT_DRIFT", "Client artifact path is not canonical");
  }
  return value;
}

function assertOwnedRootCoordinate(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw coded("EOWNERSHIP", "Development client path escaped its owned root");
  }
}

function cleanupOwnedRoot(stateRoot: string, root: string, requestId: string): void {
  assertOwnedRootCoordinate(stateRoot, root);
  const markerPath = path.join(root, MARKER);
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
    version?: unknown;
    requestId?: unknown;
  };
  if (marker.version !== 1 || marker.requestId !== requestId) {
    throw coded("EOWNERSHIP", "Development client root marker does not match its request");
  }
  fs.rmSync(root, { recursive: true });
}

function requestIdFrom(payload: unknown): string {
  const value =
    payload && typeof payload === "object"
      ? (payload as { requestId?: unknown }).requestId
      : undefined;
  if (typeof value !== "string" || !/^development-client-[a-f0-9]{32}$/u.test(value)) {
    throw coded("EINVAL", "Development client request id is invalid");
  }
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function code(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "ECLIENT_EXECUTOR";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coded(errorCode: string, errorMessage: string): Error {
  return Object.assign(new Error(errorMessage), { code: errorCode });
}
