import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PanelViewLike } from "@vibestudio/shared/panelInterfaces";
import { domainHash } from "@vibestudio/shared/execution/identity";
import { canonicalJson } from "@vibestudio/content-addressing";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
} from "@vibestudio/shared/execution/retention";
import { AppOrchestrator, readBakedElectronApp } from "./appOrchestrator.js";
import { APP_CAPABILITIES_BY_NATIVE_HOST } from "@vibestudio/shared/unitManifest";

const EXECUTION_DIGEST_1 = "1".repeat(64);
const EXECUTION_DIGEST_2 = "2".repeat(64);
const BAKED_BUILD_KEY = "b".repeat(64);
const BAKED_EFFECTIVE_VERSION = "e".repeat(64);

function sealedAuthority(executionDigest = EXECUTION_DIGEST_1) {
  return {
    executionDigest,
    authority: { requests: [], provides: [] },
  };
}

function integrity(content: string): string {
  return `sha256-${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function bakedExecution(artifacts: Array<Record<string, unknown>>) {
  const artifactDigest = domainHash(
    "vibestudio/build-v2-artifacts/v1",
    canonicalJson(
      artifacts.map((artifact) => ({
        path: artifact["path"],
        role: artifact["role"],
        contentType: artifact["contentType"],
        encoding: artifact["encoding"],
        platform: artifact["platform"] ?? null,
        integrity: artifact["integrity"] ?? null,
      })) as never
    )
  );
  const contentRoots = [{ repoPath: "apps/shell", stateHash: `state:${"c".repeat(64)}` }] as const;
  const unsigned = {
    version: 1 as const,
    sourceState: {
      kind: "workspace" as const,
      workspaceId: "workspace:test",
      effectiveVersion: BAKED_EFFECTIVE_VERSION as never,
      state: { kind: "event" as const, eventId: "event:test" },
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest: "a".repeat(64) as never,
    buildKey: BAKED_BUILD_KEY as never,
    artifactDigest,
  };
  return { ...unsigned, executionDigest: executionArtifactDigest(unsigned) };
}

function createPanelView(): PanelViewLike {
  return {
    createViewForPanel: vi.fn(),
    updatePanelCodeIdentity: vi.fn(),
    createViewForApp: vi.fn(async () => {}),
    hasView: vi.fn(() => false),
    getViewPartition: vi.fn(() => null),
    destroyView: vi.fn(),
    reloadView: vi.fn(async () => false),
    navigateView: vi.fn(async () => {}),
    getWebContents: vi.fn(() => null),
    findViewIdByWebContentsId: vi.fn(() => null),
    setProtectedViews: vi.fn(),
    setViewVisible: vi.fn(),
  };
}

describe("AppOrchestrator", () => {
  it("rejects Electron apps that declare capabilities unsupported by this host", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await expect(
      orchestrator.applyAppAvailable({
        appId: "@workspace-apps/shell",
        target: "electron",
        url: "http://localhost/app",
        capabilities: ["notifications", "tray"],
      })
    ).rejects.toThrow(/unsupported host capabilities: tray/);

    expect(panelView.createViewForApp).not.toHaveBeenCalled();
  });

  it("loads Electron apps whose capabilities are implemented by this host", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://localhost/app",
      capabilities: APP_CAPABILITIES_BY_NATIVE_HOST.electron,
      effectiveVersion: "ev-shell",
      ...sealedAuthority(),
    });

    expect(panelView.createViewForApp).toHaveBeenCalledWith(
      "@workspace-apps/shell",
      "http://localhost/app",
      undefined,
      APP_CAPABILITIES_BY_NATIVE_HOST.electron,
      {
        source: "apps/shell",
        effectiveVersion: "ev-shell",
        executionDigest: EXECUTION_DIGEST_1,
        requested: [],
      }
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith("@workspace-apps/shell", true);
  });

  it("does not remount an already-loaded app for a duplicate identical availability event", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });
    const event = {
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron" as const,
      url: "http://localhost/app",
      buildKey: "build-1",
      capabilities: ["panel-hosting"] as const,
      ...sealedAuthority(),
    };

    await orchestrator.applyAppAvailable(event);
    (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await orchestrator.applyAppAvailable({ ...event });

    expect(panelView.createViewForApp).toHaveBeenCalledTimes(1);
    expect(panelView.setViewVisible).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent duplicate availability events into one mount", async () => {
    const panelView = createPanelView();
    let releaseMount!: () => void;
    const mountBlocked = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    (panelView.createViewForApp as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => mountBlocked
    );
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });
    const event = {
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron" as const,
      url: "http://localhost/app",
      capabilities: ["panel-hosting"] as const,
      ...sealedAuthority(),
    };

    const first = orchestrator.applyAppAvailable(event);
    const second = orchestrator.applyAppAvailable({ ...event });
    await vi.waitFor(() => expect(panelView.createViewForApp).toHaveBeenCalledTimes(1));
    (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
    releaseMount();
    await Promise.all([first, second]);

    expect(panelView.createViewForApp).toHaveBeenCalledTimes(1);
    expect(panelView.setViewVisible).toHaveBeenCalledTimes(1);
  });

  it("remounts when a duplicate availability event carries a new build", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });
    const event = {
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron" as const,
      url: "http://localhost/app",
      buildKey: "build-1",
      capabilities: ["panel-hosting"] as const,
      ...sealedAuthority(),
    };

    await orchestrator.applyAppAvailable(event);
    (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await orchestrator.applyAppAvailable({
      ...event,
      url: "http://localhost/app-v2",
      buildKey: "build-2",
      ...sealedAuthority(EXECUTION_DIGEST_2),
    });

    expect(panelView.createViewForApp).toHaveBeenCalledTimes(2);
    expect(panelView.setViewVisible).toHaveBeenCalledTimes(2);
  });

  it("queues desktop app updates instead of navigating an already loaded app view", async () => {
    const panelView = createPanelView();
    (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://localhost/app-v1",
      buildKey: "build-1",
      capabilities: ["panel-hosting"],
      adoptionPolicy: "immediate",
      ...sealedAuthority(),
    });
    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://localhost/app-v2",
      buildKey: "build-2",
      capabilities: ["panel-hosting"],
      adoptionPolicy: "prompt",
      ...sealedAuthority(EXECUTION_DIGEST_2),
    });

    expect(panelView.createViewForApp).toHaveBeenCalledTimes(1);
    expect(orchestrator.listPendingAppUpdates()).toMatchObject([
      { appId: "@workspace-apps/shell", buildKey: "build-2" },
    ]);

    await expect(orchestrator.applyPendingAppUpdate("@workspace-apps/shell")).resolves.toBe(true);
    expect(panelView.createViewForApp).toHaveBeenCalledTimes(2);
    expect(panelView.createViewForApp).toHaveBeenLastCalledWith(
      "@workspace-apps/shell",
      "http://localhost/app-v2",
      undefined,
      ["panel-hosting"],
      {
        source: "apps/shell",
        executionDigest: EXECUTION_DIGEST_2,
        requested: [],
      }
    );
    expect(orchestrator.listPendingAppUpdates()).toEqual([]);
  });

  it("persists pending desktop app updates across orchestrator restarts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-app-updates-"));
    try {
      const panelView = createPanelView();
      (panelView.hasView as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const orchestrator = new AppOrchestrator({ getPanelView: () => panelView, statePath: root });

      await orchestrator.applyAppAvailable({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        url: "http://localhost/app-v1",
        buildKey: "build-1",
        adoptionPolicy: "immediate",
        ...sealedAuthority(),
      });
      await orchestrator.applyAppAvailable({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        url: "http://localhost/app-v2",
        buildKey: "build-2",
        adoptionPolicy: "prompt",
        ...sealedAuthority(EXECUTION_DIGEST_2),
      });

      const restarted = new AppOrchestrator({ getPanelView: () => panelView, statePath: root });
      expect(restarted.listPendingAppUpdates()).toMatchObject([
        { appId: "@workspace-apps/shell", buildKey: "build-2" },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores terminal app process availability for desktop view adoption", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

    await orchestrator.applyAppAvailable({
      appId: "@workspace-apps/remote-cli",
      target: "terminal",
      url: "http://localhost/app.mjs",
      adoptionPolicy: "immediate",
    });

    expect(panelView.createViewForApp).not.toHaveBeenCalled();
  });

  it("reads and mounts packaged baked Electron app payloads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-baked-app-"));
    try {
      fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(root, "artifacts", "index.html"), "<html></html>");
      const artifacts = [
        {
          path: "index.html",
          role: "html",
          contentType: "text/html; charset=utf-8",
          encoding: "utf8",
          integrity: integrity("<html></html>"),
        },
      ];
      const execution = bakedExecution(artifacts);
      fs.writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({
          version: 2,
          app: {
            name: "@workspace-apps/shell",
            source: "apps/shell",
            target: "electron",
            capabilities: ["notifications"],
          },
          build: {
            key: BAKED_BUILD_KEY,
            effectiveVersion: BAKED_EFFECTIVE_VERSION,
            executionDigest: execution.executionDigest,
            execution,
            authority: { requests: [], provides: [] },
          },
          artifacts,
        })
      );
      const panelView = createPanelView();
      const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });

      expect(readBakedElectronApp(root)).toMatchObject({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        capabilities: ["notifications"],
        effectiveVersion: BAKED_EFFECTIVE_VERSION,
        executionDigest: execution.executionDigest,
        authority: { requests: [], provides: [] },
      });
      await expect(orchestrator.loadBakedApp(root)).resolves.toBe(true);

      expect(panelView.createViewForApp).toHaveBeenCalledWith(
        "@workspace-apps/shell",
        expect.stringMatching(/^file:.*index\.html$/),
        undefined,
        ["notifications"],
        {
          source: "apps/shell",
          effectiveVersion: BAKED_EFFECTIVE_VERSION,
          executionDigest: execution.executionDigest,
          requested: [],
        }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Electron app mounts without a canonical sealed execution identity", async () => {
    const panelView = createPanelView();
    const orchestrator = new AppOrchestrator({ getPanelView: () => panelView });
    const event = {
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron" as const,
      url: "http://localhost/app",
      authority: { requests: [], provides: [] },
    };

    await expect(orchestrator.applyAppAvailable(event)).rejects.toThrow(
      /execution digest must be a full lowercase SHA-256/
    );
    await expect(
      orchestrator.applyAppAvailable({ ...event, executionDigest: "short-build-key" })
    ).rejects.toThrow(/execution digest must be a full lowercase SHA-256/);
    expect(panelView.createViewForApp).not.toHaveBeenCalled();
  });

  it("rejects obsolete baked app manifests instead of mounting them without authority", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-obsolete-baked-app-"));
    try {
      fs.writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({ version: 1, app: {}, build: {}, artifacts: [] })
      );
      expect(() => readBakedElectronApp(root)).toThrow(/Unsupported baked app manifest version: 1/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a baked app whose self-consistent package was changed after execution sealing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-tampered-baked-app-"));
    try {
      fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
      fs.writeFileSync(path.join(root, "artifacts", "index.html"), "tampered");
      const sealedArtifacts = [
        {
          path: "index.html",
          role: "html",
          contentType: "text/html; charset=utf-8",
          encoding: "utf8",
          integrity: integrity("original"),
        },
      ];
      const artifacts = sealedArtifacts.map((artifact) => ({
        ...artifact,
        integrity: integrity("tampered"),
      }));
      const execution = bakedExecution(sealedArtifacts);
      fs.writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({
          version: 2,
          app: {
            name: "@workspace-apps/shell",
            source: "apps/shell",
            target: "electron",
            capabilities: [],
          },
          build: {
            key: BAKED_BUILD_KEY,
            effectiveVersion: BAKED_EFFECTIVE_VERSION,
            executionDigest: execution.executionDigest,
            execution,
            authority: { requests: [], provides: [] },
          },
          artifacts,
        })
      );

      expect(() => readBakedElectronApp(root)).toThrow(
        /artifact manifest does not match its execution identity/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
