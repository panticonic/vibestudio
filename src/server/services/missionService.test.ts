import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionCharter } from "@vibestudio/shared/authority/mission";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { MissionRegistry } from "./missionRegistry.js";
import { createMissionService } from "./missionService.js";

const charter = (): MissionCharter => ({
  taskSpec: "Summarize the workspace",
  harness: { unit: "workers/system-agent", ev: "a".repeat(64) },
  skills: [],
  toolExposure: {
    services: ["notification.post"],
    userlandServices: [],
    workspaceServiceDiscovery: "bound",
    evalNetwork: "none",
    declaredOrigins: [],
  },
  model: { modelId: "openai-codex:gpt-5.3-codex-spark", params: {} },
  trigger: { kind: "manual" },
});

function userContext(userId: string, deviceId: string) {
  return {
    caller: {
      runtime: { kind: "shell", id: deviceId },
      subject: { userId, handle: userId },
    },
  };
}

describe("mission service ownership", () => {
  it("shows users only their missions while retaining host-wide lifecycle visibility", async () => {
    const statePath = mkdtempSync(join(tmpdir(), "mission-service-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const alice = registry.createDraft({
      name: "Alice mission",
      charter: charter(),
      owner: { userId: "alice", deviceId: "alice-device" },
    });
    const bob = registry.createDraft({
      name: "Bob mission",
      charter: charter(),
      owner: { userId: "bob", deviceId: "bob-device" },
    });
    const service = createMissionService({
      registry,
      contextIntegrityReady: () => true,
    });

    const aliceList = (await service.handler(
      userContext("alice", "alice-phone") as never,
      "list",
      []
    )) as Array<{ missionId: string }>;
    expect(aliceList.map((mission) => mission.missionId)).toEqual([alice.missionId]);
    expect(
      await service.handler(userContext("alice", "alice-phone") as never, "get", [bob.missionId])
    ).toBeNull();

    const hostList = (await service.handler(
      {
        caller: {
          runtime: { kind: "server", id: "server" },
          hostOriginated: true,
        },
      } as never,
      "list",
      []
    )) as Array<{ missionId: string }>;
    expect(new Set(hostList.map((mission) => mission.missionId))).toEqual(
      new Set([alice.missionId, bob.missionId])
    );

    await expect(
      service.handler(userContext("alice", "alice-phone") as never, "edit", [
        bob.missionId,
        { name: "Not Alice's mission" },
      ])
    ).rejects.toMatchObject({ code: "EACCES" });

    registry.close();
    grants.close();
  });
});
