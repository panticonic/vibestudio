import { describe, expect, it } from "vitest";
import {
  missionAllowsService,
  missionClosureDigest,
  missionEventMatches,
  missionSubject,
  type MissionCharter,
} from "./mission.js";

const hex = "a".repeat(64);
const charter = (): MissionCharter => ({
  agentBindingId: "agent-backup",
  taskSpec: "Back up the project",
  harness: { unit: "workers/system-agent", ev: hex },
  skills: [{ path: "workspace/skills/backup", contentHash: "b".repeat(64) }],
  toolExposure: {
    services: ["logs.query", "notification.*"],
    userlandServices: [],
    workspaceServiceDiscovery: "bound",
    evalNetwork: "none",
    declaredOrigins: [],
  },
  model: { modelId: "openai-codex:gpt-5.3-codex-spark", params: { reasoningEffort: "medium" } },
  declaredLineageClasses: ["none"],
  trigger: { kind: "cron", cron: "0 2 * * *" },
});
const closure = (value: MissionCharter): string => missionClosureDigest(value, [], []);

describe("mission closure", () => {
  it("changes for behavioral edits but not registry identity", () => {
    const first = closure(charter());
    expect(closure({ ...charter(), trigger: { kind: "cron", cron: "0 3 * * *" } })).not.toBe(first);
    expect(missionSubject({ missionId: "msn_one", closureDigest: first })).not.toBe(
      missionSubject({ missionId: "msn_two", closureDigest: first })
    );
  });

  it("changes when approved allows or standing denies change", () => {
    const empty = missionClosureDigest(charter(), [], []);
    expect(
      missionClosureDigest(
        charter(),
        [
          {
            capability: "service:notification.post",
            resource: { kind: "exact", key: "service:notification.post" },
            tier: "gated",
          },
        ],
        []
      )
    ).not.toBe(empty);
    expect(
      missionClosureDigest(
        charter(),
        [],
        [{ capability: "credential.use", resourceKey: "credentials:all" }]
      )
    ).not.toBe(empty);
  });

  it("enforces structural method exposure and rejects global wildcards", () => {
    expect(missionAllowsService(charter(), "notification.post")).toBe(true);
    expect(missionAllowsService(charter(), "credential.delete")).toBe(false);
    expect(() =>
      closure({
        ...charter(),
        toolExposure: { ...charter().toolExposure, services: ["*"] },
      })
    ).toThrow(/Invalid/);
    expect(() =>
      closure({
        ...charter(),
        toolExposure: {
          ...charter().toolExposure,
          workspaceServiceDiscovery: "live-declarations",
          userlandServices: [
            {
              name: "notes",
              provider: "workers/notes",
              providerEv: "b".repeat(64),
              upgradePolicy: "pinned",
            },
          ],
        },
      })
    ).toThrow(/cannot be combined/);
  });

  it("uses the same canonical repo identity as sealed harness code", () => {
    expect(() =>
      closure({
        ...charter(),
        harness: { ...charter().harness, unit: "workspace/workers/system-agent" },
      })
    ).toThrow(/canonical workspace repo/);
  });

  it("uses a closed data-only event filter grammar", () => {
    expect(() =>
      closure({
        ...charter(),
        trigger: {
          kind: "event",
          event: {
            source: "workspace.file.changed",
            filter: { kind: "field-equals", path: ["repo", "kind"], value: "worker" },
          },
        },
      })
    ).not.toThrow();
    expect(() =>
      closure({
        ...charter(),
        trigger: {
          kind: "event",
          event: {
            source: "workspace.file.changed",
            filter: { kind: "field-equals", path: ["__proto__"], value: true },
          },
        },
      })
    ).toThrow(/invalid field path/);
    expect(
      missionEventMatches(
        { kind: "field-equals", path: ["repo", "kind"], value: "worker" },
        { repo: { kind: "worker" } }
      )
    ).toBe(true);
    expect(
      missionEventMatches(
        { kind: "field-equals", path: ["repo", "kind"], value: "worker" },
        Object.create({ repo: { kind: "worker" } }) as unknown
      )
    ).toBe(false);
  });
});
