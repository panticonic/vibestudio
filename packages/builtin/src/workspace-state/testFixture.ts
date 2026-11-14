/**
 * Test-only subclass of WorkspaceStateDO: a helper for slots created on behalf
 * of an owner, and a Dolt cell for the object (`createWorkspaceStateTestDO`).
 *
 * Do not use in production code.
 */

import { FakeDoltStorage, type FakeDoltOptions } from "@vibestudio/durable/test-dolt";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { WORKSPACE_STATE_DOLT_LOCAL, WorkspaceStateDO } from "./WorkspaceStateDO.js";

export class WorkspaceDOTestable extends WorkspaceStateDO {
  slotCreateAs(
    ownerUserId: string | undefined,
    input: Parameters<WorkspaceStateDO["slotCreate"]>[0]
  ): void {
    this.slotCreate({ ...input, ...(ownerUserId ? { ownerUserId } : {}) });
  }
}

/**
 * A WorkspaceStateDO on a fake Dolt cell, declared the way the deployment
 * declares it (`doltLocal`). Pass an earlier `fake` (after `restart()`) to
 * reopen the same store.
 */
export async function createWorkspaceStateTestDO(
  options: { fake?: FakeDoltStorage; fakeOptions?: FakeDoltOptions; env?: Record<string, unknown> } = {}
) {
  const fake =
    options.fake ??
    (await FakeDoltStorage.create({
      doltLocal: WORKSPACE_STATE_DOLT_LOCAL,
      ...options.fakeOptions,
    }));
  const created = await createTestDO(
    WorkspaceDOTestable,
    { WORKER_CLASS_NAME: "WorkspaceStateDO", ...options.env },
    { storage: fake.storage }
  );
  return { ...created, fake };
}
