import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => true),
}));

import {
  DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS,
  dependencyContentMaintenanceEntry,
  drainDependencyContentMaintenance,
  prepareDependencyContent,
  scheduleDependencyContentPrune,
} from "./dependencyContentMaintenance.js";
import { serializeRpcFailure } from "@vibestudio/rpc";

function makeChild() {
  return new EventEmitter();
}

function reportResults(child: EventEmitter, results: unknown[]) {
  child.emit("message", { type: "dependency-maintenance-results", results });
}

describe("dependency content maintenance scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fork.mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(async () => {
    await drainDependencyContentMaintenance();
    delete process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"];
    vi.useRealTimers();
  });

  it("batches private preparation tickets into one owned process immediately", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    const appRoot = process.cwd();
    const firstCache = "/tmp/profile/derived-cache/external-deps/1111111111111111";
    const secondCache = "/tmp/profile/derived-cache/external-deps/2222222222222222";
    const first = `${firstCache}.tmp.${"a".repeat(32)}`;
    const second = `${secondCache}.tmp.${"b".repeat(32)}`;

    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = appRoot;
    const firstTicket = prepareDependencyContent(first, firstCache, appRoot);
    const secondTicket = prepareDependencyContent(second, secondCache, appRoot);
    await vi.advanceTimersByTimeAsync(0);

    expect(fork).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(
      dependencyContentMaintenanceEntry(appRoot),
      [
        JSON.stringify({
          hostArtifactRoot: appRoot,
          preparations: [
            { stagingDir: path.resolve(first), cacheDir: path.resolve(firstCache) },
            { stagingDir: path.resolve(second), cacheDir: path.resolve(secondCache) },
          ],
          prune: false,
        }),
      ],
      expect.objectContaining({
        execPath: process.execPath,
        execArgv: [],
        detached: false,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: expect.objectContaining({ VIBESTUDIO_HOST_ARTIFACT_ROOT: appRoot }),
      })
    );
    reportResults(child, [{ ok: true }, { ok: true }]);
    child.emit("close", 0, null);
    await Promise.all([firstTicket, secondTicket]);
    await drainDependencyContentMaintenance();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("admits content-only pruning through the same child with no cache arguments", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    const appRoot = process.cwd();
    scheduleDependencyContentPrune(appRoot);
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);

    expect(fork).toHaveBeenCalledWith(
      dependencyContentMaintenanceEntry(appRoot),
      [JSON.stringify({ hostArtifactRoot: appRoot, preparations: [], prune: true })],
      expect.objectContaining({ detached: false })
    );
    reportResults(child, [{ ok: true }]);
    child.emit("close", 0, null);
    await drainDependencyContentMaintenance();
  });

  it("settles a failed preparation ticket only after its child closes", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    const ticket = prepareDependencyContent(
      "/tmp/profile/derived-cache/external-deps/3333333333333333.tmp.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "/tmp/profile/derived-cache/external-deps/3333333333333333",
      process.cwd()
    );
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    void ticket.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    reportResults(child, [
      {
        ok: false,
        failure: serializeRpcFailure(
          Object.assign(new Error("source link failed"), { code: "EIO" })
        ),
      },
    ]);
    child.emit("close", 1, null);

    await expect(ticket).rejects.toMatchObject({ message: "source link failed", code: "EIO" });
    await drainDependencyContentMaintenance();
  });

  it("serializes preparations and joins queued pruning after a preparation failure", async () => {
    const first = makeChild();
    const second = makeChild();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    const firstCache = "/tmp/profile/derived-cache/external-deps/4444444444444444";
    const secondCache = "/tmp/profile/derived-cache/external-deps/5555555555555555";
    const appRoot = process.cwd();
    const firstTicket = prepareDependencyContent(
      `${firstCache}.tmp.${"c".repeat(32)}`,
      firstCache,
      appRoot
    );
    await vi.advanceTimersByTimeAsync(0);
    const secondTicket = prepareDependencyContent(
      `${secondCache}.tmp.${"d".repeat(32)}`,
      secondCache,
      appRoot
    );
    scheduleDependencyContentPrune(appRoot);
    expect(fork).toHaveBeenCalledOnce();

    reportResults(first, [
      {
        ok: false,
        failure: serializeRpcFailure(
          Object.assign(new Error("first source link failed"), { code: "EIO" })
        ),
      },
    ]);
    first.emit("close", 1, null);
    await expect(firstTicket).rejects.toMatchObject({ message: "first source link failed" });
    const drain = drainDependencyContentMaintenance();
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    expect(fork).toHaveBeenLastCalledWith(
      dependencyContentMaintenanceEntry(appRoot),
      [
        JSON.stringify({
          hostArtifactRoot: appRoot,
          preparations: [
            {
              stagingDir: path.resolve(`${secondCache}.tmp.${"d".repeat(32)}`),
              cacheDir: path.resolve(secondCache),
            },
          ],
          prune: true,
        }),
      ],
      expect.any(Object)
    );
    reportResults(second, [
      { ok: true },
      {
        ok: false,
        failure: serializeRpcFailure(Object.assign(new Error("prune failure"), { code: "EIO" })),
      },
    ]);
    second.emit("close", 1, null);
    await expect(secondTicket).resolves.toBeUndefined();

    await expect(drain).rejects.toMatchObject({ message: "prune failure", code: "EIO" });
  });

  it("retains a distinct signal termination alongside the child failure graph", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    const ticket = prepareDependencyContent(
      "/tmp/profile/derived-cache/external-deps/6666666666666666.tmp.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "/tmp/profile/derived-cache/external-deps/6666666666666666",
      process.cwd()
    );
    await vi.advanceTimersByTimeAsync(0);

    reportResults(child, [
      {
        ok: false,
        failure: serializeRpcFailure(
          Object.assign(new Error("source link failed"), { code: "EIO" })
        ),
      },
    ]);
    child.emit("close", null, "SIGTERM");

    await expect(ticket).rejects.toMatchObject({
      message: "Dependency preparation and child termination failed",
      errors: [
        expect.objectContaining({ message: "source link failed", code: "EIO" }),
        expect.objectContaining({ message: "Dependency maintenance terminated by signal SIGTERM" }),
      ],
    });
  });

  it("keeps maintenance jobs partitioned by their admitted host generation", async () => {
    const first = makeChild();
    const second = makeChild();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const rootA = path.resolve(process.cwd(), "generation-a");
    const rootB = path.resolve(process.cwd(), "generation-b");
    const firstCache = "/tmp/profile/derived-cache/external-deps/7777777777777777";
    const secondCache = "/tmp/profile/derived-cache/external-deps/8888888888888888";
    const firstTicket = prepareDependencyContent(
      `${firstCache}.tmp.${"e".repeat(32)}`,
      firstCache,
      rootA
    );
    const secondTicket = prepareDependencyContent(
      `${secondCache}.tmp.${"f".repeat(32)}`,
      secondCache,
      rootB
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(fork).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenLastCalledWith(
      dependencyContentMaintenanceEntry(rootA),
      [
        JSON.stringify({
          hostArtifactRoot: rootA,
          preparations: [
            {
              stagingDir: path.resolve(`${firstCache}.tmp.${"e".repeat(32)}`),
              cacheDir: path.resolve(firstCache),
            },
          ],
          prune: false,
        }),
      ],
      expect.objectContaining({
        env: expect.objectContaining({ VIBESTUDIO_HOST_ARTIFACT_ROOT: rootA }),
      })
    );
    reportResults(first, [{ ok: true }]);
    first.emit("close", 0, null);
    await expect(firstTicket).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(2));
    expect(fork).toHaveBeenLastCalledWith(
      dependencyContentMaintenanceEntry(rootB),
      [
        JSON.stringify({
          hostArtifactRoot: rootB,
          preparations: [
            {
              stagingDir: path.resolve(`${secondCache}.tmp.${"f".repeat(32)}`),
              cacheDir: path.resolve(secondCache),
            },
          ],
          prune: false,
        }),
      ],
      expect.objectContaining({
        env: expect.objectContaining({ VIBESTUDIO_HOST_ARTIFACT_ROOT: rootB }),
      })
    );
    reportResults(second, [{ ok: true }]);
    second.emit("close", 0, null);
    await expect(secondTicket).resolves.toBeUndefined();
    await drainDependencyContentMaintenance();
  });

  it("retains a missing maintenance entry as a drain failure", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    scheduleDependencyContentPrune(process.cwd());
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);

    expect(fork).not.toHaveBeenCalled();
    await expect(drainDependencyContentMaintenance()).rejects.toMatchObject({
      message: expect.stringContaining("entry is missing"),
    });
  });
});
