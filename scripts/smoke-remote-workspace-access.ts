/** Exercise the host binding against an explicitly named disposable System Test instance. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bindRemoteWorkspaceAccess } from "../src/cli/remoteAccessWorkflow.js";
import { loadCliIdentity } from "../src/cli/credentialStore.js";
import { listRemoteWorkspaces } from "../src/cli/remoteClient.js";
import { readDevInstanceRecord } from "../src/dev/instanceRegistry.js";
import { isManagedSystemTestInstance } from "../src/dev/systemTestInstance.js";

const instanceName = process.argv[2];
if (!instanceName) throw new Error("Pass the name of an owned, disposable System Test instance");
const instance = readDevInstanceRecord(path.resolve(import.meta.dirname, ".."), instanceName);
if (!isManagedSystemTestInstance(instance) || instance.lifecycle !== "ephemeral")
  throw new Error("The remote workflow smoke requires a disposable managed instance");

const identity = loadCliIdentity(path.join(instance.root, "cli-credentials.json"));
assert(identity?.kind === "device" && identity.phase === "workspace");
assert.equal(identity.transport, "local");
const workspace = (await listRemoteWorkspaces(identity)).find(
  ({ workspaceId }) => workspaceId === identity.workspaceId
);
assert(workspace, "The assigned workspace must be visible by its exact ID");

const directory = await mkdtemp(path.join(instance.root, "natlang-remote-access-"));
const credentialFile = path.join(directory, "pairing.json");
const routeAssignment = {
  credentialFile,
  serverId: identity.serverId,
  workspaceId: workspace.workspaceId,
  signal: AbortSignal.timeout(120_000),
};
const sponsor = {
  gatewayUrl: new URL(identity.url).origin,
  serverId: identity.serverId,
  workspaceId: identity.workspaceId,
  workspaceName: identity.workspaceName,
  deviceId: identity.deviceId,
  refreshToken: identity.refreshToken,
};

async function openRoute(binding: ReturnType<typeof bindRemoteWorkspaceAccess>, prior: string) {
  const { remoteAccessRoute, remoteAccessVerify } = binding.services;
  const routed = await remoteAccessRoute.select(prior);
  assert.equal(routed.state, "routed");
  await assert.rejects(remoteAccessVerify.verify("foreign-route"), /another attempt/u);
  const verified = await remoteAccessVerify.verify(routed.receipt);
  assert.equal(verified.state, "verified");
  assert.equal(verified.workspaceId, workspace!.workspaceId);
  await assert.rejects(remoteAccessVerify.verify(routed.receipt), /requires the assigned/u);
}

try {
  const withoutInvite = bindRemoteWorkspaceAccess(routeAssignment);
  const unpaired = await withoutInvite.services.remoteAccessRead.observe(
    withoutInvite.request.operationId
  );
  assert.equal(unpaired.state, "unpaired");
  assert.equal(unpaired.inviteAssigned, false);
  await assert.rejects(
    withoutInvite.services.remoteAccessPair.pair(unpaired.receipt),
    /requires the assigned invite/u
  );

  const pairing = bindRemoteWorkspaceAccess({
    ...routeAssignment,
    invitation: { kind: "local-device", sponsor, label: "Owned Natlang remote smoke" },
  });
  const profile = await pairing.services.remoteAccessRead.observe(pairing.request.operationId);
  assert.deepEqual(
    { state: profile.state, invite: profile.inviteAssigned },
    { state: "unpaired", invite: true }
  );
  const accepted = await pairing.services.remoteAccessPair.pair(profile.receipt);
  assert.equal(accepted.state, "paired");
  await openRoute(pairing, accepted.receipt);

  const saved = loadCliIdentity(credentialFile);
  assert(saved?.kind === "device" && saved.phase === "workspace");
  assert.notEqual(saved.deviceId, identity.deviceId);
  assert.equal(saved.workspaceId, workspace.workspaceId);

  const resume = bindRemoteWorkspaceAccess(routeAssignment);
  const existing = await resume.services.remoteAccessRead.observe(resume.request.operationId);
  assert.equal(existing.state, "workspace");
  await openRoute(resume, existing.receipt);
  const confirmed = loadCliIdentity(credentialFile);
  assert(confirmed?.kind === "device");
  assert.equal(confirmed.deviceId, saved.deviceId);

  const foreign = bindRemoteWorkspaceAccess({ ...routeAssignment, serverId: "different-server" });
  const unrelated = await foreign.services.remoteAccessRead.observe(foreign.request.operationId);
  assert.equal(unrelated.state, "foreign");
  await assert.rejects(
    foreign.services.remoteAccessRoute.select(unrelated.receipt),
    /requires the assigned paired/u
  );

  const stale = bindRemoteWorkspaceAccess(routeAssignment);
  const beforeChange = await stale.services.remoteAccessRead.observe(stale.request.operationId);
  const original = await readFile(credentialFile, "utf8");
  await writeFile(credentialFile, original + "\n");
  await assert.rejects(
    stale.services.remoteAccessRoute.select(beforeChange.receipt),
    /changed after observation/u
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(
  JSON.stringify({ paired: true, resumed: true, foreignRejected: true, staleRejected: true })
);
