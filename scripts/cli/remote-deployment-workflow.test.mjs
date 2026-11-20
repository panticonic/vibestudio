import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectDeploymentIdentity } from "./remote-deployment-workflow.mjs";

test("a live workspace added after hub startup needs a trusted coordinate and exact health", async () => {
  const ready = {
    mode: "hub", gatewayPort: 34001, buildId: "a".repeat(64),
    serverId: "srv_" + "b".repeat(24), serverBootId: "boot_" + "c".repeat(24),
    pid: 12, workspaces: [],
  };
  const child = { ok: true, serverId: ready.serverId, workspaceId: "assigned-workspace" };
  const options = {
    readyFile: "owned-ready.json",
    port: ready.gatewayPort,
    workspace: "late-workspace",
    fileSystem: {
      lstatSync: () => ({ isFile: () => true, mode: 0o600, size: 1024 }),
      readFileSync: () => JSON.stringify(ready),
    },
    fetchImpl: async (url) => new Response(JSON.stringify(
      new URL(url).pathname === "/healthz" ? { ok: true, ...ready } : child
    )),
  };
  assert.deepEqual(await inspectDeploymentIdentity(options), { state: "unverified", identity: null });
  const assigned = { ...options, expectedWorkspaceId: child.workspaceId };
  assert.deepEqual(await inspectDeploymentIdentity(assigned), {
    state: "ready",
    identity: { serverId: ready.serverId, bootId: ready.serverBootId, buildId: ready.buildId, workspaceId: child.workspaceId },
  });
  assert.deepEqual(await inspectDeploymentIdentity({ ...assigned, active: false }), {
    state: "inactive", identity: null,
  });
  assert.equal((await inspectDeploymentIdentity({ ...assigned, expectedWorkspaceId: "other" })).state, "unverified");
  ready.workspaces.push({ name: options.workspace, workspaceId: "different-registered-id" });
  assert.equal((await inspectDeploymentIdentity(assigned)).state, "unverified");
});
