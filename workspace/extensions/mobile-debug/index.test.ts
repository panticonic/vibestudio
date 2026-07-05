import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@vibestudio/extension";
import { activate, pidScopedLogcatArgs } from "./index.js";

describe("@workspace-extensions/mobile-debug", () => {
  it("adds an adb logcat pid filter after resolving a package pid", () => {
    expect(pidScopedLogcatArgs(["logcat", "-v", "time"], "1234")).toEqual([
      "logcat",
      "--pid=1234",
      "-v",
      "time",
    ]);
    expect(pidScopedLogcatArgs(["logcat", "-v", "time", "Vibestudio:D"], "1234")).toEqual([
      "logcat",
      "--pid=1234",
      "-v",
      "time",
      "Vibestudio:D",
    ]);
  });

  it("activates without a repo root and reports missing repo-dependent capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibestudio-mobile-debug-test-"));
    const previousRepoRoot = process.env["VIBESTUDIO_REPO_ROOT"];
    const previousPath = process.env["PATH"];
    process.env["VIBESTUDIO_REPO_ROOT"] = root;
    process.env["PATH"] = "";
    const degraded = vi.fn();
    try {
      const ctx = {
        workspace: {
          getInfo: async () => ({
            id: "ws",
            name: "ws",
            path: root,
            contextsPath: join(root, ".contexts"),
          }),
        },
        health: { degraded, healthy: vi.fn(), unhealthy: vi.fn(), report: vi.fn() },
      } as unknown as ExtensionContext;

      const api = await activate(ctx);

      expect(degraded).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: "Mobile debug activated without a Vibestudio repo root",
        })
      );
      await expect(api.buildAndroid()).rejects.toMatchObject({ code: "EBUILD" });
      await expect(api.doctor()).resolves.toMatchObject({
        adb: false,
        apkSigned: false,
        issues: expect.arrayContaining([
          "Could not locate Vibestudio repo root containing apps/mobile/android",
          "adb is not on PATH",
        ]),
      });
    } finally {
      if (previousRepoRoot === undefined) delete process.env["VIBESTUDIO_REPO_ROOT"];
      else process.env["VIBESTUDIO_REPO_ROOT"] = previousRepoRoot;
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  });
});
