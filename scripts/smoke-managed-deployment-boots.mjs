/** Exercise the managed server command on two boots of one disposable profile. */
import assert from "node:assert/strict";
import path from "node:path";
import { bindRemoteDeploymentTarget } from "./cli/remote-deployment-workflow.mjs";
import {
  openOwnedDeploymentTarget,
  requireInstalledDeploymentPackage,
} from "./lib/owned-deployment-target.mjs";
import { ownedEntry } from "./lib/owned-entry.mjs";

const packagePath = process.argv[2];
if (!packagePath || process.argv.length !== 3)
  throw new Error("Pass the installed Vibestudio server npm package directory");
const appRoot = path.resolve(packagePath);
await requireInstalledDeploymentPackage(appRoot);

await ownedEntry(
  async ({ ownership, scratchRoot, signal }) => {
    const { observe, start, close } = await openOwnedDeploymentTarget({
      appRoot,
      ownership,
      scratchRoot,
      signal,
    });

    async function exercise(intent, initialState) {
      const label = intent === "deploy" ? "fresh-deployment" : "managed-restart";
      let launchError;
      const { request, services, takeVerifiedIdentity } = bindRemoteDeploymentTarget({
        intent,
        signal,
        observe,
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
      await close();
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
  { appRoot, scratchPrefix: "vibestudio-managed-deployment-" }
);
