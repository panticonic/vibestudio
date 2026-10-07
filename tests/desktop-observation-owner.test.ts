import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createDesktopObservationOwner,
  createOwnedTemporaryDirectory,
} from "../scripts/lib/desktop-observation-owner.mjs";

it("retains the original observation until real target closure settles it", async () => {
  const owner = createDesktopObservationOwner();
  let closeTarget!: (reason: Error) => void;
  const original = new Promise<never>((_, reject) => {
    closeTarget = reject;
  });
  const read = owner.observe(() => original, "reading created panel readiness");
  let joined = false;
  owner.seal();
  expect(owner.snapshot().pendingAtRetirement).toEqual([
    { label: "reading created panel readiness", startedAt: expect.any(String) },
  ]);
  const join = owner.join().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(() => owner.observe(() => "another read")).toThrow("stopping");
  const targetClosed = new Error("Actual owned target closed");
  closeTarget(targetClosed);
  await expect(read).rejects.toBe(targetClosed);
  await join;
  expect(joined).toBe(true);
  expect(owner.snapshot()).toMatchObject({
    pending: [],
    pendingAtRetirement: [{ label: "reading created panel readiness" }],
    recent: [{ label: "reading created panel readiness", status: "rejected" }],
  });
});

it("propagates an original observation failure without inventing cleanup debt", async () => {
  const owner = createDesktopObservationOwner();
  const original = new Error("Renderer execution failed");
  await expect(
    owner.observe(() => {
      throw original;
    })
  ).rejects.toBe(original);
  owner.seal();
  await owner.join();
});

it("refuses directory admission after early owner cancellation", async () => {
  let allocations = 0;
  const owner = createOwnedTemporaryDirectory(
    () => {
      allocations++;
      return "never-created";
    },
    () => {
      throw new Error("No resource exists to remove");
    }
  );
  owner.seal();
  await owner.retire();
  expect(() => owner.acquire()).toThrow("stopping");
  expect(allocations).toBe(0);
});

it("joins a dispatched mkdtemp and retires its returned real directory after cancellation", async () => {
  let releaseAllocation!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseAllocation = resolve;
  });
  let removed = 0;
  const owner = createOwnedTemporaryDirectory(
    async () => {
      await gate;
      return fs.mkdtemp(path.join(os.tmpdir(), "dr-"));
    },
    async (root: string) => {
      removed++;
      await fs.rm(root, { recursive: true });
    }
  );
  const admitted = owner.acquire();
  let retired = false;
  owner.seal();
  const retirement = owner.retire().then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(() => owner.acquire()).toThrow("stopping");
  releaseAllocation();
  const root = await admitted;
  await retirement;
  await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  await owner.retire();
  expect(removed).toBe(1);
});

it("preserves the original failed atomic directory acquisition without a false cleanup error", async () => {
  const original = new Error("Filesystem refused mkdtemp");
  const owner = createOwnedTemporaryDirectory(
    () => {
      throw original;
    },
    () => {
      throw new Error("No directory was created");
    }
  );
  const admitted = owner.acquire();
  await expect(admitted).rejects.toBe(original);
  owner.seal();
  await owner.retire();
});
