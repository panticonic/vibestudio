/** Exercise the managed server command on two boots of one disposable profile. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import {
  bindRemoteDeploymentTarget,
  inspectDeploymentIdentity,
} from "./cli/remote-deployment-workflow.mjs";
import { managedServerArgs } from "./cli/remote-deploy.mjs";
import { ownedEntry } from "./lib/owned-entry.mjs";

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

await ownedEntry(
  async ({ ownership, scratchRoot, signal }) => {
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
      VIBESTUDIO_APP_ROOT: process.cwd(),
      VIBESTUDIO_PROFILE_ROOT: path.join(scratchRoot, "profile"),
      VIBESTUDIO_INSTANCE_ROOT: instance,
      VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: getSharedDerivedDataPath(),
      VIBESTUDIO_SERVER_ENTRY: "live",
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
      const owned = ownership.spawn(process.execPath, ["scripts/cli/remote-serve.mjs", ...args], {
        env,
        kill: "graceful",
        label,
        stdio: ["ignore", log.fd, log.fd],
      });
      boot = { owned, log };
      try {
        await owned.registered;
        // The checkout includes cold release preparation before server startup.
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(240_000)]);
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

    async function exercise(intent, initialState) {
      const label = intent === "deploy" ? "fresh-deployment" : "managed-restart";
      let launchError;
      const { request, services, takeVerifiedIdentity } = bindRemoteDeploymentTarget({
        intent,
        signal,
        observe: probe,
        async apply() {
          try {
            await start(label);
          } catch (error) {
            launchError = error;
            throw error;
          }
        },
      });
      const baseline = await services.remoteDeploymentRead.observe(request.operationId);
      assert.equal(baseline.state, initialState);
      assert.equal(baseline.hasPriorIdentity, intent === "update");
      const action = await services.remoteDeploymentApply.apply(baseline.receipt);
      if (launchError) throw launchError;
      assert.equal(action.state, "applied", `The ${intent} did not apply`);
      const verified = await services.remoteDeploymentVerify.verify(action.receipt);
      assert.equal(verified.state, "verified");
      const confirmed = await takeVerifiedIdentity(verified.receipt);
      assert.deepEqual(confirmed, verified.identity);
      return confirmed;
    }

    let fresh;
    let successor;
    try {
      fresh = await exercise("deploy", "inactive");
      successor = await exercise("update", "ready");
    } finally {
      await stop();
    }
    assert.equal(successor.serverId, fresh.serverId);
    assert.equal(successor.workspaceId, fresh.workspaceId);
    assert.notEqual(successor.bootId, fresh.bootId);
    console.log(
      JSON.stringify({
        registeredDefault: true,
        preservedServer: true,
        preservedWorkspace: true,
        successorBoot: true,
      })
    );
  },
  { appRoot: process.cwd(), scratchPrefix: "vibestudio-managed-deployment-" }
);
