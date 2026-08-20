import type { ElectronApplication } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestApi } from "../../src/main/testApi.js";
import {
  ensureHostedShellReady,
  linkSharedMachineCaches,
  panelInitializationFailureError,
} from "./electronSetup.js";

const temporaryRoots: string[] = [];
const originalSharedDerivedCacheDir = process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];

describe("hosted-shell initialization diagnostics", () => {
  afterEach(() => {
    delete globalThis.__testApi;
    if (originalSharedDerivedCacheDir === undefined) {
      delete process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"];
    } else {
      process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = originalSharedDerivedCacheDir;
    }
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("links shared machine caches at the derived-data path consumed by the runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-e2e-cache-link-"));
    temporaryRoots.push(root);
    const sharedDerivedDataDir = path.join(root, "shared-derived-cache");
    const isolatedCentralDataDir = path.join(root, "isolated-profile");
    process.env["VIBESTUDIO_SHARED_DERIVED_CACHE_DIR"] = sharedDerivedDataDir;
    for (const cacheDir of ["npm-cache", "external-deps", "extension-runtime-deps"]) {
      fs.mkdirSync(path.join(sharedDerivedDataDir, cacheDir), { recursive: true });
    }

    linkSharedMachineCaches(isolatedCentralDataDir);

    for (const cacheDir of ["npm-cache", "external-deps", "extension-runtime-deps"]) {
      const linked = path.join(isolatedCentralDataDir, "derived-cache", cacheDir);
      expect(fs.realpathSync(linked)).toBe(path.join(sharedDerivedDataDir, cacheDir));
    }
    expect(fs.existsSync(path.join(isolatedCentralDataDir, "external-deps"))).toBe(false);
  });

  it("does not manufacture a terminal error while initialization is healthy", () => {
    expect(panelInitializationFailureError(null)).toBeNull();
  });

  it("formats the structured caught failure with its trigger and stack", () => {
    const error = panelInitializationFailureError({
      timestamp: 1234,
      phase: "panel-tree",
      trigger: "electron-host-ready",
      message: "missing workspace authority",
      stack: "PanelTreeError: missing workspace authority\n  at initializePanelTree",
    });

    expect(error?.message).toContain(
      "Hosted shell panel initialization failed during electron-host-ready: missing workspace authority"
    );
    expect(error?.message).toContain("PanelTreeError: missing workspace authority");
  });

  it("terminates readiness immediately from the authoritative test API state", async () => {
    const rpcCall = vi.fn();
    globalThis.__testApi = {
      readPanelInitializationFailure: () => ({
        timestamp: 1234,
        phase: "panel-tree",
        trigger: "electron-host-ready",
        message: "workspace-state denied the snapshot",
      }),
      rpcCall,
    } as unknown as TestApi;
    const app = {
      evaluate: async (
        callback: (_electron: unknown, input: unknown) => unknown,
        input: unknown
      ) => callback(undefined, input),
    } as unknown as ElectronApplication;

    await expect(
      ensureHostedShellReady(app, { panelSource: "panels/chat", timeoutMs: 30_000 })
    ).rejects.toThrow(
      "Hosted shell panel initialization failed during electron-host-ready: workspace-state denied the snapshot"
    );
    expect(rpcCall).not.toHaveBeenCalled();
  });
});
