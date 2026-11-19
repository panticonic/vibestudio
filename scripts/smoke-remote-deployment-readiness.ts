/** Read hub and child deployment identity from an owned live catalog workspace. */
import assert from "node:assert/strict";
import path from "node:path";
import { loadCliIdentity } from "../src/cli/credentialStore.js";
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
const observed = await inspectDeploymentIdentity({
  readyFile: path.join(instance.root, "server-auth", "hub-ready.json"),
  port: Number(new URL(profile.url).port),
  workspace: profile.workspaceName,
});
assert.equal(observed.state, "ready");
assert.equal(observed.identity?.serverId, profile.serverId);
assert.equal(observed.identity?.workspaceId, profile.workspaceId);
console.log(JSON.stringify({ matchedHub: true, matchedWorkspace: true }));
