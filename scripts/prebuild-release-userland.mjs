import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseHubReadyPayload } from "./cli/lib/hub-ready.mjs";

/** Join the process and its owned streams, including explicit IPC revocation.
 * Node 22 can leave ChildProcess.close unsettled after disconnect(): the
 * process and pipes have closed, but its internal IPC close counter is short.
 * The native owner's exit is its descendant-join receipt. */
export function joinChildProcess(child) {
  return new Promise((resolve) => {
    let terminal = child.exitCode !== null || child.signalCode !== null;
    let code = child.exitCode,
      signal = child.signalCode,
      error;
    const streams = [child.stdout, child.stderr].filter(Boolean);
    const finish = () => {
      if (!terminal || child.connected || streams.some((stream) => !stream.closed)) return;
      child.off("exit", exited);
      child.off("error", failed);
      child.off("disconnect", finish);
      for (const stream of streams) stream.off("close", finish);
      resolve({ code, signal, error });
    };
    const exited = (exitCode, exitSignal) => {
      terminal = true;
      code = exitCode;
      signal = exitSignal;
      finish();
    };
    const failed = (failure) => {
      error ??= failure;
      if (child.pid === undefined) terminal = true;
      finish();
    };
    child.on("exit", exited);
    child.on("error", failed);
    child.on("disconnect", finish);
    for (const stream of streams) stream.on("close", finish);
    finish();
  });
}

/** Ready-file publication and process exit are the owner's authoritative lifecycle edges. */
export function awaitHubReady(child, readyFile) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, ready) => {
      if (settled) return;
      settled = true;
      watcher.close();
      child.off("exit", closed);
      child.off("error", failed);
      if (error) reject(error);
      else resolve(ready);
    };
    const closed = (code, signal) =>
      finish(new Error(`Release build server exited (${signal ?? code})`));
    const failed = (error) => finish(error);
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
    child.once("exit", closed);
    child.once("error", failed);
    if (child.exitCode !== null || child.signalCode !== null)
      closed(child.exitCode, child.signalCode);
    else check();
  });
}

