import { describe, expect, it, vi } from "vitest";
import { readyElectronLaunchEvent } from "./hostTargetLaunchAdapter.js";

describe("readyElectronLaunchEvent", () => {
  it("preserves the selected artifact's immutable execution authority", () => {
    const authorityRequests = [
      {
        capability: "events.watch",
        resource: { kind: "exact" as const, key: "events.watch" },
        tier: "gated" as const,
        evidence: "exact" as const,
      },
    ];
    const warn = vi.fn();

    const event = readyElectronLaunchEvent(
      {
        status: "ready",
        launched: true,
        target: "electron",
        source: "apps/shell",
        appId: "@workspace-apps/shell",
        buildKey: "cache-key",
        artifactRoute: "/_a/shell/index.html",
        capabilities: ["panel-hosting"],
        effectiveVersion: "ev-1",
        executionDigest: "a".repeat(64),
        authorityRequests,
        adoptionPolicy: "prompt",
      },
      {
        resolveArtifactRoute: (route) => `http://gateway.test${route}`,
        warn,
      }
    );

    expect(event).toMatchObject({
      appId: "@workspace-apps/shell",
      source: "apps/shell",
      target: "electron",
      url: "http://gateway.test/_a/shell/index.html",
      executionDigest: "a".repeat(64),
      authorityRequests,
    });
    expect(event?.authorityRequests).toEqual(authorityRequests);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a malformed ready contract instead of dropping authority", () => {
    const warn = vi.fn();

    const event = readyElectronLaunchEvent(
      {
        status: "ready",
        launched: true,
        target: "electron",
        source: "apps/shell",
        appId: "@workspace-apps/shell",
        buildKey: "cache-key",
        artifactRoute: "/_a/shell/index.html",
        authorityRequests: [{ capability: "events.watch" }],
      },
      { resolveArtifactRoute: vi.fn(), warn }
    );

    expect(event).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Electron host target returned an invalid ready-launch contract"
    );
  });
});
