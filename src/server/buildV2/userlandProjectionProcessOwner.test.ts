import { beforeEach, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  failures: new Map<string, unknown>(),
}));

vi.mock("./externalDeps.js", () => ({
  drainExternalDependencyPruning: async () => {
    lifecycle.events.push("external-prunes");
    if (lifecycle.failures.has("external-prunes")) throw lifecycle.failures.get("external-prunes");
  },
}));

vi.mock("./dependencyContentMaintenance.js", () => ({
  drainDependencyContentMaintenance: async () => {
    lifecycle.events.push("content-maintenance");
    if (lifecycle.failures.has("content-maintenance"))
      throw lifecycle.failures.get("content-maintenance");
  },
}));

vi.mock("@vibestudio/shared/derivedCache", () => ({
  closeDerivedCacheCoordinators: async () => {
    lifecycle.events.push("coordinators");
    if (lifecycle.failures.has("coordinators")) throw lifecycle.failures.get("coordinators");
  },
}));

import { retireUserlandProjectionProcess } from "../../../scripts/lib/userland-projection-process-owner.js";

beforeEach(() => {
  lifecycle.events.length = 0;
  lifecycle.failures.clear();
});

it("releases process-owned projections before draining every dependent cleanup stage", async () => {
  const releaseFailure = new Error("projection release failed");
  const pruneFailure = new Error("external prune failed");
  const maintenanceFailure = new Error("content maintenance failed");
  const coordinatorFailure = new Error("coordinator close failed");
  lifecycle.failures.set("external-prunes", pruneFailure);
  lifecycle.failures.set("content-maintenance", maintenanceFailure);
  lifecycle.failures.set("coordinators", coordinatorFailure);

  await expect(
    retireUserlandProjectionProcess([
      () => {
        lifecycle.events.push("release");
        throw releaseFailure;
      },
    ])
  ).rejects.toMatchObject({
    errors: [releaseFailure, pruneFailure, maintenanceFailure, coordinatorFailure],
    cause: releaseFailure,
  });
  expect(lifecycle.events).toEqual([
    "release",
    "external-prunes",
    "content-maintenance",
    "coordinators",
  ]);
});

it("preserves the original error identity when the sole retirement stage fails", async () => {
  const failure = new Error("projection release failed");
  await expect(
    retireUserlandProjectionProcess([
      () => {
        throw failure;
      },
    ])
  ).rejects.toBe(failure);
  expect(lifecycle.events).toEqual(["external-prunes", "content-maintenance", "coordinators"]);
});
