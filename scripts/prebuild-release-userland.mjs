import * as fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { deserializeRpcFailure, serializeRpcFailure } from "@vibestudio/rpc";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";

import { joinChildProcess } from "./lib/join-child-process.mjs";
import { resolveMacAppExecutable } from "./lib/mac-app-executable.mjs";
import {
  hasOwnershipFailure,
  runOwnedCleanupSteps,
  runWithOwnedCleanup,
} from "./lib/owned-cleanup.mjs";
import { prepareWorkspaceRelease } from "./prepare-workspace-release.mjs";

const RELEASE_VERIFIER_RESULT_PREFIX = "VIBESTUDIO_RELEASE_RPC_RESULT:";

/** Ready-file publication and process exit are the owner's authoritative lifecycle edges. */
export function awaitHubReady(child, readyFile, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, ready) => {
      if (settled) return;
      settled = true;
      watcher.close();
      child.off("exit", closed);
      child.off("error", failed);
      signal?.removeEventListener("abort", canceled);
      if (error) reject(error);
      else resolve(ready);
    };
    const closed = (code, signal) =>
      finish(new Error(`Release build server exited (${signal ?? code})`));
    const failed = (error) => finish(error);
    const canceled = () => finish(signal?.reason ?? new Error("Release server startup cancelled"));
    const check = () => {
      if (settled) return;
      try {
        finish(null, parseHubReadyPayload(JSON.parse(fs.readFileSync(readyFile, "utf8"))));
      } catch (error) {
        if (error.code !== "ENOENT") finish(error);
      }
    };
    const watcher = fs.watch(path.dirname(readyFile), check);
    watcher.on("error", failed);
    signal?.addEventListener("abort", canceled, { once: true });
    child.once("exit", closed);
    child.once("error", failed);
    if (signal?.aborted) canceled();
    else if (child.exitCode !== null || child.signalCode !== null)
      closed(child.exitCode, child.signalCode);
    else check();
  });
}

/** Ship only the sealed record and its artifacts, never a producer's databases or grants. */
export async function exportReleaseBuild(source, destination, expectedKey) {
  if (!/^[0-9a-f]{64}$/u.test(expectedKey)) throw new Error("Invalid release build key");
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const files = await verifyReleaseBuildDirectory(source, expectedKey, false);
  if (await releaseBuildDestinationExists(destination)) {
    await verifyReleaseBuildDirectory(destination, expectedKey, true);
    return;
  }

  const staging = await fsp.mkdtemp(`${destination}.publishing-`);
  let failure;
  let hasFailure = false;
  try {
    for (const file of files) {
      const from = path.join(source, file);
      const to = path.join(staging, file);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
    }
    await verifyReleaseBuildDirectory(staging, expectedKey, true);
    try {
      await fsp.rename(staging, destination);
    } catch (renameError) {
      let incumbentExists;
      try {
        incumbentExists = await releaseBuildDestinationExists(destination);
      } catch (inspectionError) {
        throw new AggregateError(
          [renameError, inspectionError],
          "Could not inspect a release build publication collision",
          { cause: renameError }
        );
      }
      if (!incumbentExists) throw renameError;
      try {
        await verifyReleaseBuildDirectory(destination, expectedKey, true);
      } catch (verificationError) {
        throw new AggregateError(
          [renameError, verificationError],
          "Release build publication collided with an invalid incumbent",
          { cause: renameError }
        );
      }
    }
  } catch (error) {
    failure = error;
    hasFailure = true;
  }
  try {
    await fsp.rm(staging, { recursive: true, force: true });
  } catch (cleanupError) {
    if (hasFailure) {
      throw new AggregateError(
        [failure, cleanupError],
        "Release build publication failed and staging cleanup also failed",
        { cause: failure }
      );
    }
    throw cleanupError;
  }
  if (hasFailure) throw failure;
}

