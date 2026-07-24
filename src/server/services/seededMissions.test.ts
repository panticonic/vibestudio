import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { MissionRegistry } from "./missionRegistry.js";
import {
  loadMissionSeedDefinitions,
  reconcileSeededMissions,
  type MissionSeedDefinition,
} from "./seededMissions.js";

const definition = (): MissionSeedDefinition => ({
  schemaVersion: 1,
  missionId: "msn_seeded",
  name: "Seeded",
  charter: {
    agentBindingId: "agent-seeded",
    taskSpec: "Inspect the workspace",
    harness: { unit: "workers/system-agent", ev: "@seed" },
    skills: [],
    toolExposure: {
      services: [],
      userlandServices: [],
      workspaceServiceDiscovery: "bound",
      evalNetwork: "none",
      declaredOrigins: [],
    },
    model: { modelId: "openai-codex:gpt-5.3-codex-spark", params: {} },
    declaredLineageClasses: ["none"],
    trigger: { kind: "event", event: { source: "test", filter: { kind: "all" } } },
  },
  permissions: [],
  standingRestrictions: [],
});

describe("seeded mission reconciliation", () => {
  it("loads strict reviewed definitions and rejects unknown schema fields", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mission-seeds-"));
    fs.writeFileSync(path.join(directory, "valid.json"), JSON.stringify(definition()));
    expect(loadMissionSeedDefinitions(directory)).toEqual([definition()]);
    fs.writeFileSync(
      path.join(directory, "invalid.json"),
      JSON.stringify({ ...definition(), automaticallyApproved: true })
    );
    expect(() => loadMissionSeedDefinitions(directory)).toThrow(/Unrecognized key/);
  });

  it("resolves seed placeholders only from the immutable product inputs", () => {
    const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "mission-seed-state-"));
    const grants = new CapabilityGrantStore({ statePath });
    const ev = "a".repeat(64);
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: (identity) =>
        identity.unit === "workers/system-agent" && identity.ev === ev,
    });
    expect(
      reconcileSeededMissions({
        productSnapshotState: `state:${"b".repeat(64)}`,
        definitions: [definition()],
        harnessVersions: new Map([["workers/system-agent", ev]]),
        registry,
        now: 10,
      })[0]
    ).toMatchObject({
      missionId: "msn_seeded",
      state: "active",
      seeded: true,
      charter: { harness: { unit: "workers/system-agent", ev } },
    });
    expect(() =>
      reconcileSeededMissions({
        productSnapshotState: `state:${"b".repeat(64)}`,
        definitions: [definition()],
        harnessVersions: new Map(),
        registry,
      })
    ).toThrow(/no exact product harness version/);
    registry.close();
    grants.close();
  });
});
