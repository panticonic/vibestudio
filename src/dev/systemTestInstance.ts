import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  persistentInstanceRoot,
  resolveDevInstance,
  waitForDevInstanceReady,
  type DevInstanceReadyRecord,
  type DevInstanceRecord,
} from "./instanceRegistry.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const DEFAULT_SYSTEM_TEST_INSTANCE = "system-test";
const STARTUP_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 30_000;

type LauncherArgs = {
  instanceId: string;
  explicitInstance: boolean;
  bootstrapWorkspace?: string;
  command: string[];
};

type ManagedMarker = {
  schemaVersion: 1;
  instanceId: string;
  generationId: string;
  repoDigest: string;
};

export type EnsuredSystemTestInstance = {
  instance: DevInstanceRecord;
  ready: DevInstanceReadyRecord;
  created: boolean;
  managed: boolean;
  logFile?: string;
};

export function parseSystemTestLauncherArgs(argv: readonly string[]): LauncherArgs {
  let instanceId: string | undefined;
  let bootstrapWorkspace: string | undefined;
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (arg === "--instance") {
      const value = argv[index + 1];
      if (!value) throw new Error("--instance requires an id");
      if (instanceId) throw new Error("--instance may only be specified once");
      instanceId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance=")) {
      if (instanceId) throw new Error("--instance may only be specified once");
      instanceId = arg.slice("--instance=".length);
      if (!instanceId) throw new Error("--instance requires an id");
      continue;
    }
    if (arg === "--bootstrap-workspace") {
      const value = argv[index + 1];
      if (!value) throw new Error("--bootstrap-workspace requires a name");
      if (bootstrapWorkspace) throw new Error("--bootstrap-workspace may only be specified once");
      bootstrapWorkspace = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--bootstrap-workspace=")) {
      if (bootstrapWorkspace) throw new Error("--bootstrap-workspace may only be specified once");
      bootstrapWorkspace = arg.slice("--bootstrap-workspace=".length);
      if (!bootstrapWorkspace) throw new Error("--bootstrap-workspace requires a name");
      continue;
    }
    command.push(arg);
  }
  return {
    instanceId: instanceId ?? DEFAULT_SYSTEM_TEST_INSTANCE,
    explicitInstance: instanceId !== undefined,
    ...(bootstrapWorkspace ? { bootstrapWorkspace } : {}),
    command,
  };
}

function canonicalRepoRoot(repoRoot: string): string {
  return fs.realpathSync(path.resolve(repoRoot));
}

function repoDigest(repoRoot: string): string {
  return createHash("sha256").update(canonicalRepoRoot(repoRoot)).digest("hex").slice(0, 16);
}

function markerPath(instance: Pick<DevInstanceRecord, "root">): string {
  return path.join(instance.root, "system-test-managed.json");
}

function logPath(repoRoot: string, instanceId: string): string {
  const instanceRoot = persistentInstanceRoot(repoRoot, instanceId);
  return path.join(path.dirname(instanceRoot), "system-test-logs", `${instanceId}.log`);
}

