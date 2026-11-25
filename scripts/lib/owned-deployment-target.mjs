import { readNativeReferenceOnly } from "./native-reference-mode.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { inspectDeploymentIdentity } from "../cli/remote-deployment-workflow.mjs";
import { managedServerArgs } from "../cli/remote-deploy.mjs";

const execute = promisify(execFile);

async function loopbackPort() {
  const listener = createServer();
  return await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function requireHostedModelRouteSupport(appRoot) {
  if (process.env.VIBESTUDIO_HOSTED_MODEL_ROUTE === undefined) return;
  const manifest = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
  if (manifest.vibestudioHostedModelRouteVersion !== 1) {
    throw new Error(
      "The installed server cannot enforce VIBESTUDIO_HOSTED_MODEL_ROUTE; install a policy-capable release before launching this owned target"
    );
  }
}

async function requireNativeReferenceSupport(appRoot, nativeReference) {
  if (!nativeReference && !readNativeReferenceOnly()) return;
  const manifest = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
  if (manifest.vibestudioNativeReferenceModeVersion !== 1)
    throw new Error("The installed server cannot enforce native-reference no-inference mode; install a capable release before allocation");
}

export async function requireInstalledDeploymentPackage(appRoot, {nativeReference = false} = {}) {
  await requireNativeReferenceSupport(appRoot, nativeReference);
  try {
    const manifest = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, "@panticonic/vibestudio-server");
    await access(path.join(appRoot, "scripts", "cli", "remote-serve.mjs"));
  } catch (cause) {
    throw new Error(
      "VIBESTUDIO_MANAGED_DEPLOYMENT_PACKAGE must identify an installed Vibestudio server package",
      { cause }
    );
  }

  await requireHostedModelRouteSupport(appRoot);

  // Probe the packaged loader in its own process, using the same Node binary
  // as the deployment. The development checkout has a separate Iroh binding.
  try {
    await execute(process.execPath, [
      "--eval",
      `
        const { Endpoint, SecretKey, RelayMode } = require(process.argv[1]);
        if (![Endpoint, SecretKey, RelayMode].every(value => typeof value === "function")) {
          process.exitCode = 1;
        }
      `,
      path.resolve(appRoot, "node_modules", "@number0", "iroh"),
    ]);
  } catch (cause) {
    throw new Error("The installed Vibestudio server could not load its Iroh native binding", {
      cause,
    });
  }
}

export async function openOwnedDeploymentTarget({ appRoot, ownership, scratchRoot, signal, nativeReference = false }) {
  const nativeReferenceOnly = nativeReference || readNativeReferenceOnly();
  await requireNativeReferenceSupport(appRoot, nativeReferenceOnly);
  await requireHostedModelRouteSupport(appRoot);
  const home = path.join(scratchRoot, "home");
  const instance = path.join(scratchRoot, "instance");
  const readyFile = path.join(instance, "hub-ready.json");
  await Promise.all([mkdir(home), mkdir(instance)]);
  const port = await loopbackPort();
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("VIBESTUDIO_") ||
        name === "VIBESTUDIO_TEMPLATE_CHECKOUTS" ||
        name === "VIBESTUDIO_MAX_CONCURRENT_BUILDS" ||
        name === "VIBESTUDIO_HOSTED_MODEL_ROUTE"
    )
  );
  const env = {
    ...inherited,
    // This target executes an installed release, even when its owner is a
    // development harness. Its captured dependencies use the prepared policy.
    NODE_ENV: "production",
    ...(nativeReferenceOnly ? {VIBESTUDIO_NATIVE_REFERENCE_ONLY:"1"} : {}),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    VIBESTUDIO_APP_ROOT: appRoot,
    VIBESTUDIO_PROFILE_ROOT: path.join(scratchRoot, "profile"),
    VIBESTUDIO_INSTANCE_ROOT: instance,
    VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: getSharedDerivedDataPath(),
    VIBESTUDIO_DISABLE_DEV_TEMPLATE_MIRROR: "1",
  };

  let boot;
  const probe = () =>
    inspectDeploymentIdentity({
      readyFile,
      port,
      active: Boolean(boot),
    });

  async function stop() {
    if (!boot) return;
    const { owned, log } = boot;
    try {
      await owned.retire();
    } finally {
      boot = undefined;
      await log.close();
    }
  }

  async function start(label) {
    await stop();
    const logPath = path.join(scratchRoot, label + ".log");
    const log = await open(logPath, "w", 0o600);
    const [, , ...args] = managedServerArgs(port, readyFile);
    const owned = ownership.spawn(
      process.execPath,
      [path.join(appRoot, "scripts/cli/remote-serve.mjs"), ...args],
      {
        env,
        kill: "graceful",
        label,
        stdio: ["ignore", log.fd, log.fd],
      }
    );
    boot = { owned, log };
    try {
      await owned.registered;
      // The packaged installer gives this same startup command two minutes.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      while (!deadline.aborted) {
        if (owned.child.exitCode !== null || owned.child.signalCode !== null) break;
        const readback = await probe();
        if (readback.state === "ready") return;
        await delay(250, undefined, { signal: deadline }).catch(() => {});
      }
      signal.throwIfAborted();
      const tail = (await readFile(logPath, "utf8"))
        .split("\n")
        .slice(-18)
        .map((line) => line.slice(0, 240))
        .join("\n");
      throw new Error(`The ${label} never published a healthy managed workspace\n${tail}`);
    } catch (error) {
      await stop();
      throw error;
    }
  }

  return { observe: probe, start, close: stop };
}
