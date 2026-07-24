#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  clearDevInstanceReady,
  createEphemeralInstanceRoot,
  generatedInstanceId,
  persistentInstanceRoot,
  publishDevInstanceReady,
  registerDevInstance,
  removeEphemeralInstanceRoot,
  unregisterDevInstance,
  type DevInstanceRecord,
} from "./instanceRegistry.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const READY_TIMEOUT_MS = 5 * 60_000;

type Mode = DevInstanceRecord["kind"];

function extractInstance(argv: string[]): { instanceId?: string; forwarded: string[] } {
  const forwarded: string[] = [];
  let instanceId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
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
    forwarded.push(arg);
  }
  return { ...(instanceId ? { instanceId } : {}), forwarded };
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === name) return argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function run(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; allowFailure?: boolean }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${path.basename(command)} exited on ${signal}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${path.basename(command)} exited with code ${exitCode}`));
        return;
      }
      resolve(exitCode);
    });
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + (process.platform === "win32" ? 0 : 1));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function waitForReady(file: string, child: ChildProcess): Promise<unknown> {
  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Vibestudio server exited before publishing readiness");
    }
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for Vibestudio readiness at ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function forwardSignals(child: ChildProcess): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

async function runServer(
  forwarded: string[],
  env: NodeJS.ProcessEnv,
  instance: DevInstanceRecord
): Promise<number> {
  // credentialStore/environment paths are resolved at module evaluation time.
  // Load the bootstrap only after main() has installed this instance's process
  // environment, so an ephemeral server can never mistake the developer's
  // ordinary CLI credential for its own.
  const { bootstrapInstanceCli } = await import("./bootstrapInstanceCli.js");
  await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
  const configuredReadyFile = optionValue(forwarded, "--ready-file");
  const readyFile =
    configuredReadyFile ?? path.join(instance.root, "server-auth", "hub-ready.json");
  fs.rmSync(readyFile, { force: true });
  const serverArgs = configuredReadyFile ? forwarded : [...forwarded, "--ready-file", readyFile];
  const child = spawn(process.execPath, [tsxCli, "src/server/index.ts", ...serverArgs], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    // The supervisor is the terminal's sole signal recipient. Otherwise Ctrl-C
    // reaches both processes and the forwarded second SIGINT escalates an
    // already-ordered hub shutdown into a forced child-tree kill.
    detached: process.platform !== "win32",
  });
  const stopForwarding = forwardSignals(child);
  try {
    const ready = await waitForReady(readyFile, child);
    const bootstrap = await bootstrapInstanceCli(ready);
    publishDevInstanceReady(instance, bootstrap);
    if (bootstrap.status === "invite-required") {
      console.warn(
        `[instance:${instance.id}] CLI is not paired. Create a device invite, then run ` +
          `\`pnpm cli --instance ${instance.id} remote pair <invite>\`.`
      );
    } else {
      console.log(
        `[instance:${instance.id}] CLI ${bootstrap.status}; workspace=${bootstrap.workspaceName}`
      );
    }
    return await waitForExit(child);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child).catch(() => undefined);
    throw error;
  } finally {
    stopForwarding();
  }
}

async function runDesktop(forwarded: string[], env: NodeJS.ProcessEnv): Promise<number> {
  await run(process.execPath, ["build.mjs"], { env });
  // Preserve the existing non-blocking developer typecheck, but make it an
  // owned child of this instance instead of a leaked shell background job.
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const realTypeCheck = spawn(pnpmCommand, ["type-check"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  const electron = spawn(process.execPath, ["scripts/run-electron.mjs", ...forwarded], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  const stopForwarding = forwardSignals(electron);
  try {
    return await waitForExit(electron);
  } finally {
    stopForwarding();
    if (realTypeCheck.exitCode === null && realTypeCheck.signalCode === null) {
      realTypeCheck.kill("SIGTERM");
    }
  }
}

async function main(): Promise<void> {
  const rawMode = process.argv[2];
  if (rawMode !== "desktop" && rawMode !== "server") {
    throw new Error("usage: runInstance.ts desktop|server [options]");
  }
  const mode: Mode = rawMode;
  const repoRoot = fs.realpathSync(process.cwd());
  const parsed = extractInstance(process.argv.slice(3));
  if (mode === "server" && hasFlag(parsed.forwarded, "--help")) {
    console.log(`Developer instance options:
  --instance <id>  Use a named persistent isolated instance (default: source)
  --ephemeral      Use an isolated temporary instance; combine with --instance
                   to give parallel CLI commands a stable target
`);
    const env = { ...process.env, NODE_ENV: "development" };
    await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
    process.exitCode = await run(
      process.execPath,
      [tsxCli, "src/server/index.ts", ...parsed.forwarded],
      { env }
    );
    return;
  }
  const disposable = hasFlag(parsed.forwarded, "--ephemeral");
  const id = parsed.instanceId ?? (disposable ? generatedInstanceId(mode) : "source");
  const root = disposable ? createEphemeralInstanceRoot(id) : persistentInstanceRoot(repoRoot, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const instance = registerDevInstance({
    id,
    root,
    repoRoot,
    supervisorPid: process.pid,
    kind: mode,
    lifecycle: disposable ? "ephemeral" : "persistent",
    startedAt: Date.now(),
  });
  // Only the lock owner may mutate this instance's readiness marker. Once the
  // new generation is registered, concurrent CLI readers reject the old
  // generation even in the brief interval before this unlink.
  if (mode === "server") clearDevInstanceReady(instance);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    VIBESTUDIO_INSTANCE_ROOT: root,
    VIBESTUDIO_INSTANCE: id,
    // Exactly one developer instance is coupled to the checkout template.
    // Every named/ephemeral peer owns only its copied workspace state.
    VIBESTUDIO_SOURCE_INSTANCE: id === "source" && !disposable ? "1" : "0",
  };
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = root;
  process.env["VIBESTUDIO_INSTANCE"] = id;
  process.env["VIBESTUDIO_SOURCE_INSTANCE"] = env["VIBESTUDIO_SOURCE_INSTANCE"];

  console.log(`[instance:${id}] ${instance.lifecycle} ${mode} state: ${root}`);
  console.log(`[instance:${id}] CLI: pnpm cli --instance ${id} <command>`);
  try {
    process.exitCode =
      mode === "server"
        ? await runServer(parsed.forwarded, env, instance)
        : await runDesktop(parsed.forwarded, env);
  } finally {
    const cleanupError = disposable ? removeEphemeralInstanceRoot(root) : null;
    if (cleanupError) {
      // Preserve the registry record and root together: the stale supervisor
      // PID makes the instance unusable, while retaining the exact root makes
      // a leaked descendant diagnosable. Most importantly, cleanup must not
      // replace the hub's original exit status with a bare ENOTEMPTY.
      console.error(
        `[instance:${id}] could not remove ephemeral state ${root}: ${cleanupError.message}`
      );
      process.exitCode = process.exitCode || 1;
    } else {
      unregisterDevInstance(repoRoot, id);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