async function releaseBuildDestinationExists(destination) {
  try {
    const stat = await fsp.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Release build destination is not a real directory");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function verifyReleaseBuildDirectory(directory, expectedKey, exactContents) {
  const metadata = JSON.parse(await fsp.readFile(path.join(directory, "metadata.json"), "utf8"));
  if (!metadata || typeof metadata !== "object" || metadata.buildKey !== expectedKey)
    throw new Error("Release build record key mismatch");

  const artifacts = JSON.parse(await fsp.readFile(path.join(directory, "artifacts.json"), "utf8"));
  if (!Array.isArray(artifacts)) throw new Error("Invalid release artifact manifest");
  const files = new Set(["metadata.json", "artifacts.json"]);
  for (const artifact of artifacts) {
    const artifactPath = artifact && typeof artifact === "object" ? artifact.path : undefined;
    if (
      typeof artifactPath !== "string" ||
      artifactPath.includes("\\") ||
      artifactPath.includes(":") ||
      path.posix.isAbsolute(artifactPath) ||
      path.win32.isAbsolute(artifactPath) ||
      artifactPath.split("/").some((part) => !part || part === "." || part === "..") ||
      files.has(artifactPath) ||
      artifactPath === "executable-modules.json.gz"
    ) {
      throw new Error(`Invalid release artifact path: ${String(artifactPath)}`);
    }
    if (
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0 ||
      typeof artifact.integrity !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(artifact.integrity)
    ) {
      throw new Error(`Invalid release artifact manifest entry: ${artifactPath}`);
    }
    const bytes = await fsp.readFile(path.join(directory, artifactPath));
    if (
      bytes.length !== artifact.byteLength ||
      artifact.integrity !== `sha256-${createHash("sha256").update(bytes).digest("hex")}`
    ) {
      throw new Error(`Release artifact integrity mismatch: ${artifactPath}`);
    }
    files.add(artifactPath);
  }

  try {
    const modulesPath = path.join(directory, "executable-modules.json.gz");
    const modules = JSON.parse(gunzipSync(await fsp.readFile(modulesPath)).toString("utf8"));
    if (!Array.isArray(modules)) throw new Error("Invalid executable module inventory");
    files.add("executable-modules.json.gz");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (exactContents) await assertExactReleaseBuildFiles(directory, files);
  return [...files];
}

async function assertExactReleaseBuildFiles(directory, expectedFiles) {
  const actualFiles = new Set();
  const visit = async (current, relative = "") => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, entryPath);
      else if (entry.isFile()) actualFiles.add(entryPath);
      else throw new Error(`Invalid release build entry: ${entryPath}`);
    }
  };
  await visit(directory);
  if (
    actualFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((file) => !actualFiles.has(file))
  ) {
    throw new Error("Release build directory does not match its sealed artifact manifest");
  }
}

function assertNativeReleaseRunner(context) {
  const arch =
    typeof context.arch === "string" ? context.arch : { 1: "x64", 3: "arm64" }[context.arch];
  if (context.electronPlatformName !== process.platform || arch !== process.arch)
    throw new Error(
      `Userland release builds require a native ${context.electronPlatformName}-${arch} runner`
    );
}

export async function withInstalledReleaseSession(context, operation) {
  assertNativeReleaseRunner(context);
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const product = context.packager.appInfo.productFilename;
  const executable =
    context.electronPlatformName === "darwin"
      ? await resolveMacAppExecutable(path.join(context.appOutDir, `${product}.app`))
      : path.join(context.appOutDir, `${product}${process.platform === "win32" ? ".exe" : ""}`);
  const appRoot = path.join(resources, "app.asar");
  const unpacked = path.join(resources, "app.asar.unpacked");
  return withReleaseConsumerSession(
    {
      appRoot,
      resources,
      executable,
      scratchParent: path.dirname(context.appOutDir),
      serverEntry: path.join(unpacked, "dist/server-electron.cjs"),
      cliEntry: path.join(unpacked, "dist/cli/client.mjs"),
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    },
    operation
  );
}

export async function withStandaloneReleaseSession(appRoot, executable, scratchParent, operation) {
  return withReleaseConsumerSession(
    {
      appRoot,
      resources: appRoot,
      executable,
      scratchParent,
      serverEntry: path.join(appRoot, "dist/server.mjs"),
      cliEntry: path.join(appRoot, "dist/cli/client.mjs"),
      environment: {},
    },
    operation
  );
}

