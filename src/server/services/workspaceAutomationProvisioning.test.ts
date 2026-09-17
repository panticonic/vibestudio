import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAutomationProvisioner } from "./workspaceAutomationProvisioning";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { EntityRecord, RuntimeEntityHandle } from "@vibestudio/shared/runtime/entitySpec";

const definition = {
  source: "workers/agent-worker",
  className: "AiChatWorker",
  name: "Updates",
  summary: "Monitor updates",
  action: {
    kind: "watch" as const,
    code: 'return { protocol: "automation-signal.v1", prompt: null };',
  },
  trigger: { kind: "schedule" as const, everyMs: 21600000 },
  operations: [],
};
function fixture() {
  const config: WorkspaceConfig = {
    id: "workspace",
    systemEpoch: 0,
    defaultAutomations: { updates: definition },
  };
  const members = [{ userId: "alice", handle: "alice" }];
  const createEntity = vi.fn(
    async (_caller, spec) =>
      ({
        id: `do:${spec.execution.source}:${spec.className}:${spec.key}`,
        contextId: `context:${spec.key}`,
      }) as RuntimeEntityHandle
  );
  const dispatch = vi.fn(async () => undefined);
  const failed = vi.fn();
  const entity = vi.fn(async (_id: string): Promise<EntityRecord | null> => null);
  const deps = {
    config: () => config,
    members: () => members,
    runtime: () => ({ createEntity }),
    entity,
    dispatch,
    failed,
  };
  return {
    config,
    members,
    createEntity,
    dispatch,
    failed,
    entity,
    deps,
    provisioner: createWorkspaceAutomationProvisioner(deps),
  };
}
describe("workspace automation provisioning", () => {
  it("provisions without any panel and attributes each runtime to its actual member", async () => {
    const f = fixture();
    f.members.push({ userId: "bob", handle: "bob" });
    await Promise.all([f.provisioner.reconcile(), f.provisioner.reconcile()]);
    expect(f.createEntity).toHaveBeenCalledTimes(2);
    expect(f.createEntity.mock.calls.map(([caller]) => caller.subject.userId)).toEqual([
      "alice",
      "bob",
    ]);
    expect(f.dispatch.mock.calls).toHaveLength(2);
    await f.provisioner.reconcile();
    expect(f.createEntity).toHaveBeenCalledTimes(2);
  });
  it("reuses a durable runtime after host restart and lets its owner reconcile defaults", async () => {
    const f = fixture();
    f.entity.mockResolvedValue({
      status: "active",
      ownerUserId: "alice",
      contextId: "existing",
    } as EntityRecord);
    await f.provisioner.reconcile();
    expect(f.createEntity).not.toHaveBeenCalled();
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      "initializeAutomation",
      expect.objectContaining({ contextId: "existing" })
    );
  });
  it("respects suppressed defaults and retired runtime identities", async () => {
    const f = fixture();
    f.config.defaultAutomations!["updates"] = null;
    await f.provisioner.reconcile();
    expect(f.dispatch).not.toHaveBeenCalled();
    f.config.defaultAutomations!["updates"] = definition;
    f.entity.mockResolvedValue({ status: "retired", ownerUserId: "alice" } as EntityRecord);
    await f.provisioner.reconcile();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("reports a failed setup and retries on the next lifecycle reconciliation", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error("build unavailable"));
    await f.provisioner.reconcile();
    expect(f.failed).toHaveBeenCalledOnce();
    await f.provisioner.reconcile();
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
});
