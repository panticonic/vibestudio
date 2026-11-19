/** Read hub and child deployment identity from an owned live catalog workspace. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { loadCliIdentity } from "../src/cli/credentialStore.js";
import { bindRemoteCommission } from "../src/cli/remoteCommissionWorkflow.js";
import { readDevInstanceRecord } from "../src/dev/instanceRegistry.js";
import { isManagedSystemTestInstance } from "../src/dev/systemTestInstance.js";
import { inspectDeploymentIdentity } from "./cli/remote-deployment-workflow.mjs";

const name = process.argv[2];
if (!name) throw new Error("Pass an owned, disposable catalog workspace instance");
const instance = readDevInstanceRecord(path.resolve(import.meta.dirname, ".."), name);
assert(isManagedSystemTestInstance(instance) && instance.lifecycle === "ephemeral");
const profile = loadCliIdentity(path.join(instance.root, "cli-credentials.json"));
assert(
  profile?.kind === "device" && profile.phase === "workspace" && profile.transport === "local"
);
const origin = new URL(profile.url);
const probe = () =>
  inspectDeploymentIdentity({
    readyFile: path.join(instance.root, "server-auth", "hub-ready.json"),
    port: Number(origin.port),
    workspace: profile.workspaceName,
  });

const observed = await probe();
assert.equal(observed.state, "ready");
assert.equal(observed.identity?.serverId, profile.serverId);
assert.equal(observed.identity?.workspaceId, profile.workspaceId);

const directory = await mkdtemp(path.join(instance.root, "natlang-remote-commission-"));
const credentialFile = path.join(directory, "profile.json");
try {
  const { request, services } = bindRemoteCommission(
    ["local"],
    {
      credentialFile,
      async pairingFor(identity) {
        assert.equal(identity.serverId, profile.serverId);
        assert.equal(identity.workspaceId, profile.workspaceId);
        return {
          invitation: {
            kind: "local-device",
            label: "Owned Natlang commission smoke",
            sponsor: {
              gatewayUrl: origin.origin,
              serverId: profile.serverId,
              workspaceId: profile.workspaceId,
              workspaceName: profile.workspaceName,
              deviceId: profile.deviceId,
              refreshToken: profile.refreshToken,
            },
          },
        };
      },
    },
    {
      signal: AbortSignal.timeout(120_000),
      async run(_command, _args, options) {
        assert(options?.capture, "The disposable instance must already be running");
        return JSON.stringify(await probe());
      },
    }
  );
  await assert.rejects(services.remoteAccessRead.observe(request.operationId), /not assigned/u);
  const baseline = await services.remoteDeploymentRead.observe(request.operationId);
  assert.equal(baseline.state, "ready");
  await assert.rejects(services.remoteDeploymentHandoff.open("foreign"), /current attempt/u);
  const handoff = await services.remoteDeploymentHandoff.open(baseline.receipt);
  assert(handoff.state === "assigned" && handoff.operationId);
  await assert.rejects(services.remoteDeploymentHandoff.open(baseline.receipt), /current attempt/u);
  const readback = await services.remoteAccessRead.observe(handoff.operationId);
  assert.equal(readback.state, "unpaired");
  const paired = await services.remoteAccessPair.pair(readback.receipt);
  assert.equal(paired.state, "paired");
  const selected = await services.remoteAccessRoute.select(paired.receipt);
  assert.equal(selected.state, "routed");
  const verified = await services.remoteAccessVerify.verify(selected.receipt);
  assert.equal(verified.state, "verified");
  assert.equal(verified.workspaceId, observed.identity.workspaceId);
  const saved = loadCliIdentity(credentialFile);
  assert(saved?.kind === "device" && saved.phase === "workspace");
  assert.notEqual(saved.deviceId, profile.deviceId);
  assert.equal(saved.workspaceId, observed.identity.workspaceId);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ matchedHub: true, matchedWorkspace: true, newDeviceVerified: true }));
