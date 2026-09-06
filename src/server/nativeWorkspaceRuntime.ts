import { getMxcExecutable } from "@vibestudio/shared/runtimePaths";
import { prepareNativeRuntime } from "./nativeRuntimeResources.js";
import { materializeImmutableTree } from "./buildV2/immutableTreeMaterializer.js";
import { waitForNativeJob, type NativeWorkspaceJob } from "./nativeWorkspaceJob.js";
import { mkdir, realpath, copyFile, lstat, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  WorkspaceSandbox,
  type ProcessAdapter,
  type ProcessAdapterOptions,
} from "@vibestudio/process-adapter";
import { createFsDiskPort } from "./services/fsDiskPort.js";

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
  await copyFile(path.join(input.appRoot, "dist", "fs-disk-worker.cjs"), workerEntry);
  for (const name of ["workspaceChild.js", "control.js"])
    await copyFile(path.join(processRuntime, name), path.join(runtimeRoot, name));
  await writeFile(path.join(runtimeRoot, "package.json"), '{"type":"module"}\n');
  const { rgPath } = installedRequire("@vscode/ripgrep") as { rgPath: string };
  const ripgrep = path.join(runtimeRoot, platform === "win32" ? "rg.exe" : "rg");
  await copyFile(rgPath, ripgrep);
  const runtime = prepareNativeRuntime({ runtimeRoot, platform });
  const { executable } = runtime;
  const identity = createHash("sha256");
  for (const resource of [
    workspaceEntry,
    path.join(runtimeRoot, "control.js"),
    workerEntry,
    extensionEntry,
  ])
    identity.update(await readFile(resource));
  const sandbox = await WorkspaceSandbox.start(
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
        PATH:
          platform === "win32"
            ? [path.dirname(executable), runtimeRoot].join(path.delimiter)
            : `${runtimeRoot}:/usr/bin:/bin`,
        LANG: "C.UTF-8",
        ...runtime.environment,
      },
      read: [...runtime.readPaths, sourceRoot, buildsRoot],
      // These are owner-selected anchors, never the destinations of guest links.
      // MXC enforces access to the declared private resource trees.
      write: [home, scratchRoot, extensionStorage],
      sockets: [],
    },
    {
      platform,
      launcher: getMxcExecutable(input.appRoot),
      workspaceEntry,
    }
  );
  let disk: ReturnType<typeof createFsDiskPort> | undefined;
  try {
    const diskProcess = sandbox.fork(workerEntry, { VIBESTUDIO_RIPGREP_PATH: ripgrep });
    disk = createFsDiskPort(diskProcess);
    void sandbox.retired.then(() => disk?.retire());
    await disk.call(
      { root: home, panelId: "installed:filesystem", exposeHostPaths: false },
      "mkdir",
      ["tmp", { recursive: true }],
      AbortSignal.timeout(10_000)
    );
    return {
      disk,
      extensionEntry,
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
        disk?.retire();
        return sandbox.stop();
      },
      async retireStorage() {
        const stopped = await sandbox.stop();
        if (!stopped.launcherExited) throw new Error("Native workspace still owns its storage");
      },
    };
  } catch (error) {
    disk?.retire();
    await sandbox.stop();
    throw error;
  }
}
