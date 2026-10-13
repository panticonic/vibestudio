import { getNativeExecutionInstallation } from "@vibestudio/shared/runtimePaths";
import { prepareNativeRuntime } from "@vibestudio/shared/nativeRuntimeResources";
import { materializeImmutableTree } from "./buildV2/immutableTreeMaterializer.js";
import { ImmutableTreeWorkerClient } from "./buildV2/immutableTreeWorkerClient.js";
import {
  waitForNativeJob,
  type NativeWorkspaceJob,
  type NativeDependencyAdmission,
  type NativeDependencyResources,
} from "./nativeWorkspaceJob.js";
import { mkdir, realpath, copyFile, lstat, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  WorkspaceRuntime,
  type ProcessAdapter,
  type ProcessAdapterOptions,
} from "@vibestudio/process-adapter";
import { createFsDiskPort } from "./services/fsDiskPort.js";
import {
  resolveNativeTypeScriptServerPath,
  resolveRequiredHostArtifactRoot,
  TYPESCRIPT_SERVER_PATH_ENV,
} from "./appRoot.js";
import { stateLayout } from "./stateLayout.js";

function hasOwnershipFailure(error: unknown, seen = new Set<object>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const fields = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  return (
    fields.code === "EOWNERSHIP" ||
    hasOwnershipFailure(fields.cause, seen) ||
    (Array.isArray(fields.errors) &&
      fields.errors.some((child) => hasOwnershipFailure(child, seen)))
  );
}

/** Installed owner of a workspace's single native domain. The containing state
 * directory is an ownership anchor, never itself a guest resource grant. */
