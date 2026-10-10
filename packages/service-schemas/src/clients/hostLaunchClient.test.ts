import { describe, expect, it, vi } from "vitest";
import { HostLaunchClient } from "./hostLaunchClient";

const config = (hostTargets: Record<string, unknown>) => ({
  id: "test-workspace",
  systemEpoch: 1,
  hostTargets,
});

function unit(overrides: Record<string, unknown>) {
  return {
    capabilities: [],
    displayName: "Test unit",
    target: null,
    isAgent: false,
    status: "available",
    effectiveVersion: null,
    activeBuildKey: null,
    lastError: null,
    pendingApproval: null,
    authorityRows: [],
    ...overrides,
  };
}

function ready(kind: "app" | "extension", releaseId: string, source: string) {
  return {
    status: "ready",
    entity: {
      identity: { kind, entityId: releaseId },
      release: { kind, releaseId },
      source,
      status: "running",
      lastError: null,
      artifact: { effectiveVersion: null, buildKey: null, executionDigest: null },
      facets: { activation: true, release: true, inspector: false },
    },
  };
}

function unitInstallApproval(
  approvalId: string,
  repoPath: string,
  mode: "adopt-root" | "part-changed"
) {
  return {
    kind: "unit-install-review",
    mode,
    approvalId,
    callerId: "shell",
    callerKind: "system",
    repoPath,
    effectiveVersion: "ev-test",
    requestedAt: 1,
    title: "Review unit",
    description: "Review test unit",
    parts: [
      {
        identityKey: repoPath,
        kind: mode === "adopt-root" ? "app" : "panel",
        label: mode === "adopt-root" ? "Client App" : "Panel",
        surfaces: [],
        name: repoPath,
        title: "Test unit",
        purpose: "Test fixture",
        repoPath,
        effectiveVersion: "ev-test",
        version: null,
        requiredUnitKeys: [],
        runsInBackground: false,
        origin: {
          url: null,
          originKey: "test",
          registrableDomain: null,
          version: null,
          isHostBuild: false,
          firstEncounter: true,
        },
        notableRows: [],
        everydayRows: [],
        change: "added",
        section: "template",
      },
    ],
    summary: { panels: 0, agents: 0, services: 0, clientApps: 1, extensions: 0 },
    unchangedPartCount: 0,
  };
}

