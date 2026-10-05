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
  const processRuntime = path.dirname(
    installedRequire.resolve("@vibestudio/process-adapter/workspace-runtime")
  );
  const workerEntry = path.join(runtimeRoot, "fs-disk-worker.cjs");
  const workspaceEntry = path.join(runtimeRoot, "workspaceChild.js");
  const extensionEntry = path.join(runtimeRoot, "extensionChild.js");
  await copyFile(
    installedRequire.resolve("@vibestudio/extension-host/child-runtime"),
    extensionEntry
  );
  await copyFile(path.join(resolveRequiredHostArtifactRoot(), "fs-disk-worker.cjs"), workerEntry);
  for (const name of ["workspaceChild.js", "control.js"])
    await copyFile(path.join(processRuntime, name), path.join(runtimeRoot, name));
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
  for (const resource of [
    workspaceEntry,
    path.join(runtimeRoot, "control.js"),
    workerEntry,
    extensionEntry,
    compiler,
  ])
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
  const dependencyRoot = path.join(runtimeRoot, "dependencies");
  const dependencyWorker = new ImmutableTreeWorkerClient(input.appRoot);
  const dependencyAdmissions = new Map<string, Promise<NativeDependencyResources>>();
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
  let disk: ReturnType<typeof createFsDiskPort> | undefined;
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
      ["tmp", { recursive: true }],
      AbortSignal.timeout(10_000)
    );
    return {
      disk,
      extensionEntry,
      admitDependencies(input: NativeDependencyAdmission): Promise<NativeDependencyResources> {
        const { key, nodeModulesDir, workspacePackages } = input;
        if (retiring) return Promise.reject(new Error("Native workspace is retiring"));
        if (!/^[a-z0-9-]+$/u.test(key))
          return Promise.reject(new Error("Invalid acquired dependency identity"));
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
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      async stop() {
        retiring = true;
        disk?.retire();
        const stopped = await sandbox.stop();
        if (stopped.launcherExited) await retireDependencies();
        return stopped;
      },
      async retireStorage() {
        const stopped = await sandbox.stop();
        if (!stopped.launcherExited) throw new Error("Native workspace still owns its storage");
        await retireDependencies();
      },
    };
  } catch (error) {
    disk?.retire();
    await sandbox.stop();
    await retireDependencies();
    throw error;
  }
}
