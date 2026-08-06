import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerClient } from "./serverClient.js";
import { captureOwnedProcessIdentity } from "../dev/ownedProcessIdentity.js";

const MARKER = ".vibestudio-development-client.json";
const CHUNK_BYTES = 1024 * 1024;

interface LaunchClaim {
  requestId: string;
  runId: string;
  mainEntryBuildId: string;
  executionDigest: string;
  recipeId: string;
  artifacts: Array<{ path: string; integrity: string; byteLength: number }>;
  pairingDeepLink: string;
  expiresAt: number;
}

export class CurrentHostDevelopmentClientExecutor {
  private readonly children = new Map<
    string,
    {
      child: ChildProcess;
      root: string;
      exitReport: Promise<void> | null;
    }
  >();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly heartbeatRegistrations = new Set<Promise<void>>();
  private closed = false;
  private readonly executorDigest: string;
  private readonly providerId: string;

  constructor(
    private readonly deps: {
      client: Pick<ServerClient, "call">;
      stateRoot: string;
      electronExecutable?: string;
      spawnProcess?: typeof spawn;
      captureProcessIdentity?: typeof captureOwnedProcessIdentity;
      now?: () => number;
      log?: (message: string) => void;
    }
  ) {
    const executable = fs.realpathSync(deps.electronExecutable ?? process.execPath);
    this.executorDigest = sha256(fs.readFileSync(executable));
    this.providerId = `electron-${this.executorDigest.slice(0, 24)}`;
  }

  async start(): Promise<void> {
    this.closed = false;
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

  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await Promise.all(this.heartbeatRegistrations);
    await Promise.allSettled(
      [...this.children.entries()].map(async ([requestId, owned]) => {
        await stopChildGroup(owned.child);
        await this.reportExit(requestId, owned.child.exitCode, owned.child.signalCode);
      })
    );
  }

  async handleLaunchRequest(payload: unknown): Promise<void> {
    const requestId = requestIdFrom(payload);
    try {
      const claim = (await this.deps.client.call("developmentClientExecutor", "claim", [
        { requestId },
      ])) as LaunchClaim;
      if (claim.requestId !== requestId || claim.expiresAt <= this.now()) {
        throw coded("ESTALE", "Development client launch request expired");
      }
      const root = await this.materialize(claim);
      const child = this.launch(root, claim);
      this.children.set(requestId, { child, root, exitReport: null });
      const identity = (this.deps.captureProcessIdentity ?? captureOwnedProcessIdentity)(
        child.pid!
      );
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
      await this.deps.client.call("developmentClientExecutor", "launched", [
        {
          requestId,
          childPid: child.pid,
          ownershipDigest,
        },
      ]);
      child.once("exit", (exitCode, signal) => {
        void this.reportExit(requestId, exitCode, signal).catch((error) => {
          this.deps.log?.(`Development client exit receipt failed: ${message(error)}`);
        });
      });
    } catch (error) {
      const owned = this.children.get(requestId);
      if (owned) {
        await stopChildGroup(owned.child).catch(() => {});
        this.children.delete(requestId);
        try {
          cleanupOwnedRoot(this.deps.stateRoot, owned.root, requestId);
        } catch (cleanupError) {
          this.deps.log?.(`Development client launch cleanup failed: ${message(cleanupError)}`);
        }
      }
      await this.deps.client
        .call("developmentClientExecutor", "fail", [
          { requestId, code: code(error), message: message(error).slice(0, 2_000) },
        ])
        .catch(() => {});
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
    await stopChildGroup(owned.child);
    await this.reportExit(requestId, owned.child.exitCode, owned.child.signalCode);
  }

  private async register(): Promise<void> {
    await this.deps.client.call("developmentClientExecutor", "register", [
      {
        providerId: this.providerId,
        platform: process.platform,
        arch: process.arch,
        executorDigest: this.executorDigest,
      },
    ]);
  }

  private async materialize(claim: LaunchClaim): Promise<string> {
    const root = path.join(this.deps.stateRoot, claim.requestId);
    assertOwnedRootCoordinate(this.deps.stateRoot, root);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
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
          const chunk = (await this.deps.client.call("developmentClientExecutor", "readArtifact", [
            {
              requestId: claim.requestId,
              path: artifact.path,
              offset,
              length: Math.min(CHUNK_BYTES, artifact.byteLength - offset),
            },
          ])) as { base64: string; nextOffset: number; eof: boolean };
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
    return root;
  }

  private launch(root: string, claim: LaunchClaim): ChildProcess {
    const executable = fs.realpathSync(this.deps.electronExecutable ?? process.execPath);
    if (sha256(fs.readFileSync(executable)) !== this.executorDigest) {
      throw coded("EEXECUTOR_DRIFT", "Electron executor changed after registration");
    }
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const child = (this.deps.spawnProcess ?? spawn)(
      executable,
      [`--user-data-dir=${profile}`, root, claim.pairingDeepLink],
      {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: clientEnvironment(claim),
        windowsHide: true,
      }
    );
    if (!child.pid) throw coded("ESPAWN", "Electron executor returned no child PID");
    return child;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private reportExit(
    requestId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const owned = this.children.get(requestId);
    if (!owned?.child.pid) return Promise.resolve();
    if (owned.exitReport) return owned.exitReport;
    owned.exitReport = (async () => {
      let cleanupError: string | undefined;
      try {
        cleanupOwnedRoot(this.deps.stateRoot, owned.root, requestId);
      } catch (error) {
        cleanupError = message(error).slice(0, 2_000);
      }
      await this.deps.client.call("developmentClientExecutor", "exited", [
        {
          requestId,
          childPid: owned.child.pid,
          exitCode,
          signal,
          ...(cleanupError ? { cleanupError } : {}),
        },
      ]);
      this.children.delete(requestId);
    })();
    return owned.exitReport;
  }
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

async function stopChildGroup(child: ChildProcess): Promise<void> {
  signalChild(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited) {
    signalChild(child, "SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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
