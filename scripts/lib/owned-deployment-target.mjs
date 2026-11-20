import assert from "node:assert/strict";
import { createServer } from "node:net";
import { access, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { inspectDeploymentIdentity } from "../cli/remote-deployment-workflow.mjs";
import { managedServerArgs } from "../cli/remote-deploy.mjs";

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

export async function requireInstalledDeploymentPackage(appRoot) {
  const manifest = JSON.parse(await readFile(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@panticonic/vibestudio-server");
  await access(path.join(appRoot, "node_modules"));
}

export async function openOwnedDeploymentTarget({ appRoot, ownership, scratchRoot, signal }) {
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
        name === "VIBESTUDIO_MAX_CONCURRENT_BUILDS"
    )
  );
  const env = {
    ...inherited,
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
