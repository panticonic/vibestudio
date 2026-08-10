import { describe, expect, it, vi } from "vitest";
import { callMain } from "@workspace/runtime";

vi.mock("@workspace/runtime", () => ({
  callMain: vi.fn(),
}));

vi.mock("./status.js", () => ({
  createStatusAdapters: vi.fn(() => ({})),
}));

import {
  composeOnboardingOverview,
  composeOnboardingSnapshot,
  type OnboardingSnapshotDependencies,
} from "./snapshot.js";
import type { CapabilityOnboardingStatusAdapter } from "./status.js";

const healthy: CapabilityOnboardingStatusAdapter = vi.fn(
  async (): ReturnType<CapabilityOnboardingStatusAdapter> => ({
    state: "configured",
    summary: "Ready.",
    attention: "none",
  })
);

function dependencies(
  adapters: Record<string, CapabilityOnboardingStatusAdapter>
): OnboardingSnapshotDependencies {
  return {
    adapters,
    readHostTopology: vi.fn(
      async (): ReturnType<NonNullable<OnboardingSnapshotDependencies["readHostTopology"]>> => ({
        devices: {
          availability: "available",
          pairedDeviceCount: 1,
          thisDevicePaired: true,
        },
        remote: {
          availability: "available",
          route: "local",
          workspaceCount: 2,
        },
      })
    ),
    hasSkill: vi.fn(async () => true),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  };
}

describe("composeOnboardingSnapshot", () => {
  it("composes capability and template observations at one observation time", async () => {
    const deps = dependencies({
      "ai-provider": healthy,
      "google-workspace": healthy,
      github: healthy,
      "browser-environment": healthy,
      "local-models": healthy,
      "agent-defaults": healthy,
      "web-search": healthy,
    });
    const overview = await composeOnboardingOverview(
      {},
      {
        ...deps,
        templateStatus: vi.fn(async () => []),
      }
    );

    expect(overview.snapshot.length).toBeGreaterThan(0);
    expect(overview.templates.map((entry) => entry.state)).toEqual([
      "available",
      "available",
      "available",
    ]);
    expect(
      new Set([...overview.snapshot, ...overview.templates].map((entry) => entry.observedAt))
    ).toEqual(new Set(["2026-07-24T12:00:00.000Z"]));
  });

  it("preflights optional host reads instead of logging denied IPC calls", async () => {
    const callMainMock = vi.mocked(callMain);
    callMainMock.mockImplementation(async (method: string) => {
      if (method === "authority.preflight") {
        return { decision: "acquirable", leaves: [] };
      }
      if (method === "workspace.listSkills") return [{ skillPath: "skills/phone-setup/SKILL.md" }];
      throw new Error(`Unexpected call: ${method}`);
    });

    const snapshot = await composeOnboardingSnapshot({}, { now: () => new Date("2026-07-24") });

    expect(callMainMock).toHaveBeenCalledWith("authority.preflight", {
      service: "hubControl",
      method: "listDevices",
      args: [],
    });
    expect(callMainMock).toHaveBeenCalledWith("authority.preflight", {
      service: "hubControl",
      method: "listWorkspaces",
      args: [],
    });
    expect(callMainMock).not.toHaveBeenCalledWith("hubControl.listDevices");
    expect(callMainMock).not.toHaveBeenCalledWith("hubControl.listWorkspaces");
    expect(snapshot.find((entry) => entry.id === "connection.device")).toEqual(
      expect.objectContaining({ state: "unknown" })
    );
    expect(snapshot.find((entry) => entry.id === "connection.remote-server")).toEqual(
      expect.objectContaining({ state: "unknown" })
    );
  });

  it("fault-isolates direct adapters and stamps one observation time", async () => {
    const adapters = Object.fromEntries(
      [
        "ai-provider",
        "google-workspace",
        "github",
        "browser-environment",
        "local-models",
        "agent-defaults",
        "web-search",
      ].map((key) => [key, healthy])
    );
    adapters["github"] = vi.fn(async () => {
      throw new Error("private provider diagnostic");
    });

    const snapshot = await composeOnboardingSnapshot({}, dependencies(adapters));

    expect(snapshot.find((entry) => entry.id === "connection.github")).toEqual(
      expect.objectContaining({
        state: "unknown",
        summary: "Status could not be read right now.",
      })
    );
    expect(snapshot.find((entry) => entry.id === "connection.google-workspace")?.state).toBe(
      "configured"
    );
    expect(new Set(snapshot.map((entry) => entry.observedAt))).toEqual(
      new Set(["2026-07-24T12:00:00.000Z"])
    );
    expect(JSON.stringify(snapshot)).not.toContain("private provider diagnostic");
  });

  it("uses exactly one host-topology read for both host rows", async () => {
    const deps = dependencies({
      "ai-provider": healthy,
      "google-workspace": healthy,
      github: healthy,
      "browser-environment": healthy,
      "local-models": healthy,
      "agent-defaults": healthy,
      "web-search": healthy,
    });

    const snapshot = await composeOnboardingSnapshot({}, deps);

    expect(deps.readHostTopology).toHaveBeenCalledTimes(1);
    expect(snapshot.find((entry) => entry.id === "connection.device")).toEqual(
      expect.objectContaining({
        tier: "host-topology",
        state: "connected",
        nextAction: "change",
      })
    );
    expect(snapshot.find((entry) => entry.id === "connection.remote-server")?.summary).toContain(
      "local server"
    );
  });

  it("reports a missing shipped mobile owner as a base capability fault", async () => {
    const deps = dependencies({
      "ai-provider": healthy,
      "google-workspace": healthy,
      github: healthy,
      "browser-environment": healthy,
      "local-models": healthy,
      "agent-defaults": healthy,
      "web-search": healthy,
    });
    deps.hasSkill = vi.fn(async () => false);

    const snapshot = await composeOnboardingSnapshot({}, deps);

    expect(snapshot.find((entry) => entry.id === "connection.device")).toEqual(
      expect.objectContaining({
        state: "unavailable",
        attention: "blocking",
        rawStage: "owner-unavailable",
      })
    );
    expect(snapshot.find((entry) => entry.id === "connection.device")?.nextAction).toBeUndefined();
  });

  it("does not offer setup again for a verified connection", async () => {
    const verified: CapabilityOnboardingStatusAdapter = vi.fn(
      async (): ReturnType<CapabilityOnboardingStatusAdapter> => ({
        state: "connected",
        verification: "verified",
        summary: "Verified.",
        attention: "none",
      })
    );
    const deps = dependencies({
      "ai-provider": healthy,
      "google-workspace": verified,
      github: verified,
      "browser-environment": healthy,
      "local-models": healthy,
      "agent-defaults": healthy,
      "web-search": healthy,
    });

    const snapshot = await composeOnboardingSnapshot({}, deps);

    expect(snapshot.find((entry) => entry.id === "connection.github")).toEqual(
      expect.objectContaining({
        state: "connected",
        verification: "verified",
      })
    );
    expect(snapshot.find((entry) => entry.id === "connection.github")?.nextAction).toBeUndefined();
  });
});