describe("HostLaunchClient", () => {
  it("resolves the configured app to its catalog candidate", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        return config({ "react-native": { app: "apps/mobile" } });
      }
      if (service === "build" && method === "listUnits") {
        return [
          unit({
            name: "@workspace-apps/mobile",
            source: "apps/mobile",
            kind: "app",
            target: "react-native",
          }),
          unit({
            name: "@workspace-apps/shell",
            source: "apps/shell",
            kind: "app",
            target: "electron",
          }),
        ];
      }
      throw new Error(`Unexpected call ${service}.${method}`);
    });

    const client = new HostLaunchClient(call);

    await expect(client.configuredCandidate("react-native")).resolves.toMatchObject({
      name: "@workspace-apps/mobile",
      source: "apps/mobile",
      target: "react-native",
    });
  });

  it("lets the activation owner prepare an unbuilt configured app", async () => {
    let prepared = false;
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        return config({ electron: { app: "apps/shell" } });
      }
      if (service === "build" && method === "listUnits") {
        return [
          unit({
            name: "@workspace-apps/shell",
            source: "apps/shell",
            kind: "app",
            target: "electron",
            activeBuildKey: prepared ? "build-shell" : null,
            status: prepared ? "ready" : "available",
          }),
        ];
      }
      if (service === "runtime" && method === "supervision.prepare") {
        prepared = true;
        return {
          releaseId: "@workspace-apps/shell",
          buildKey: "build-shell",
          effectiveVersion: "ev-shell",
        };
      }
      if (service === "runtime" && method === "supervision.activate") {
        return ready("app", "@workspace-apps/shell", "apps/shell");
      }
      throw new Error(`Unexpected call ${service}.${method}`);
    });

    const client = new HostLaunchClient(call);
    await expect(client.launch("electron")).resolves.toMatchObject({ status: "ready" });
    expect(call).not.toHaveBeenCalledWith("runtime", "supervision.prepare", expect.anything());
    expect(
      call.mock.calls.filter(([service, method]) => service === "build" && method === "listUnits")
    ).toHaveLength(1);
    expect(call).toHaveBeenCalledWith("runtime", "supervision.activate", [
      { kind: "app", releaseId: "@workspace-apps/shell" },
    ]);
  });

  it("continues from ready prerequisite extensions to the configured app", async () => {
    let prepared = false;
    const call = vi.fn(async (service: string, method: string, args?: unknown[]) => {
      if (service === "workspace" && method === "getConfig") {
        return config({
          "react-native": {
            app: "apps/mobile",
            requiresExtensions: ["extensions/react-native"],
          },
        });
      }
      if (service === "build" && method === "listUnits") {
        return [
          unit({
            name: "@workspace-extensions/react-native",
            source: "extensions/react-native",
            kind: "extension",
          }),
          unit({
            name: "@workspace-apps/mobile",
            source: "apps/mobile",
            kind: "app",
            target: "react-native",
            activeBuildKey: prepared ? "build-mobile" : null,
            status: prepared ? "ready" : "available",
          }),
        ];
      }
      if (service === "runtime" && method === "supervision.prepare") {
        prepared = true;
        return {
          releaseId: "@workspace-apps/mobile",
          buildKey: "build-mobile",
          effectiveVersion: "ev-mobile",
        };
      }
      if (service === "runtime" && method === "supervision.activate") {
        const key = (args?.[0] as { kind: string; releaseId: string }) ?? null;
        if (key.kind === "extension") {
          return ready("extension", key.releaseId, "extensions/react-native");
        }
        return ready("app", key.releaseId, "apps/mobile");
      }
      throw new Error(`Unexpected call ${service}.${method}`);
    });

    const client = new HostLaunchClient(call);
    await expect(client.launch("react-native")).resolves.toMatchObject({
      status: "ready",
      entity: { identity: { kind: "app", entityId: "@workspace-apps/mobile" } },
    });
    expect(call).toHaveBeenCalledWith("runtime", "supervision.activate", [
      { kind: "extension", releaseId: "@workspace-extensions/react-native" },
    ]);
    expect(call).not.toHaveBeenCalledWith("runtime", "supervision.prepare", expect.anything());
  });

  it("does not prepare an app while its build is awaiting approval", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        return config({ electron: { app: "apps/shell" } });
      }
      if (service === "build" && method === "listUnits") {
        return [
          unit({
            name: "@workspace-apps/shell",
            source: "apps/shell",
            kind: "app",
            target: "electron",
            activeBuildKey: null,
            status: "approval-required",
          }),
        ];
      }
      if (service === "runtime" && method === "supervision.activate") {
        return { status: "approval-required" };
      }
      if (service === "shellApproval" && method === "listPending") return [];
      throw new Error(`Unexpected call ${service}.${method}`);
    });

    const client = new HostLaunchClient(call);
    await expect(client.launch("electron")).resolves.toEqual({
      status: "approval-required",
      target: "electron",
      approvals: [],
    });
    expect(call).not.toHaveBeenCalledWith("runtime", "supervision.prepare", expect.anything());
  });

  it("resolves only the reviews the launch gate owns, and leaves the rest alone", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "shellApproval" && method === "listPending") {
        return [
          unitInstallApproval("startup-1", "apps/shell", "adopt-root"),
          {
            // A part already in the workspace was edited. `apps/shell` can
            // render that one, so the launch gate must not answer it.
            ...unitInstallApproval("source-1", "panels/chat", "part-changed"),
          },
          {
            kind: "capability",
            approvalId: "capability-1",
            callerId: "shell",
            callerKind: "system",
            repoPath: "",
            effectiveVersion: "ev-test",
            requestedAt: 1,
            capability: "runtime.supervision.manage",
            title: "Other request",
          },
        ];
      }
      if (service === "shellApproval" && method === "resolveBootstrap") return [];
      throw new Error(`Unexpected call ${service}.${method}`);
    });

    const client = new HostLaunchClient(call);
    await expect(client.resolvePendingStartupApprovals("once")).resolves.toBe(1);
    expect(call).toHaveBeenCalledWith("shellApproval", "resolveBootstrap", [["startup-1"], "once"]);
    expect(call).not.toHaveBeenCalledWith("shellApproval", "resolveBootstrap", [
      ["source-1"],
      "once",
    ]);
  });
});
