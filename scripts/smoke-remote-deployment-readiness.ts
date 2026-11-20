/** Read hub and child deployment identity from an owned live catalog workspace. */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readDevInstanceRecord } from "../src/dev/instanceRegistry.js";
import { isManagedSystemTestInstance } from "../src/dev/systemTestInstance.js";
import { openOwnedRemoteCommission } from "../src/dev/terminalDevice/remoteCommission.js";

type RemoteSmoke = Awaited<ReturnType<typeof openOwnedRemoteCommission>>;
export async function withRemoteCommissionSmoke<T>(
  name: string,
  exercise: (assignment: RemoteSmoke) => Promise<T>
): Promise<T> {
  const instance = readDevInstanceRecord(path.resolve(import.meta.dirname, ".."), name);
  assert(isManagedSystemTestInstance(instance) && instance.lifecycle === "ephemeral");
  const attempt = await openOwnedRemoteCommission(
    instance.root,
    instance.root,
    AbortSignal.timeout(120_000)
  );
  try {
    return await exercise(attempt);
  } finally {
    await attempt.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const name = process.argv[2];
  if (!name) throw new Error("Pass an owned, disposable catalog workspace instance");
  await withRemoteCommissionSmoke(name, async ({ request, services, identity, verify }) => {
    await assert.rejects(services.remoteAccessRead.observe(request.operationId), /not assigned/u);
    const baseline = await services.remoteDeploymentRead.observe(request.operationId);
    assert.equal(baseline.state, "ready");
    await assert.rejects(services.remoteDeploymentHandoff.open("foreign"), /current attempt/u);
    const handoff = await services.remoteDeploymentHandoff.open(baseline.receipt);
    assert(handoff.state === "assigned" && handoff.operationId);
    await assert.rejects(
      services.remoteDeploymentHandoff.open(baseline.receipt),
      /current attempt/u
    );
    const readback = await services.remoteAccessRead.observe(handoff.operationId);
    assert.equal(readback.state, "unpaired");
    const paired = await services.remoteAccessPair.pair(readback.receipt);
    assert.equal(paired.state, "paired");
    const selected = await services.remoteAccessRoute.select(paired.receipt);
    assert.equal(selected.state, "routed");
    const verified = await services.remoteAccessVerify.verify(selected.receipt);
    assert.equal(verified.state, "verified");
    assert.equal(verified.workspaceId, identity.workspaceId);
    assert.deepEqual(await verify(), { stableDeployment: true, persistedNewProfile: true });
  });
  console.log(
    JSON.stringify({ matchedHub: true, matchedWorkspace: true, newDeviceVerified: true })
  );
}