export async function startNativeWorkspaceRuntime(input: {
  workspaceId: string;
  statePath: string;
  sourceRoot: string;
  scratchRoot: string;
  buildsRoot: string;
  appRoot: string;
}) {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error(`Unsupported native isolation platform: ${platform}`);
  const privateRoot = await realpath(input.statePath);
  const ownedPath = (resource: string): string => {
    const relative = path.relative(path.resolve(input.statePath), path.resolve(resource));
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("Native resources must be below the protected workspace state root");
    return path.join(privateRoot, relative);
  };
  const scratchRoot = ownedPath(input.scratchRoot);
  const sourceRoot = ownedPath(input.sourceRoot);
  const buildsRoot = ownedPath(input.buildsRoot);
  const providerInputsRoot = ownedPath(stateLayout(input.statePath).buildProviderInputsDir);
  const incarnation = randomUUID();
  const runtimeRoot = path.join(privateRoot, "native-runtime", incarnation);
  const home = path.join(privateRoot, "scratch", "home");
  const extensionStorage = path.join(privateRoot, "extensions", "storage", input.workspaceId);
  let runtimeRootCreated = false;
  const runtimeRootSetup = async () => {
    await mkdir(path.dirname(runtimeRoot), { recursive: true });
    await mkdir(runtimeRoot);
    runtimeRootCreated = true;
    for (const directory of [
      runtimeRoot,
      home,
      sourceRoot,
      scratchRoot,
      buildsRoot,
      providerInputsRoot,
      extensionStorage,
    ]) {
      await mkdir(directory, { recursive: true });
      if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory)
        throw new Error("Native resource anchors must be canonical directories owned by the host");
    }
    const installedRequire = createRequire(path.join(input.appRoot, "package.json"));
    const artifacts = resolveRequiredHostArtifactRoot();
    const workerEntry = path.join(runtimeRoot, "fs-disk-worker.cjs");
    const workspaceEntry = path.join(runtimeRoot, "workspaceChild.js");
    const extensionEntry = path.join(runtimeRoot, "extensionChild.js");
    const copied = await Promise.allSettled([
      copyFile(path.join(artifacts, "extension-child.mjs"), extensionEntry),
      copyFile(path.join(artifacts, "workspace-child.mjs"), workspaceEntry),
      copyFile(path.join(artifacts, "fs-disk-worker.cjs"), workerEntry),
    ]);
    const copyFailures = copied.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (copyFailures.length === 1) throw copyFailures[0];
    if (copyFailures.length > 1)
      throw new AggregateError(copyFailures, "Native workspace bootstrap copies failed", {
        cause: copyFailures[0],
      });
    await writeFile(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
    const { rgPath } = installedRequire("@vscode/ripgrep") as { rgPath: string };
    const ripgrep = path.join(runtimeRoot, platform === "win32" ? "rg.exe" : "rg");
    await copyFile(rgPath, ripgrep);
    // The installed compiler is an executable plus adjacent standard libraries.
    // Admit that complete immutable resource into the workspace's native domain;
    // bundled API clients cannot resolve it relative to their generated bundle.
    const installedCompiler = await realpath(resolveNativeTypeScriptServerPath(input.appRoot));
    const compilerRoot = path.join(runtimeRoot, "typescript");
    await materializeImmutableTree(path.dirname(installedCompiler), compilerRoot);
    const compiler = path.join(compilerRoot, path.basename(installedCompiler));
    const runtime = prepareNativeRuntime({ appRoot: input.appRoot, runtimeRoot, platform });
    const { executable } = runtime;
    const identity = createHash("sha256");
    for (const resource of [workspaceEntry, workerEntry, extensionEntry, compiler])
      identity.update(await readFile(resource));
    const sandbox = await WorkspaceRuntime.start(
      {
        version: 1,
        owner: {
          workspaceId: input.workspaceId,
          contextId: null,
          runtimeId: `native:${input.workspaceId}`,
          incarnation,
          executionDigest: identity.digest("hex"),
        },
        executable,
        privateRoot,
        args: [],
        cwd: home,
        home,
        environment: {
          PATH: [
            path.dirname(executable),
            runtimeRoot,
            ...(platform === "win32"
              ? (process.env["PATH"] ?? process.env["Path"] ?? "").split(path.delimiter)
              : ["/usr/bin", "/bin"]),
          ].join(path.delimiter),
          LANG: "C.UTF-8",
          ...runtime.environment,
          [TYPESCRIPT_SERVER_PATH_ENV]: compiler,
        },
        read: [...runtime.readPaths, sourceRoot, buildsRoot, providerInputsRoot],
        // These are owner-selected anchors, never the destinations of guest links.
        // Unix MXC enforces these grants; Windows uses normal host permissions.
        write: [home, scratchRoot, extensionStorage],
        sockets: [],
      },
      {
        ...getNativeExecutionInstallation(input.appRoot),
        workspaceEntry,
      }
    );
    return { sandbox, workerEntry, ripgrep, extensionEntry, executable };
  };

  let runtimeSetup: Awaited<ReturnType<typeof runtimeRootSetup>>;
  try {
    runtimeSetup = await runtimeRootSetup();
  } catch (operationFailure) {
    const failures: unknown[] = [];
    try {
      if (runtimeRootCreated && !hasOwnershipFailure(operationFailure))
        await rm(runtimeRoot, { recursive: true, force: true });
    } catch (cleanupFailure) {
      failures.push(cleanupFailure);
    }
    if (failures.length > 0)
      throw new AggregateError(
        [operationFailure, ...failures],
        "Native workspace startup and partial-resource cleanup failed",
        { cause: operationFailure }
      );
    throw operationFailure;
  }

  const { sandbox, workerEntry, ripgrep, extensionEntry, executable } = runtimeSetup;
  const dependencyRoot = path.join(runtimeRoot, "dependencies");
  const dependencyWorker = new ImmutableTreeWorkerClient();
  const dependencyAdmissions = new Map<string, Promise<NativeDependencyResources>>();
  let disk: ReturnType<typeof createFsDiskPort> | undefined;
  let stopped: Awaited<ReturnType<WorkspaceRuntime["stop"]>> | undefined;
  let dependenciesRetired = false;
  let stopping: Promise<Awaited<ReturnType<WorkspaceRuntime["stop"]>>> | undefined;
  let retiringStorage: Promise<void> | undefined;
  let retiring = false;
  let dependencyRetirement: Promise<void> | undefined;
  const retireDependencies = (): Promise<void> => {
    retiring = true;
    return (dependencyRetirement ??= (async () => {
      await Promise.allSettled(dependencyAdmissions.values());
      await dependencyWorker.close();
      await rm(dependencyRoot, { recursive: true, force: true });
      dependencyAdmissions.clear();
    })());
  };
  const stopOwnedRuntime = () => {
    if (stopping) return stopping;
    retiring = true;
    stopping = (async () => {
      const failures: unknown[] = [];
      try {
        disk?.retire();
      } catch (error) {
        failures.push(error);
      }
      try {
        stopped ??= await sandbox.stop();
      } catch (error) {
        failures.push(error);
      }
      if (stopped && !stopped.launcherExited) {
        failures.push(
          Object.assign(new Error("Native workspace launcher still owns its runtime resources"), {
            code: "EOWNERSHIP",
          })
        );
      }
      if (stopped?.launcherExited) {
        try {
          await retireDependencies();
          dependenciesRetired = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Native workspace stop failed", { cause: failures[0] });
      return stopped!;
    })();
    return stopping;
  };
  try {
    const diskProcess = sandbox.fork(workerEntry, { VIBESTUDIO_RIPGREP_PATH: ripgrep });
    disk = createFsDiskPort(diskProcess);
    void sandbox.retired
      .then(async () => {
        disk?.retire();
        await retireDependencies();
      })
      .catch((error) => console.error("Native dependency retirement failed:", error));
    await disk.call(
      {
        root: home,
        panelId: "installed:filesystem",
        ownerCallerIds: ["installed:filesystem"],
        exposeHostPaths: false,
      },
      "mkdir",
      ["tmp", { recursive: true }]
    );
    return {
      disk,
      extensionEntry,
      /** The runtime's Node executable (the same path inside the sandbox). */
      nodeExecutable: executable,
      /** The runtime's writable home (the same path inside the sandbox). */
      home,
      admitDependencies(input: NativeDependencyAdmission): Promise<NativeDependencyResources> {
        const { key, nodeModulesDir, workspacePackages, workspacePackageNodeModules } = input;
        if (retiring) return Promise.reject(new Error("Native workspace is retiring"));
        if (!/^[a-z0-9-]+$/u.test(key))
          return Promise.reject(new Error("Invalid acquired dependency identity"));
        if (Object.keys(workspacePackageNodeModules).some((name) => !workspacePackages[name])) {
          return Promise.reject(
            new Error("Workspace package dependency roots must belong to admitted packages")
          );
        }
        const existing = dependencyAdmissions.get(key);
        if (existing) return existing;
        const destination = path.join(dependencyRoot, key);
        const admission = (async () => {
          try {
            const nodeModulesPaths: string[] = [];
            if (nodeModulesDir) {
              const modules = path.join(destination, "node_modules");
              await dependencyWorker.materialize(nodeModulesDir, modules);
              nodeModulesPaths.push(modules);
            }
            const packages: Record<string, string> = {};
            for (const [name, source] of Object.entries(workspacePackages)) {
              const target = path.join(
                destination,
                "workspace-modules",
                Buffer.from(name).toString("base64url")
              );
              await dependencyWorker.materializePackage(source, target);
              const packageNodeModules = workspacePackageNodeModules[name];
              if (packageNodeModules) {
                await dependencyWorker.materialize(
                  packageNodeModules,
                  path.join(target, "node_modules")
                );
              }
              packages[name] = target;
            }
            if (retiring) throw new Error("Native workspace retired during dependency admission");
            return { nodeModulesPaths, workspacePackages: packages };
          } catch (error) {
            try {
              await rm(destination, { recursive: true, force: true });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "Native dependency admission and cleanup failed",
                { cause: error }
              );
            }
            throw error;
          }
        })();
        dependencyAdmissions.set(key, admission);
        void admission.catch(() => dependencyAdmissions.delete(key));
        return admission;
      },
      fork: (
        entry: string,
        environment: Record<string, string | undefined>,
        options?: ProcessAdapterOptions
      ): ProcessAdapter => sandbox.fork(entry, environment, options),
      async runJob(input: NativeWorkspaceJob): Promise<void> {
        const directory = path.join(runtimeRoot, "jobs", randomUUID());
        await mkdir(directory, { recursive: true });
        let failure: unknown;
        let failed = false;
        try {
          await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
          await writeFile(path.join(directory, "bundle.js"), input.bundle);
          await writeFile(path.join(directory, "driver.mjs"), input.script);
          if (input.dependencies)
            await materializeImmutableTree(
              input.dependencies,
              path.join(directory, "node_modules")
            );
          const child = sandbox.fork(path.join(directory, "driver.mjs"), {
            VIBESTUDIO_EXTENSION_SMOKE: "1",
            VIBESTUDIO_EXTENSION_SMOKE_BUNDLE: path.join(directory, "bundle.js"),
          });
          await waitForNativeJob(child);
        } catch (error) {
          failure = error;
          failed = true;
        }
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (cleanupError) {
          if (failed)
            throw new AggregateError([failure, cleanupError], "Native job and cleanup failed", {
              cause: failure,
            });
          throw cleanupError;
        }
        if (failed) throw failure;
      },
      async stop() {
        return stopOwnedRuntime();
      },
      async retireStorage() {
        if (retiringStorage) return retiringStorage;
        retiringStorage = (async () => {
          const failures: unknown[] = [];
          try {
            await stopOwnedRuntime();
          } catch (error) {
            failures.push(error);
          }
          if (stopped?.launcherExited && dependenciesRetired && runtimeRootCreated) {
            try {
              await rm(runtimeRoot, { recursive: true, force: true });
              runtimeRootCreated = false;
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1)
            throw new AggregateError(failures, "Native workspace storage retirement failed", {
              cause: failures[0],
            });
        })();
        return retiringStorage;
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    try {
      await stopOwnedRuntime();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (stopped?.launcherExited && dependenciesRetired && runtimeRootCreated) {
      try {
        await rm(runtimeRoot, { recursive: true, force: true });
        runtimeRootCreated = false;
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        [error, ...failures],
        "Native workspace startup and cleanup failed",
        {
          cause: error,
        }
      );
    throw error;
  }
}
