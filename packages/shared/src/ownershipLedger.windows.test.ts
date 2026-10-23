import { describe, expect, it, vi } from "vitest";
import { retireWindowsLeader } from "./ownershipLedger.mjs";

const group = { pid: 4242 };
const run = (status: number | null, stderr = "") => vi.fn(() => ({ status, stderr }));

describe("retireWindowsLeader", () => {
  it("does nothing off Windows", async () => {
    const taskkill = run(1);
    await expect(
      retireWindowsLeader(group, { platform: "linux", run: taskkill, exists: () => true })
    ).resolves.toBeUndefined();
    expect(taskkill).not.toHaveBeenCalled();
  });

  it("retires the leader's tree with taskkill", async () => {
    const taskkill = run(0);
    await retireWindowsLeader(group, { platform: "win32", run: taskkill, exists: () => true });
    expect(taskkill).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.any(Object)
    );
  });

  it("accepts a leader that was already gone", async () => {
    await expect(
      retireWindowsLeader(group, { platform: "win32", run: run(128), exists: () => true })
    ).resolves.toBeUndefined();
  });

  it("accepts a taskkill failure when the leader is gone, as when the tree exits while it walks it", async () => {
    await expect(
      retireWindowsLeader(group, {
        platform: "win32",
        run: run(
          1,
          "ERROR: The process with PID 9 could not be terminated. There is no running instance of the task."
        ),
        exists: () => false,
      })
    ).resolves.toBeUndefined();
  });

  it("fails with taskkill's own report when the leader is still running", async () => {
    await expect(
      retireWindowsLeader(group, {
        platform: "win32",
        run: run(1, "ERROR: Access is denied."),
        exists: () => true,
      })
    ).rejects.toMatchObject({
      code: "EOWNERSHIP",
      cause: { message: expect.stringContaining("taskkill failed (1): ERROR: Access is denied.") },
    });
  });
});
