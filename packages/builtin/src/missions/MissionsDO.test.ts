import { describe, expect, it } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import type { MissionCharter, MissionRecord } from "@vibestudio/shared/authority/mission";
import type { ReviewedExecutionClosureBody } from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { MissionsDO } from "./MissionsDO.js";

const charter = (): MissionCharter => ({
  agentBindingId: "agent-one",
  taskSpec: "Prepare a daily summary",
  harness: { unit: "workers/summary", ev: "a".repeat(64) },
  skills: [],
  toolExposure: {
    services: ["docs.read"],
    userlandServices: [],
    workspaceServiceDiscovery: "bound",
    evalNetwork: "none",
    declaredOrigins: [],
  },
  model: { modelId: "model", params: {} },
  declaredLineageClasses: ["none"],
  trigger: { kind: "manual" },
});

async function missions() {
  return createTestDO(
    MissionsDO,
    {
      WORKER_SOURCE: "vibestudio/internal",
      WORKER_CLASS_NAME: "MissionsDO",
      __objectKey: "workspace",
    }
  );
}

describe("MissionsDO", () => {
  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await missions();
    const productMethods = [...rpcExposedMethodNames(instance)].filter(
      (method) => method !== "durableWorkCapabilities"
    );
    expect(productMethods.sort()).toEqual(Object.keys(missionsMethods).sort());
  });

  it("owns drafts per authenticated user and records a revision digest", async () => {
    const { callAs } = await missions();
    const alice = { callerId: "panel:alice", callerKind: "panel" as const, userId: "alice" };
    const bob = { callerId: "panel:bob", callerKind: "panel" as const, userId: "bob" };
    const created = await callAs<MissionRecord>(alice, "createDraft", {
      name: "Daily summary",
      charter: charter(),
      permissions: [],
    });

    expect(created).toMatchObject({
      name: "Daily summary",
      state: "draft",
      revision: 1,
      owner: { userId: "alice", deviceId: "panel:alice" },
    });
    expect(created.revisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(callAs(bob, "get", created.missionId)).rejects.toThrow(/Unknown mission/);
    await expect(callAs<MissionRecord[]>(alice, "list")).resolves.toEqual([
      expect.objectContaining({ missionId: created.missionId }),
    ]);
  });

  it("compiles only eligible gated permissions into standing grants", async () => {
    const { instance, callAs } = await missions();
    const created = await callAs<MissionRecord>(
      { callerId: "panel:alice", callerKind: "panel", userId: "alice" },
      "createDraft",
      {
        name: "Daily summary",
        charter: charter(),
        permissions: [
          {
            capability: "docs.read",
            resource: { kind: "prefix", prefix: "docs/" },
            tier: "gated",
          },
          {
            capability: "workspace.storage.delete",
            resource: { kind: "exact", key: "workspace" },
            tier: "critical",
          },
        ],
      }
    );
    const compiled = (
      instance as unknown as {
        compileClosure(record: MissionRecord): { body: ReviewedExecutionClosureBody };
      }
    ).compileClosure(created);

    expect(compiled.body.grants).toEqual([
      expect.objectContaining({ capability: "docs.read", tier: "gated" }),
    ]);
    expect(compiled.body.grantDependencies).toEqual([
      expect.objectContaining({
        subject: "agent:agent-one",
        capability: "docs.read",
      }),
    ]);
  });
});
