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
  scheduleDependencyContentMaintenance,
} from "./dependencyContentMaintenance.js";
import { serializeRpcFailure } from "@vibestudio/rpc";

function makeChild() {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

function reportFailure(child: EventEmitter, message: string) {
  child.emit("message", {
    type: "dependency-maintenance-failure",
    failure: serializeRpcFailure(
      new AggregateError([Object.assign(new Error(message), { code: "EIO" })], "maintenance failed")
    ),
  });
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

  it("batches cache directories into an owned process after the startup grace period", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    const appRoot = process.cwd();
    const first = "/tmp/profile/derived-cache/external-deps/1111111111111111";
    const second = "/tmp/profile/derived-cache/external-deps/2222222222222222";

    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = appRoot;
    scheduleDependencyContentMaintenance(first);
    scheduleDependencyContentMaintenance(second);
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS - 1);
    expect(fork).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fork).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(
      dependencyContentMaintenanceEntry(),
      [path.resolve(first), path.resolve(second)],
      expect.objectContaining({
        execPath: process.execPath,
        execArgv: [],
        detached: false,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      })
    );
    expect(child.unref).toHaveBeenCalledOnce();
    child.emit("close", 0, null);
    await drainDependencyContentMaintenance();
  });

  it("retains the child failure graph and waits for close before draining", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    scheduleDependencyContentMaintenance(
      "/tmp/profile/derived-cache/external-deps/3333333333333333"
    );
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);

    reportFailure(child, "source link failed");
    const drain = drainDependencyContentMaintenance();
    let settled = false;
    void drain.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", 1, null);

    await expect(drain).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          message: "maintenance failed",
          errors: [expect.objectContaining({ message: "source link failed", code: "EIO" })],
        }),
      ],
    });
  });

  it("collects independent child failures and preserves spawn failures", async () => {
    const first = makeChild();
    const second = makeChild();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    scheduleDependencyContentMaintenance(
      "/tmp/profile/derived-cache/external-deps/4444444444444444"
    );
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);
    scheduleDependencyContentMaintenance(
      "/tmp/profile/derived-cache/external-deps/5555555555555555"
    );
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);

    reportFailure(first, "first source link failed");
    first.emit("close", 1, null);
    const spawnError = Object.assign(new Error("spawn denied"), { code: "EACCES" });
    second.emit("error", spawnError);
    second.emit("close", -2, null);

    await expect(drainDependencyContentMaintenance()).rejects.toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({
          errors: [expect.objectContaining({ message: "first source link failed" })],
        }),
        expect.objectContaining({ message: "spawn denied", code: "EACCES" }),
      ]),
    });
  });

  it("retains a distinct signal termination alongside the child failure graph", async () => {
    const child = makeChild();
    fork.mockReturnValue(child);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    scheduleDependencyContentMaintenance(
      "/tmp/profile/derived-cache/external-deps/6666666666666666"
    );
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);

    reportFailure(child, "source link failed");
    child.emit("close", null, "SIGTERM");

    await expect(drainDependencyContentMaintenance()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              errors: [expect.objectContaining({ message: "source link failed" })],
            }),
            expect.objectContaining({
              message: "Dependency maintenance terminated by signal SIGTERM",
            }),
          ]),
        }),
      ],
    });
  });

  it("retains a missing maintenance entry as a drain failure", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = process.cwd();
    scheduleDependencyContentMaintenance(
      "/tmp/profile/derived-cache/external-deps/7777777777777777"
    );
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS);

    expect(fork).not.toHaveBeenCalled();
    await expect(drainDependencyContentMaintenance()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("entry is missing") })],
    });
  });
});
