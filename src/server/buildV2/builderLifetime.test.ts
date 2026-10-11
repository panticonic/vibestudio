import { describe, expect, it } from "vitest";
import {
  BuildFlight,
  BuildPriorityOwner,
  BuildSlotQueue,
  BuilderLifetime,
} from "./builderLifetime.js";
import { hasBuildSlotCapacity } from "./builder.js";

describe("builder lifetime ownership", () => {
  it("rejects queued work on close, leaves admitted work owned until release", async () => {
    const queue = new BuildSlotQueue(1);
    const active = await queue.acquire("interactive", hasBuildSlotCapacity);
    const queued = queue.acquire("background", hasBuildSlotCapacity);
    const reason = new Error("builder closing");
    queue.close(reason);

    await expect(queued).rejects.toBe(reason);
    expect(queue.queuedCount).toBe(0);
    // Closing admission does not revoke a permit from work that already owns it.
    active.release();
    expect(queue.queuedCount).toBe(0);
  });

  it("removes an aborted waiter without consuming a later permit", async () => {
    const queue = new BuildSlotQueue(1);
    const active = await queue.acquire("interactive", hasBuildSlotCapacity);
    const controller = new AbortController();
    const waiter = queue.acquire("background", hasBuildSlotCapacity, controller.signal);
    const reason = new Error("startup cancelled");
    controller.abort(reason);

    await expect(waiter).rejects.toBe(reason);
    expect(queue.queuedCount).toBe(0);
    active.release();
    const next = await queue.acquire("interactive", hasBuildSlotCapacity);
    next.release();
  });

  it("promotes the same queued build admission when stronger demand joins", async () => {
    const queue = new BuildSlotQueue(1);
    const active = await queue.acquire("interactive", hasBuildSlotCapacity);
    let bindAdmission!: () => void;
    const admissionBound = new Promise<void>((resolve) => {
      bindAdmission = resolve;
    });
    const flight = new BuildFlight("speculative", async (owner) => {
      const lease = await queue.acquire(
        owner.priority,
        hasBuildSlotCapacity,
        undefined,
        (promote) => {
          owner.bindQueuedPromotion(promote);
          bindAdmission();
        }
      );
      return lease;
    });
    const otherBackground = queue.acquire("background", hasBuildSlotCapacity);

    await admissionBound;
    expect(queue.queuedCount).toBe(2);
    const adopted = flight.adopt("interactive");
    expect(adopted).toBe(flight.promise);
    active.release();

    const promotedLease = await flight.promise;
    expect(promotedLease.priority).toBe("interactive");
    expect(queue.queuedCount).toBe(1);
    promotedLease.release();
    const backgroundLease = await otherBackground;
    backgroundLease.release();
    expect(queue.queuedCount).toBe(0);
  });

  it("runs one build operation for multiple callers of a flight", async () => {
    let calls = 0;
    const flight = new BuildFlight("background", async () => {
      calls += 1;
      return "built";
    });
    const first = flight.promise;
    const second = flight.adopt("interactive");

    expect(second).toBe(first);
    await expect(second).resolves.toBe("built");
    expect(calls).toBe(1);
  });

  it("does not change the priority of work that already owns a build slot", async () => {
    const queue = new BuildSlotQueue(1);
    const owner = new BuildPriorityOwner("speculative");
    const lease = await queue.acquire(owner.priority, hasBuildSlotCapacity, undefined, (promote) =>
      owner.bindQueuedPromotion(promote)
    );

    owner.promote("interactive");

    expect(owner.priority).toBe("interactive");
    expect(lease.priority).toBe("speculative");
    lease.release();
  });

  it("keeps a build's strongest requested priority without demoting it", () => {
    const owner = new BuildPriorityOwner("speculative");

    owner.promote("background");
    expect(owner.priority).toBe("background");
    owner.promote("speculative");
    expect(owner.priority).toBe("background");
    owner.promote("interactive");
    expect(owner.priority).toBe("interactive");
  });

  it("rejects explicit undefined close reasons and remains closed", async () => {
    const queue = new BuildSlotQueue(1);
    const active = await queue.acquire("interactive", hasBuildSlotCapacity);
    const queued = queue.acquire("background", hasBuildSlotCapacity);
    queue.close(undefined);

    await expect(queued).rejects.toBeUndefined();
    await expect(queue.acquire("interactive", hasBuildSlotCapacity)).rejects.toBeUndefined();
    active.release();
  });

  it("stops admission and joins every admitted operation, including falsy failures", async () => {
    const lifetime = new BuilderLifetime();
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = () => resolve();
    });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const first = lifetime.run(async () => {
      releaseFirst();
      await firstGate;
      throw undefined;
    });
    const secondFailure = new Error("second operation failed");
    const second = lifetime.run(async () => {
      throw secondFailure;
    });
    await firstStarted;

    const close = lifetime.close();
    await expect(lifetime.run(async () => undefined)).rejects.toThrow("shutting down");
    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    finishFirst();

    const failures = await close;
    await Promise.allSettled([first, second]);
    expect(failures).toEqual([undefined, secondFailure]);
    expect(lifetime.isDrained).toBe(true);
  });
});
