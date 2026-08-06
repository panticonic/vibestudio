import { describe, expect, it, vi } from "vitest";
import { HostLaunchClient } from "./hostLaunchClient";

describe("HostLaunchClient", () => {
  it("resolves the configured app to its catalog candidate", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        return { hostTargets: { "react-native": { app: "apps/mobile" } } };
      }
      if (service === "build" && method === "listUnits") {
        return [
          {
            name: "@workspace-apps/mobile",
            source: "apps/mobile",
            kind: "app",
            target: "react-native",
          },
          {
            name: "@workspace-apps/shell",
            source: "apps/shell",
            kind: "app",
            target: "electron",
          },
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

  it("prepares an unbuilt configured app before activating its exact release", async () => {
    let prepared = false;
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        return { hostTargets: { electron: { app: "apps/shell" } } };
      }
      if (service === "build" && method === "listUnits") {
        return [
          {
            name: "@workspace-apps/shell",
            source: "apps/shell",
            kind: "app",
            target: "electron",
            activeBuildKey: prepared ? "build-shell" : null,
            status: prepared ? "ready" : "available",
          },
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
        return {
          status: "ready",
          entity: {
            identity: { kind: "app", entityId: "@workspace-apps/shell" },
            source: "apps/shell",
          },
        };
      }
      throw new Error(`Unexpected call ${service}.${method}`);
    });

    const client = new HostLaunchClient(call);
    await expect(client.launch("electron")).resolves.toMatchObject({ status: "ready" });
    expect(call).toHaveBeenCalledWith("runtime", "supervision.prepare", [
      { kind: "app", releaseId: "@workspace-apps/shell" },
      { ref: "main" },
    ]);
    expect(call).toHaveBeenCalledWith("runtime", "supervision.activate", [
      { kind: "app", releaseId: "@workspace-apps/shell" },
    ]);
  });

  it("does not prepare an app while its build is awaiting approval", async () => {
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        return { hostTargets: { electron: { app: "apps/shell" } } };
      }
      if (service === "build" && method === "listUnits") {
        return [
          {
            name: "@workspace-apps/shell",
            source: "apps/shell",
            kind: "app",
            target: "electron",
            activeBuildKey: null,
            status: "approval-required",
          },
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
          {
            kind: "unit-install-review",
            mode: "adopt-root",
            approvalId: "startup-1",
            parts: [{ kind: "app", repoPath: "apps/shell", target: "electron" }],
          },
          {
            // A part already in the workspace was edited. `apps/shell` can
            // render that one, so the launch gate must not answer it.
            kind: "unit-install-review",
            mode: "part-changed",
            approvalId: "source-1",
            parts: [{ kind: "panel", repoPath: "panels/chat" }],
          },
          { kind: "capability", approvalId: "capability-1" },
        ];
      }
      if (service === "shellApproval" && method === "resolveBootstrap") return undefined;
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
