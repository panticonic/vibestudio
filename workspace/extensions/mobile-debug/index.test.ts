import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@vibestudio/extension";
import { activate, pidScopedLogcatArgs, workspaceReadinessFromLog } from "./index.js";

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
            contextProjectionsPath: join(root, ".context-projections", "v5"),
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

  it("returns bounded verification evidence instead of embedding screenshot bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibestudio-mobile-debug-verify-"));
    const adbPath = join(root, "adb");
    await writeFile(
      adbPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "devices" ]; then',
        '  printf "List of devices attached\\nemulator-5554 device model:test_phone\\n"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-s" ]; then shift 2; fi',
        'if [ "$1" = "exec-out" ]; then printf "fake-png"; fi',
        "exit 0",
      ].join("\n")
    );
    await chmod(adbPath, 0o755);

    const previousPath = process.env["PATH"];
    process.env["PATH"] = root;
    try {
      const ctx = {
        workspace: {
          getInfo: async () => ({
            id: "ws",
            name: "ws",
            path: root,
            contextProjectionsPath: join(root, ".context-projections", "v5"),
          }),
        },
        health: { degraded: vi.fn(), healthy: vi.fn(), unhealthy: vi.fn(), report: vi.fn() },
      } as unknown as ExtensionContext;

      const api = await activate(ctx);
      const result = await api.verify({ device: "emulator-5554" });

      expect(result).toEqual({
        installed: true,
        bundleActive: true,
        rendering: true,
        screenshotCaptured: true,
        screenshotBytes: 8,
        issues: [],
      });
      expect(result).not.toHaveProperty("screenshotPng");
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
    }
  });

  it("requires the initialized workspace shell and rejects panel transport failures", () => {
    expect(
      workspaceReadinessFromLog(
        [
          "1785258000.100 ReactNativeJS phase=workspace-panels-initialized",
          "1785258000.200 ReactNativeJS phase=workspace-connected",
        ].join("\n"),
        1785258000000
      )
    ).toEqual({
      ready: true,
      workspaceConnected: true,
      panelHostReady: true,
      panelWebViewLoaded: false,
      issues: [],
    });

    expect(
      workspaceReadinessFromLog(
        [
          "1785258000.100 ReactNativeJS phase=workspace-panels-initialized",
          "1785258000.200 ReactNativeJS phase=workspace-connected",
          "1785258000.300 chromium invalid distance code",
        ].join("\n"),
        1785258000000
      )
    ).toMatchObject({
      ready: false,
      issues: ["invalid distance code"],
    });
  });
});
