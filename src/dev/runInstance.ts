#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
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
import { resolveDevelopmentBaseSelection } from "./developmentBaseSelection.js";
import { developmentInstanceEnvironment } from "./developmentInstanceEnvironment.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

type Mode = DevInstanceRecord["kind"];

async function prunePersistentInstanceBuildCache(root: string, instanceId: string): Promise<void> {
  const buildCacheRoot = path.join(root, "build-cache");
  const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(buildCacheRoot));
  try {
    const result = await coordinator.prune(buildCacheRoot);
    if (result.removedEntries > 0) {
      console.log(
        `[instance:${instanceId}] pruned ${result.removedEntries} cached builds ` +
          `(${(result.removedBytes / 1024 ** 3).toFixed(2)} GiB)`
      );
    }
    const cas = pruneUnreferencedInstanceCas(path.join(root, "cas"));
    if (cas.removedFiles > 0) {
      console.log(
        `[instance:${instanceId}] pruned ${cas.removedFiles} unreferenced CAS blobs ` +
          `(${(cas.removedBytes / 1024 ** 3).toFixed(2)} GiB)`
      );
    }
  } catch (error) {
    console.warn(
      `[instance:${instanceId}] build-cache pruning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    coordinator.close();
  }
}

function pruneUnreferencedInstanceCas(root: string): {
  removedFiles: number;
  removedBytes: number;
} {
  const shaRoot = path.join(root, "sha256");
  let removedFiles = 0;
  let removedBytes = 0;
  const pending = [shaRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const storedPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(storedPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(storedPath);
      if (stat.nlink !== 1) continue;
      fs.unlinkSync(storedPath);
      removedFiles += 1;
      removedBytes += stat.blocks * 512 || stat.size;
    }
  }
  return { removedFiles, removedBytes };
}

function extractInstance(argv: string[]): {
  instanceId?: string;
  baseCheckout?: string;
  productionBase: boolean;
  forwarded: string[];
} {
  const forwarded: string[] = [];
  let instanceId: string | undefined;
  let baseCheckout: string | undefined;
  let productionBase = false;
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
    if (arg === "--base-checkout") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base-checkout requires a path");
      if (baseCheckout) throw new Error("--base-checkout may only be specified once");
      baseCheckout = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--base-checkout=")) {
      if (baseCheckout) throw new Error("--base-checkout may only be specified once");
      baseCheckout = arg.slice("--base-checkout=".length);
      if (!baseCheckout) throw new Error("--base-checkout requires a path");
      continue;
    }
    if (arg === "--production-base") {
      if (productionBase) throw new Error("--production-base may only be specified once");
      productionBase = true;
      continue;
    }
    forwarded.push(arg);
  }
  return {
    ...(instanceId ? { instanceId } : {}),
    ...(baseCheckout ? { baseCheckout } : {}),
    productionBase,
    forwarded,
  };
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
  await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], { env });
  await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
  const configuredReadyFile = optionValue(forwarded, "--ready-file");
  const readyFile =
    configuredReadyFile ?? path.join(instance.root, "server-auth", "hub-ready.json");
  fs.rmSync(readyFile, { force: true });
  const serverArgs = configuredReadyFile ? forwarded : [...forwarded, "--ready-file", readyFile];
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: [tsxCli, "src/server/index.ts", ...serverArgs],
    env,
    stdio: "inherit",
    forwardParentSignals: true,
    readiness: {
      file: readyFile,
      async onReady(ready) {
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
      },
    },
  });
  await supervisor.start();
  return supervisor.wait();
}

async function runDesktop(forwarded: string[], env: NodeJS.ProcessEnv): Promise<number> {
  await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], { env });
  // Desktop launches share the repository host artifacts with parallel
  // developer instances. The coordinator waits for an in-flight build and
  // reuses its verified output; invoking build.mjs directly would clean the
  // shared dist/ while another instance is starting its workspace runtime.
  await run(process.execPath, ["scripts/ensure-host-build.mjs"], { env });
  // Preserve the existing non-blocking developer typecheck, but make it an
  // owned child of this instance instead of a leaked shell background job.
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const realTypeCheck = spawn(pnpmCommand, ["type-check"], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: ["scripts/run-electron.mjs", ...forwarded],
    env,
    stdio: "inherit",
    forwardParentSignals: true,
  });
  try {
    await supervisor.start();
    return await supervisor.wait();
  } finally {
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
  --base-checkout <path>
                   Boot from the checkout's visible worktree via a private checkpoint
  --production-base Ignore the configured checkout and boot the pinned Base release
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
  const checkpointTarget = path.join(root, "development-base-checkpoints", instance.generationId);
  try {
    const developmentBase =
      (await resolveDevelopmentBaseSelection({
        repoRoot,
        checkpointTarget,
        ...(parsed.baseCheckout ? { explicitCheckout: parsed.baseCheckout } : {}),
        productionBase: parsed.productionBase,
      })) ?? undefined;
    if (!parsed.productionBase && !developmentBase) {
      throw new Error(
        "No development Base checkout is configured. Run `pnpm dev:base setup`, " +
          "or select the shipped release explicitly with `pnpm dev:production`."
      );
    }
    const sourceCoupled = id === "source" && !disposable;
    const env = developmentInstanceEnvironment({
      parent: process.env,
      repoRoot,
      instanceRoot: root,
      instanceId: id,
      sourceCoupled,
      ...(developmentBase ? { base: developmentBase } : {}),
    });
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = root;
    process.env["VIBESTUDIO_INSTANCE"] = id;

    // Only the lock owner may mutate this instance's readiness marker. Once
    // registered, concurrent CLI readers reject an older generation.
    if (mode === "server") clearDevInstanceReady(instance);
    console.log(`[instance:${id}] ${instance.lifecycle} ${mode} state: ${root}`);
    console.log(`[instance:${id}] CLI: pnpm cli --instance ${id} <command>`);
    if (parsed.productionBase) {
      console.log(`[instance:${id}] Base: canonical pinned production release`);
    }
    if (developmentBase) {
      console.log(
        `[instance:${id}] Base candidate: ${developmentBase.pin.commit} from ${developmentBase.sourceCheckout}`
      );
      if (developmentBase.temporary) {
        console.log(
          `[instance:${id}] Base development checkpoint includes ${developmentBase.changedPaths.length} worktree change(s).`
        );
      }
      if (id === "source" && !disposable) {
        console.log(
          `[instance:${id}] Base write-back: protected publications -> ${developmentBase.sourceCheckout}`
        );
      }
    }
    if (!disposable) {
      await prunePersistentInstanceBuildCache(root, id);
    }
    process.exitCode =
      mode === "server"
        ? await runServer(parsed.forwarded, env, instance)
        : await runDesktop(parsed.forwarded, env);
  } finally {
    if (!disposable) await prunePersistentInstanceBuildCache(root, id);
    fs.rmSync(checkpointTarget, { recursive: true, force: true });
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
