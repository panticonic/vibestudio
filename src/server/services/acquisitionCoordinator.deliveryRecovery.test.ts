import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";

const fixtures: Array<{
  statePath: string;
  grantStore: CapabilityGrantStore;
  coordinators: AcquisitionCoordinator[];
}> = [];
function fixture() {
  const statePath = mkdtempSync(join(tmpdir(), "authority-delivery-recovery-"));
  const grantStore = new CapabilityGrantStore({ statePath });
  const notifyOwner = vi.fn(async (_runtime: string, _id: string, _signal: AbortSignal) => {});
  const coordinators: AcquisitionCoordinator[] = [];
  const f = {
    statePath,
    grantStore,
    notifyOwner,
    coordinators,
    coordinator() {
      const coordinator = new AcquisitionCoordinator({
        grantStore: f.grantStore,
        approvalQueue: {} as ApprovalQueue,
        notifyOwner,
      });
      coordinators.push(coordinator);
      return coordinator;
    },
    terminal(index: number, runtime = "do:workers/test:Agent:one") {
      const admission = {
        ownerRuntimeId: runtime,
        sessionId: `session-${index % 3}`,
        requestKey: `request-${index}`,
        facts: { original: index },
      };
      const pending = f.grantStore.acquisitions.admit(admission, 1);
      return f.grantStore.acquisitions.resolve(
        pending.acquisitionId,
        admission,
        pending.bindingDigest,
        "deny",
        () => ({ state: "decided", value: { decision: "deny" } }),
        2
      );
    },
    reopen() {
      f.grantStore.close();
      f.grantStore = new CapabilityGrantStore({ statePath });
    },
  };
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const coordinator of f.coordinators) await coordinator.quiesceOwnerDelivery();
    f.grantStore.close();
    rmSync(f.statePath, { recursive: true });
  }
});

describe("canonical acquisition delivery recovery", () => {
  it("reprojects retained terminal debt after reopen, and removes debt only on exact acknowledgement", async () => {
    const f = fixture();
    const terminal = f.terminal(0);
    f.reopen();
    const coordinator = f.coordinator();
    await coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledExactlyOnceWith(
      terminal.admission.ownerRuntimeId,
      terminal.acquisitionId,
      expect.any(AbortSignal)
    );
    expect(f.grantStore.acquisitions.outstanding(terminal.admission)).toEqual([terminal]);
    await coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledTimes(2);
    f.grantStore.acquisitions.acknowledge(
      terminal.acquisitionId,
      terminal.admission,
      terminal.resolutionDigest!
    );
    await coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("retains in-band terminal receipts without inventing a durable callback across restart", async () => {
    const f = fixture();
    const terminal = f.terminal(0, "do:workers/test:MissionsDO:ordinary");
    f.grantStore.acquisitions.setDeliveryOwner(
      terminal.acquisitionId,
      terminal.admission,
      "in-band"
    );
    f.reopen();
    const coordinator = f.coordinator();
    await coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).not.toHaveBeenCalled();
    const retained = f.grantStore.acquisitions.get(terminal.acquisitionId, terminal.admission)!;
    expect(retained.deliveryOwner).toBe("in-band");
    expect(retained.acknowledgedAt).toBeUndefined();
    expect(retained.resolutionDigest).toBe(terminal.resolutionDigest);
    f.grantStore.acquisitions.setDeliveryOwner(
      terminal.acquisitionId,
      terminal.admission,
      "owner-redrive"
    );
    await coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledExactlyOnceWith(
      terminal.admission.ownerRuntimeId,
      terminal.acquisitionId,
      expect.any(AbortSignal)
    );
    expect(
      f.grantStore.acquisitions.get(terminal.acquisitionId, terminal.admission)?.acknowledgedAt
    ).toBeUndefined();
  });

  it("continues a bounded traversal past failed routes, preserves the original error, and recovers on the next readiness event", async () => {
    const f = fixture();
    const records = Array.from({ length: 70 }, (_, index) => f.terminal(index));
    const failure = new Error("first owner route unavailable");
    f.notifyOwner.mockRejectedValueOnce(failure);
    const coordinator = f.coordinator();
    const scan = vi.spyOn(f.grantStore.acquisitions, "scanOutstandingTerminal");
    let rejected: unknown;
    try {
      await coordinator.reprojectOwnerDelivery();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(AggregateError);
    expect((rejected as AggregateError).cause).toBe(failure);
    expect((rejected as AggregateError).errors).toEqual([failure]);
    expect(f.notifyOwner).toHaveBeenCalledTimes(70);
    expect(scan.mock.results.map((result) => result.value.length)).toEqual([64, 6, 0]);
    await coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledTimes(140);
    expect(new Set(f.notifyOwner.mock.calls.map(([, id]) => id))).toEqual(
      new Set(records.map((record) => record.acquisitionId))
    );
  });

  it("shares concurrent readiness traversals and joins the exact admitted notification", async () => {
    const f = fixture();
    f.terminal(0);
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.notifyOwner.mockReturnValue(delivery);
    const coordinator = f.coordinator();
    const first = coordinator.reprojectOwnerDelivery();
    const second = coordinator.reprojectOwnerDelivery();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.notifyOwner).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(f.notifyOwner).toHaveBeenCalledOnce();
  });

  it("explicit shutdown cancels and joins delivery without acknowledging or retiring its receipt", async () => {
    const f = fixture();
    const record = f.terminal(0);
    let joined = false;
    f.notifyOwner.mockImplementation(
      async (_runtime, _id, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              joined = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const coordinator = f.coordinator();
    const recovery = coordinator.reprojectOwnerDelivery();
    const rejected = expect(recovery).rejects.toThrow("owner delivery stopped");
    await vi.waitFor(() => expect(f.notifyOwner).toHaveBeenCalledOnce());
    await coordinator.quiesceOwnerDelivery();
    await rejected;
    expect(joined).toBe(true);
    expect(f.grantStore.acquisitions.outstanding(record.admission)).toEqual([record]);
    await expect(coordinator.reprojectOwnerDelivery()).rejects.toThrow("owner delivery stopped");
    expect(f.notifyOwner).toHaveBeenCalledOnce();
  });
});