async function withReleaseConsumerSession(
  { appRoot, resources, executable, scratchParent, serverEntry, cliEntry, environment },
  operation
) {
  // The publisher owns this disk-backed staging directory and joins the consumer.
  const scratch = await fsp.mkdtemp(path.join(scratchParent, ".userland-build-"));
  let server;
  let closed;
  let serverError;
  let stopping = false;
  let stopFailure;
  let stopDelivery;
  let ownerRevocationRequested = false;
  let tail = "";
  let operationFailure;
  const cancellation = new AbortController();
  const revokeAfterStopDeliveryFailure = (error) => {
    stopFailure ??= error;
    if (!server?.connected) return;
    try {
      server.disconnect();
      ownerRevocationRequested = true;
    } catch (disconnectError) {
      stopFailure = new AggregateError(
        [stopFailure, disconnectError],
        "Could not deliver parent-owned stop or revoke its process lease",
        { cause: stopFailure }
      );
    }
  };
  const stop = () => {
    stopping = true;
    if (
      server &&
      server.exitCode === null &&
      server.signalCode === null &&
      server.connected &&
      !stopDelivery
    ) {
      // The existing parent-owned stop message asks the service owner to run
      // its ordered shutdown while the IPC ownership lease remains connected.
      stopDelivery = new Promise((resolve) => {
        const failed = (error) => {
          revokeAfterStopDeliveryFailure(error);
          resolve();
        };
        try {
          server.send({ type: "vibestudio:parent-owned-stop" }, (error) => {
            if (error) failed(error);
            else resolve();
          });
        } catch (error) {
          failed(error);
        }
      });
    }
    return stopDelivery ?? Promise.resolve();
  };
  const interrupt = (signal) => {
    cancellation.abort(new Error(`Release operation cancelled by ${signal}`));
    stop();
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return runWithOwnedCleanup(
    async () => {
      try {
        const inherited = {};
        for (const key of [
          "PATH",
          "SystemRoot",
          "WINDIR",
          "COMSPEC",
          "PATHEXT",
          "LANG",
          "LC_ALL",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "NODE_EXTRA_CA_CERTS",
          "VIBESTUDIO_MAX_CONCURRENT_BUILDS",
        ])
          if (process.env[key] !== undefined) inherited[key] = process.env[key];
        // Release coordinates come from the installed pointer; configuration,
        // credentials and caches belong exclusively to this build operation.
        const env = {
          ...inherited,
          NODE_ENV: "production",
          ...environment,
          VIBESTUDIO_APP_ROOT: appRoot,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: path.join(appRoot, "dist"),
          VIBESTUDIO_INSTANCE_ROOT: path.join(scratch, "instance"),
          VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: path.join(scratch, "derived"),
          XDG_CONFIG_HOME: path.join(scratch, "config"),
          XDG_CACHE_HOME: path.join(scratch, "cache"),
          LOCALAPPDATA: path.join(scratch, "config"),
          TMPDIR: path.join(scratch, "tmp"),
          TMP: path.join(scratch, "tmp"),
          TEMP: path.join(scratch, "tmp"),
          APPDATA: path.join(scratch, "config"),
          HOME: path.join(scratch, "home"),
          USERPROFILE: path.join(scratch, "home"),
        };
        for (const dir of [
          env.VIBESTUDIO_INSTANCE_ROOT,
          env.HOME,
          env.XDG_CONFIG_HOME,
          env.XDG_CACHE_HOME,
          env.TMPDIR,
        ])
          await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        const readyFile = path.join(scratch, "ready.json");
        cancellation.signal.throwIfAborted();
        server = spawn(
          executable,
          [serverEntry, "--app-root", appRoot, "--ready-file", readyFile],
          {
            env,
            cwd: scratch,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          }
        );
        server.on("error", (error) => {
          serverError ??= error;
          if (!stopping) cancellation.abort(serverError);
        });
        server.once("exit", (code, signal) => {
          if (!stopping) {
            serverError ??= new Error(`Release build server exited (${signal ?? code}): ${tail}`);
            cancellation.abort(serverError);
          }
        });
        closed = joinChildProcess(server);
        for (const stream of [server.stdout, server.stderr])
          stream.on("data", (chunk) => {
            tail = (tail + chunk).slice(-8192);
          });
        const ready = await awaitHubReady(server, readyFile, cancellation.signal);
        const cli = async (args) => {
          cancellation.signal.throwIfAborted();
          if (serverError) throw serverError;
          const controller = new AbortController();
          const onServerClose = () => controller.abort(cancellation.signal.reason ?? serverError);
          const onCancellation = () => controller.abort(cancellation.signal.reason);
          server.once("exit", onServerClose);
          server.once("error", onServerClose);
          cancellation.signal.addEventListener("abort", onCancellation, { once: true });
          if (cancellation.signal.aborted) onCancellation();
          let output = "",
            errorOutput = "";
          try {
            const child = spawn(executable, [cliEntry, ...args, "--json"], {
              env,
              cwd: scratch,
              signal: controller.signal,
              stdio: ["ignore", "pipe", "pipe"],
            });
            const joined = joinChildProcess(child);
            let failure;
            child.on("error", (error) => {
              failure = error;
            });
            child.stdout.on("data", (chunk) => {
              output += chunk;
            });
            child.stderr.on("data", (chunk) => {
              errorOutput = (errorOutput + chunk).slice(-8192);
            });
            const { code } = await joined;
            if (serverError) throw serverError;
            if (cancellation.signal.aborted) throw cancellation.signal.reason;
            if (failure || code !== 0)
              throw failure ?? new Error(`Release build CLI failed: ${errorOutput}\n${output}`);
            return JSON.parse(output.trim());
          } finally {
            server.off("exit", onServerClose);
            server.off("error", onServerClose);
            cancellation.signal.removeEventListener("abort", onCancellation);
          }
        };
        await cli(["remote", "pair", ready.rootInvite.deepLink]);
        const pair = await cli(["remote", "ensure-user-workspaces"]);
        const result = await operation({
          cli,
          pair,
          scratch,
          resources,
          env,
          runBuildBatch: (sources) =>
            runInstalledRpcBatch({
              executable,
              runnerEntry: path.join(path.dirname(cliEntry), "releaseVerifierRunner.mjs"),
              cliEntry,
              sources,
              env,
              scratch,
              signal: cancellation.signal,
            }),
          signal: cancellation.signal,
        });
        cancellation.signal.throwIfAborted();
        if (serverError) throw serverError;
        return result;
      } catch (error) {
        operationFailure = error;
        throw new Error(`Installed release operation failed: ${error.message}\n${tail}`, {
          cause: error,
        });
      }
    },
    async () => {
      const failures = [];
      await runOwnedCleanupSteps(
        [
          async () => {
            await stop();
            if (stopFailure) throw stopFailure;
          },
          async () => {
            if (!closed) return;
            const result = await closed;
            if (result.error) throw result.error;
            if (result.signal && !(ownerRevocationRequested && result.signal === "SIGKILL"))
              throw new Error(`Release build server was terminated by ${result.signal}: ${tail}`);
            if (result.code !== 0)
              throw new Error(`Release build server exited (${result.code}): ${tail}`);
          },
        ],
        "Installed release process retirement failed"
      ).catch((error) => failures.push(error));
      if (
        !hasOwnershipFailure(operationFailure) &&
        !failures.some((error) => hasOwnershipFailure(error))
      ) {
        await runOwnedCleanupSteps(
          [() => fsp.rm(scratch, { recursive: true, force: true })],
          "Installed release scratch retirement failed"
        ).catch((error) => failures.push(error));
      }
      await runOwnedCleanupSteps(
        [() => process.off("SIGINT", onInterrupt), () => process.off("SIGTERM", onTerminate)],
        "Installed release signal listener retirement failed"
      ).catch((error) => failures.push(error));
      if (failures.length) {
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, "Installed release cleanup failed", {
          cause: failures[0],
        });
      }
    },
    `Installed release operation failed: ${tail}`
  );
}