/** Ship only the sealed record and its artifacts, never a producer's databases or grants. */
export async function exportReleaseBuild(source, destination, expectedKey) {
  if (!/^[0-9a-f]{64}$/u.test(expectedKey)) throw new Error("Invalid release build key");
  const metadata = JSON.parse(await fsp.readFile(path.join(source, "metadata.json"), "utf8"));
  if (metadata.buildKey !== expectedKey) throw new Error("Release build record key mismatch");
  const artifacts = JSON.parse(await fsp.readFile(path.join(source, "artifacts.json"), "utf8"));
  await fsp.mkdir(destination, { recursive: true });
  const files = ["metadata.json", "artifacts.json", "executable-modules.json.gz"];
  for (const artifact of artifacts) {
    if (
      !artifact.path ||
      artifact.path.includes("\\") ||
      path.posix.isAbsolute(artifact.path) ||
      artifact.path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error(`Invalid release artifact path: ${artifact.path}`);
    const bytes = await fsp.readFile(path.join(source, artifact.path));
    if (
      bytes.length !== artifact.byteLength ||
      artifact.integrity !== `sha256-${createHash("sha256").update(bytes).digest("hex")}`
    )
      throw new Error(`Release artifact integrity mismatch: ${artifact.path}`);
    files.push(artifact.path);
  }
  for (const file of new Set(files)) {
    const from = path.join(source, file);
    if (file === "executable-modules.json.gz" && !fs.existsSync(from)) continue;
    const to = path.join(destination, file);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
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
      ? path.join(context.appOutDir, `${product}.app`, "Contents", "MacOS", product)
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
  let tail = "";
  const cancellation = new AbortController();
  const stop = () => {
    stopping = true;
    if (server?.connected) server.disconnect();
  };
  const interrupt = (signal) => {
    cancellation.abort(new Error(`Release operation cancelled by ${signal}`));
    stop();
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
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
    server = spawn(executable, [serverEntry, "--app-root", appRoot, "--ready-file", readyFile], {
      env,
      cwd: scratch,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    server.on("error", (error) => {
      serverError ??= error;
    });
    server.once("exit", (code, signal) => {
      if (!stopping)
        serverError ??= new Error(`Release build server exited (${signal ?? code}): ${tail}`);
    });
    closed = joinChildProcess(server);
    for (const stream of [server.stdout, server.stderr])
      stream.on("data", (chunk) => {
        tail = (tail + chunk).slice(-8192);
      });
    const ready = await awaitHubReady(server, readyFile);
    const cli = async (args) => {
      cancellation.signal.throwIfAborted();
      if (serverError) throw serverError;
      const controller = new AbortController();
      const onServerClose = () => controller.abort(cancellation.signal.reason ?? serverError);
      server.once("exit", onServerClose);
      server.once("error", onServerClose);
      let output = "",
        errorOutput = "";
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
      try {
        const { code } = await joined;
        if (failure || code !== 0)
          throw (
            serverError ??
            failure ??
            new Error(`Release build CLI failed: ${errorOutput}\n${output}`)
          );
        return JSON.parse(output.trim());
      } finally {
        server.off("exit", onServerClose);
        server.off("error", onServerClose);
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
      signal: cancellation.signal,
    });
    cancellation.signal.throwIfAborted();
    if (serverError) throw serverError;
    return result;
  } catch (error) {
    throw new Error(`Installed release operation failed: ${error.message}\n${tail}`, {
      cause: error,
    });
  } finally {
    stop();
    await closed;
    try {
      await fsp.rm(scratch, { recursive: true, force: true });
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
  }
}

/** The installed dependency boundary produces the source package and artifacts
 * before a fresh consumer workspace is allowed to boot. */
export async function prepareInstalledWorkspaceTemplates(context) {
  assertNativeReleaseRunner(context);
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const product = context.packager.appInfo.productFilename;
  const executable =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${product}.app`, "Contents", "MacOS", product)
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
    VIBESTUDIO_WORKSPACE_RELEASE_ROOT: resources,
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
  await fsp.mkdir(env.TMPDIR, { recursive: true });
  let child, joined, cancellation;
  const stop = () => {
    cancellation ??= new Error("Template release preparation cancelled");
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    child = spawn(
      executable,
      [
        entry,
        "--app-root",
        appRoot,
        "--output",
        resources,
        "--scratch",
        path.join(scratch, "producer"),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    joined = joinChildProcess(child);
    let tail = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        tail = (tail + chunk).slice(-8192);
        process.stdout.write(chunk);
      });
    const result = await joined;
    if (cancellation) throw cancellation;
    if (result.error || result.code !== 0)
      throw new Error(
        `Template release preparation failed (${result.signal ?? result.code}): ${tail}`,
        { cause: result.error }
      );
  } finally {
    child?.kill("SIGTERM");
    await joined;
    await fsp.rm(scratch, { recursive: true, force: true });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function prebuildReleaseUserland(context) {
  await prepareInstalledWorkspaceTemplates(context);
  await verifyReleaseUserland(context);
}

/** A clean consumer must reuse the producer's exact immutable records. */
export async function verifyReleaseUserland(context) {
  await withInstalledReleaseSession(context, verifyPreparedReleaseUserland);
}

export async function verifyPreparedReleaseUserland({ cli, pair, resources, env }) {
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
    for (const record of records) {
      console.log(`[release-builds] Verifying ${kind}: ${record.source}`);
      const result = await cli([
        "agent",
        "call",
        "build.getBuild",
        JSON.stringify([record.source]),
      ]);
      const key = result.bundle?.buildKey ?? result.buildKey;
      if (key !== record.buildKey)
        throw new Error(
          `Release build identity changed for ${kind}:${record.source}: ${key} != ${record.buildKey}`
        );
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
      verified++;
    }
  }
  console.log(`[release-builds] Verified ${verified} exact artifacts in a fresh installation`);
}
