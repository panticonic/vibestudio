import { EventEmitter } from "node:events";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(() => true),
}));

import {
  DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS,
  dependencyContentMaintenanceEntry,
  scheduleDependencyContentMaintenance,
} from "./dependencyContentMaintenance.js";

describe("dependency content maintenance scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches cache directories into a detached process after the startup grace period", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    spawn.mockReturnValue(child);
    const appRoot = process.cwd();
    const first = "/tmp/profile/derived-cache/external-deps/1111111111111111";
    const second = "/tmp/profile/derived-cache/external-deps/2222222222222222";

    scheduleDependencyContentMaintenance(first, appRoot);
    scheduleDependencyContentMaintenance(second, appRoot);
    await vi.advanceTimersByTimeAsync(DEPENDENCY_CONTENT_MAINTENANCE_DELAY_MS - 1);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [dependencyContentMaintenanceEntry(appRoot), path.resolve(first), path.resolve(second)],
      expect.objectContaining({ detached: true, stdio: "ignore" })
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