/** The installed dependency boundary produces the source package and artifacts
 * before a fresh consumer workspace is allowed to boot. */
export async function prepareInstalledWorkspaceTemplates(context) {
  assertNativeReleaseRunner(context);
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const product = context.packager.appInfo.productFilename;
  const executable =
    context.electronPlatformName === "darwin"
      ? await resolveMacAppExecutable(path.join(context.appOutDir, `${product}.app`))
      : path.join(context.appOutDir, `${product}${process.platform === "win32" ? ".exe" : ""}`);
  await prepareInstalledTemplateRelease({
    appRoot: path.join(resources, "app.asar"),
    resources,
    executable,
    electron: true,
    entry: path.join(resources, "app.asar.unpacked", "dist/prepare-workspace-templates.cjs"),
    scratchParent: path.dirname(context.appOutDir),
  });
}

export async function prepareInstalledTemplateRelease({
  appRoot,
  resources,
  executable,
  entry,
  scratchParent,
  electron = false,
}) {
  const scratch = await fsp.mkdtemp(path.join(scratchParent, ".template-release-"));
  const env = {
    ...process.env,
    NODE_ENV: "production",
    ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    VIBESTUDIO_HOST_ARTIFACT_ROOT: path.join(appRoot, "dist"),
    VIBESTUDIO_INSTANCE_ROOT: path.join(scratch, "instance"),
    VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: path.join(scratch, "derived"),
    TMPDIR: path.join(scratch, "tmp"),
    TMP: path.join(scratch, "tmp"),
    TEMP: path.join(scratch, "tmp"),
  };
  // Installed release pins and dependencies are the producer's complete input;
  // developer template selection must never enter a product artifact.
  for (const key of [
    "VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES",
    "VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE",
    "VIBESTUDIO_WORKSPACE_SOURCES",
  ])
    delete env[key];
  // The packager owns this output; only the outer release wrapper may pass it
  // to a child after deciding whether it is fresh or borrowed input.
  delete env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT;
  let preparation;
  const failures = [];
  const retainFailure = (error) => {
    if (!failures.includes(error)) failures.push(error);
  };
  try {
    await fsp.mkdir(env.TMPDIR, { recursive: true });
    preparation = prepareWorkspaceRelease({
      appRoot,
      output: resources,
      scratch: path.join(scratch, "producer"),
      env,
      executable,
      entry,
    });
    await preparation.completed;
  } catch (error) {
    retainFailure(error);
  }
  try {
    await preparation?.stop();
  } catch (error) {
    retainFailure(error);
  }
  // Ownership failures may be nested in a producer's aggregate receipt. Keep
  // the state anchor until physical retirement is proven; an ordinary build
  // failure still permits cleanup after its producer has been joined.
  if (!failures.some((error) => hasOwnershipFailure(error))) {
    try {
      await fsp.rm(scratch, { recursive: true, force: true });
    } catch (error) {
      retainFailure(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Installed template preparation and cleanup failed", {
      cause: failures[0],
    });
}

export async function prebuildReleaseUserland(context) {
  await prepareInstalledWorkspaceTemplates(context);
  await verifyReleaseUserland(context);
}

/** A clean consumer must reuse the producer's exact immutable records. */
export async function verifyReleaseUserland(context) {
  await withInstalledReleaseSession(context, verifyPreparedReleaseUserland);
}

export async function verifyPreparedReleaseUserland({ cli, pair, resources, env, runBuildBatch }) {
  const manifest = JSON.parse(
    await fsp.readFile(path.join(resources, "userland-builds/release.json"), "utf8")
  );
  const base = await cli([
    "remote",
    "create-workspace",
    "release-base",
    "--operation-id",
    "release_verification_base",
  ]);
  const workspaces = { ...pair, base };
  let verified = 0;
  for (const kind of ["base", "system", "personal"]) {
    const workspace = workspaces[kind];
    await cli(["remote", "select", workspace.name]);
    const records = manifest.builds.filter((record) => record.workspace === kind);
    if (records.length === 0) throw new Error(`Release has no prepared artifacts for ${kind}`);
    for (const record of records)
      console.log(`[release-builds] Verifying ${kind}: ${record.source}`);
    const batch = await runBuildBatch(records.map((record) => record.source));
    const failures = [];
    for (const [index, record] of records.entries()) {
      const outcome = batch.outcomes[index];
      if (!outcome || outcome.source !== record.source) {
        failures.push(
          new Error(`Release verifier omitted ordered result for ${kind}:${record.source}`)
        );
        continue;
      }
      if (outcome.status === "rejected") {
        failures.push(outcome.failure);
        continue;
      }
      const key = outcome.buildKey;
      if (key !== record.buildKey) {
        failures.push(
          new Error(
            `Release build identity changed for ${kind}:${record.source}: ${key} != ${record.buildKey}`
          )
        );
        continue;
      }
      try {
        const local = path.join(
          env.VIBESTUDIO_INSTANCE_ROOT,
          "workspaces",
          workspace.name,
          "state",
          "builds",
          key
        );
        const metadata = JSON.parse(await fsp.readFile(path.join(local, "metadata.json"), "utf8"));
        if (metadata.builtAt !== record.builtAt)
          throw new Error(
            `Fresh installation rebuilt ${kind}:${record.source} instead of reusing its release artifact`
          );
      } catch (error) {
        failures.push(error);
      }
    }
    if (batch.outcomes.length !== records.length)
      failures.push(
        new Error(
          `Release verifier returned ${batch.outcomes.length} results for ${records.length} artifacts in ${kind}`
        )
      );
    if (batch.cleanupFailure) failures.push(batch.cleanupFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Release artifact verification failed", {
        cause: failures[0],
      });
    verified += records.length;
  }
  console.log(`[release-builds] Verified ${verified} exact artifacts in a fresh installation`);
}

