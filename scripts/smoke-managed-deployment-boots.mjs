/** Exercise the managed server command on two boots of one disposable profile. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectDeploymentIdentity } from "./cli/remote-deployment-workflow.mjs";
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
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      VIBESTUDIO_APP_ROOT: process.cwd(),
      VIBESTUDIO_PROFILE_ROOT: path.join(scratchRoot, "profile"),
      VIBESTUDIO_INSTANCE_ROOT: instance,
      VIBESTUDIO_SERVER_ENTRY: "live",
      VIBESTUDIO_DISABLE_DEV_TEMPLATE_MIRROR: "1",
    };

    async function verifyBoot(label) {
      const log = await open(path.join(scratchRoot, label + ".log"), "w", 0o600);
      const [, , ...args] = managedServerArgs(port, readyFile);
      const owned = ownership.spawn(process.execPath, ["scripts/cli/remote-serve.mjs", ...args], {
        env,
        kill: "graceful",
        label,
        stdio: ["ignore", log.fd, log.fd],
      });
      try {
        await owned.registered;
        // Match the managed installer's bounded readiness probe. The wrapper
        // itself owns the child and joins it on retirement.
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
        while (!deadline.aborted) {
          if (owned.child.exitCode !== null || owned.child.signalCode !== null) break;
          const readback = await inspectDeploymentIdentity({ readyFile, port });
          if (readback.state === "ready") return readback.identity;
          await delay(250, undefined, { signal: deadline }).catch(() => {});
        }
        signal.throwIfAborted();
        throw new Error(`The ${label} never published a healthy managed workspace`);
      } finally {
        await owned.retire().finally(() => log.close());
      }
    }

    const fresh = await verifyBoot("fresh-deployment");
    const successor = await verifyBoot("managed-restart");
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