function readManagedMarker(instance: DevInstanceRecord): ManagedMarker | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(markerPath(instance), "utf8")
    ) as Partial<ManagedMarker>;
    if (
      value.schemaVersion !== 1 ||
      value.instanceId !== instance.id ||
      value.generationId !== instance.generationId ||
      value.repoDigest !== repoDigest(instance.repoRoot)
    ) {
      return null;
    }
    return value as ManagedMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeManagedMarker(instance: DevInstanceRecord): void {
  const marker: ManagedMarker = {
    schemaVersion: 1,
    instanceId: instance.id,
    generationId: instance.generationId,
    repoDigest: repoDigest(instance.repoRoot),
  };
  fs.writeFileSync(markerPath(instance), `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
  });
}

function resolveRunning(repoRoot: string, instanceId: string): DevInstanceRecord | null {
  try {
    return resolveDevInstance(repoRoot, instanceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Unknown Vibestudio instance") ||
      message.includes("is no longer running")
    ) {
      return null;
    }
    throw error;
  }
}

function spawnManagedInstance(
  repoRoot: string,
  instanceId: string,
  outputFile: string,
  bootstrapWorkspace?: string
): void {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  const output = fs.openSync(outputFile, "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        "src/dev/runInstance.ts",
        "server",
        ...(bootstrapWorkspace ? [] : ["--ephemeral"]),
        "--instance",
        instanceId,
        ...(bootstrapWorkspace ? ["--bootstrap-workspace", bootstrapWorkspace] : []),
      ],
      {
        cwd: repoRoot,
        env: process.env,
        detached: true,
        stdio: ["ignore", output, output],
      }
    );
    child.once("error", () => undefined);
    child.unref();
  } finally {
    fs.closeSync(output);
  }
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitForRegistration(
  repoRoot: string,
  instanceId: string,
  timeoutMs: number
): Promise<DevInstanceRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const instance = resolveRunning(repoRoot, instanceId);
    if (instance) return instance;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for system-test instance ${JSON.stringify(instanceId)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function startupFailure(instanceId: string, logFile: string, reason: string): Error {
  return Object.assign(
    new Error(
      `Could not provision system-test instance ${JSON.stringify(instanceId)}: ${reason}. ` +
        `Supervisor log: ${logFile}`
    ),
    {
      classification: "infrastructure",
      recoverable: true,
      automaticRecovery: "create_ephemeral_instance",
      command: `pnpm system-test --instance ${instanceId} doctor`,
    }
  );
}

export async function ensureSystemTestInstance(
  repoRootInput: string,
  instanceId: string,
  options: {
    explicitInstance?: boolean;
    startupTimeoutMs?: number;
    bootstrapWorkspace?: string;
  } = {}
): Promise<EnsuredSystemTestInstance> {
  const repoRoot = canonicalRepoRoot(repoRootInput);
  let instance = resolveRunning(repoRoot, instanceId);
  let created = false;
  let outputFile: string | undefined;
  if (!instance) {
    outputFile = logPath(repoRoot, instanceId);
    spawnManagedInstance(repoRoot, instanceId, outputFile, options.bootstrapWorkspace);
    created = true;
    try {
      instance = await waitForRegistration(
        repoRoot,
        instanceId,
        options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
      );
    } catch (error) {
      throw startupFailure(
        instanceId,
        outputFile,
        error instanceof Error ? error.message : String(error)
      );
    }
  } else if (!options.explicitInstance && !readManagedMarker(instance)) {
    throw new Error(
      `System-test instance ${JSON.stringify(instanceId)} is already owned by another workflow. ` +
        `Choose a unique id with --instance.`
    );
  }
  if (instance.kind !== "server") {
    throw new Error(`System tests require a server instance; ${instanceId} is ${instance.kind}`);
  }
  if (created) writeManagedMarker(instance);
  const managed = readManagedMarker(instance) !== null;
  let ready: DevInstanceReadyRecord;
  try {
    ready = await timeout(
      waitForDevInstanceReady(instance),
      options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      `Timed out waiting for system-test instance ${JSON.stringify(instanceId)} to become ready`
    );
  } catch (error) {
    throw startupFailure(
      instanceId,
      outputFile ?? logPath(repoRoot, instanceId),
      error instanceof Error ? error.message : String(error)
    );
  }
  if (ready.status === "invite-required") {
    throw startupFailure(
      instanceId,
      outputFile ?? logPath(repoRoot, instanceId),
      "the server did not provide an automatically pairable development invite"
    );
  }
  if (options.bootstrapWorkspace && ready.workspaceName !== options.bootstrapWorkspace) {
    throw new Error(
      `System-test instance ${JSON.stringify(instanceId)} is attached to workspace ` +
        `${JSON.stringify(ready.workspaceName)}, not requested bootstrap workspace ` +
        `${JSON.stringify(options.bootstrapWorkspace)}`
    );
  }
  return { instance, ready, created, managed, ...(outputFile ? { logFile: outputFile } : {}) };
}

async function waitForStopped(instance: DevInstanceRecord, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!resolveRunning(instance.repoRoot, instance.id)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out stopping system-test instance ${JSON.stringify(instance.id)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stopManagedSystemTestInstance(
  repoRootInput: string,
  instanceId: string,
  timeoutMs = STOP_TIMEOUT_MS
): Promise<boolean> {
  const repoRoot = canonicalRepoRoot(repoRootInput);
  const instance = resolveRunning(repoRoot, instanceId);
  if (!instance) return false;
  if (!readManagedMarker(instance)) {
    throw new Error(
      `Refusing to stop instance ${JSON.stringify(instanceId)} because it was not created by pnpm system-test`
    );
  }
  process.kill(instance.supervisorPid, "SIGTERM");
  await waitForStopped(instance, timeoutMs);
  return true;
}
