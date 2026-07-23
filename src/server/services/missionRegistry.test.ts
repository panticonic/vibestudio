import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MissionCharter } from "@vibestudio/shared/authority/mission";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { MissionRegistry } from "./missionRegistry.js";

const charter = (): MissionCharter => ({
  taskSpec: "Post a nightly summary",
  harness: { unit: "workspace/workers/system-agent", ev: "a".repeat(64) },
  skills: [],
  toolExposure: {
    services: ["notification.post"],
    userlandServices: [],
    evalNetwork: "none",
    declaredOrigins: [],
  },
  model: { modelId: "openai-codex:gpt-5.3-codex-spark", params: {} },
  trigger: { kind: "cron", cron: "0 2 * * *" },
});

describe("MissionRegistry", () => {
  it("never lets an ordinary approved unit become a mission conduit", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => false,
    });
    const draft = registry.createDraft({
      name: "Nightly",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
    });
    expect(() =>
      registry.approve({
        missionId: draft.missionId,
        permissions: [],
        decidedBy: "user:u",
        contextIntegrityReady: true,
      })
    ).toThrow(/not a product-blessed conduit/);
    registry.close();
    grants.close();
  });

  it("gates approval on integrity and lapses authority on charter drift", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const draft = registry.createDraft({
      name: "Nightly",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
    });
    expect(() =>
      registry.approve({
        missionId: draft.missionId,
        permissions: [],
        decidedBy: "user:u",
        contextIntegrityReady: false,
      })
    ).toThrow(/trust update/);
    registry.approve({
      missionId: draft.missionId,
      permissions: [
        {
          capability: "service:notification.post",
          resource: { kind: "exact", key: "service:notification.post" },
        },
      ],
      decidedBy: "user:u",
      contextIntegrityReady: true,
    });
    expect(
      registry.startSession({
        missionId: draft.missionId,
        sessionId: "chat",
        taskRef: "task",
        runId: "run",
      }).missionId
    ).toBe(draft.missionId);
    expect(registry.factForSession("chat")?.closureDigest).toBe(draft.closureDigest);
    registry.finishSession({ sessionId: "chat", runId: "run", outcome: "complete", now: 100 });
    expect(registry.factForSession("chat")).toBeNull();
    expect(() =>
      registry.finishSession({ sessionId: "chat", runId: "different", outcome: "complete" })
    ).toThrow(/not active/);
    expect(
      registry.startSession({
        missionId: draft.missionId,
        sessionId: "chat-2",
        taskRef: "task",
        runId: "run-2",
      }).missionId
    ).toBe(draft.missionId);
    expect(
      registry.edit(draft.missionId, { charter: { ...charter(), taskSpec: "Different" } }).state
    ).toBe("needs-reapproval");
    expect(registry.factForSession("chat-2")).toBeNull();
    registry.close();
    grants.close();
  });

  it("rejects grants and calls outside the reviewed exposure", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const draft = registry.createDraft({
      name: "Nightly",
      charter: charter(),
      owner: { userId: "u", deviceId: "d" },
    });
    expect(() =>
      registry.approve({
        missionId: draft.missionId,
        permissions: [
          { capability: "service:credential.delete", resource: { kind: "exact", key: "x" } },
        ],
        decidedBy: "user:u",
        contextIntegrityReady: true,
      })
    ).toThrow(/exceeds tool exposure/);
    registry.close();
    grants.close();
  });

  it("binds userland service authority to the reviewed provider EV", () => {
    const statePath = mkdtempSync(join(tmpdir(), "missions-"));
    const grants = new CapabilityGrantStore({ statePath });
    const registry = new MissionRegistry({
      statePath,
      grantStore: grants,
      isConduitBlessed: () => true,
    });
    const providerEv = "b".repeat(64);
    const userlandCharter: MissionCharter = {
      ...charter(),
      toolExposure: {
        ...charter().toolExposure,
        userlandServices: [
          {
            name: "notes",
            provider: "workers/notes",
            providerEv,
            upgradePolicy: "pinned",
          },
        ],
      },
    };
    const draft = registry.createDraft({
      name: "Notes",
      charter: userlandCharter,
      owner: { userId: "u", deviceId: "d" },
    });
    registry.approve({
      missionId: draft.missionId,
      permissions: [
        {
          capability: "workspace-service:notes",
          resource: { kind: "prefix", prefix: "do:workers/notes:" },
        },
      ],
      decidedBy: "user:u",
      contextIntegrityReady: true,
    });
    registry.startSession({
      missionId: draft.missionId,
      sessionId: "notes-run",
      taskRef: "task",
      runId: "run",
    });
    expect(() =>
      registry.assertUserlandServiceExposure({
        sessionId: "notes-run",
        name: "notes",
        provider: "workers/notes",
        providerEv,
      })
    ).not.toThrow();
    expect(() =>
      registry.assertUserlandServiceExposure({
        sessionId: "notes-run",
        name: "notes",
        provider: "workers/notes",
        providerEv: "c".repeat(64),
      })
    ).toThrow(/does not expose/);
    registry.close();
    grants.close();
  });
});