export async function runInstalledRpcBatch({
  executable,
  runnerEntry,
  cliEntry,
  sources,
  env,
  scratch,
  signal,
}) {
  const inputPath = path.join(scratch, "release-verifier-input.json");
  await fsp.writeFile(inputPath, JSON.stringify({ cliEntry, sources }), { mode: 0o600 });
  let result;
  let primaryFailure;
  try {
    const child = spawn(executable, [runnerEntry, inputPath], {
      env,
      cwd: scratch,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const joined = joinChildProcess(child);
    let stdout = "";
    let stderr = "";
    let spawnFailure;
    child.on("error", (error) => (spawnFailure = error));
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-8192)));
    let cancelDelivery;
    let cancelDeliveryFailure;
    const deliverCancellation = () => {
      if (cancelDelivery) return;
      cancelDelivery = new Promise((resolve) => {
        if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        try {
          child.send(
            {
              type: "cancel",
              failure: serializeRpcFailure(
                signal.reason ?? new Error("Release verification was cancelled")
              ),
            },
            (error) => {
              if (error && child.exitCode === null && child.signalCode === null) {
                cancelDeliveryFailure = error;
                try {
                  child.kill();
                } catch (killError) {
                  cancelDeliveryFailure = new AggregateError(
                    [error, killError],
                    "Could not deliver cancellation or retire the release verifier",
                    { cause: error }
                  );
                }
              }
              resolve();
            }
          );
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) {
            cancelDeliveryFailure = error;
            try {
              child.kill();
            } catch (killError) {
              cancelDeliveryFailure = new AggregateError(
                [error, killError],
                "Could not deliver cancellation or retire the release verifier",
                { cause: error }
              );
            }
          }
          resolve();
        }
      });
    };
    const onAbort = () => deliverCancellation();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) deliverCancellation();
    const terminal = await joined;
    signal?.removeEventListener("abort", onAbort);
    await cancelDelivery;
    const resultLine = stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith(RELEASE_VERIFIER_RESULT_PREFIX));
    const payload = resultLine
      ? JSON.parse(resultLine.slice(RELEASE_VERIFIER_RESULT_PREFIX.length))
      : {};
    const outcomes = (payload.outcomes ?? []).map((outcome) =>
      outcome.status === "rejected"
        ? { ...outcome, failure: deserializeRpcFailure(outcome.failure) }
        : outcome
    );
    const failures = [
      ...(signal?.aborted ? [signal.reason] : []),
      ...(payload.fatal ? [deserializeRpcFailure(payload.fatal)] : []),
      ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.failure] : [])),
      ...(payload.cleanupFailure ? [deserializeRpcFailure(payload.cleanupFailure)] : []),
      ...(cancelDeliveryFailure ? [cancelDeliveryFailure] : []),
      ...(!resultLine
        ? [
            terminal.error ??
              spawnFailure ??
              new Error(`Release verifier runner returned no result: ${stderr}`),
          ]
        : []),
      ...(terminal.error || spawnFailure || terminal.signal || terminal.code !== 0
        ? [
            terminal.error ??
              spawnFailure ??
              new Error(
                `Release verifier runner exited (${terminal.signal ?? terminal.code}): ${stderr}`
              ),
          ]
        : []),
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "Release RPC batch failed", {
        cause: signal?.aborted ? signal.reason : failures[0],
      });
    result = {
      outcomes,
    };
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailure;
  try {
    await fsp.rm(inputPath, { force: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure && cleanupFailure)
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "Release verifier input cleanup failed",
      {
        cause: primaryFailure,
      }
    );
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}
