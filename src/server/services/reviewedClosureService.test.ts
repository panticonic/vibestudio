import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createReviewedClosureService } from "./reviewedClosureService.js";

const activate = {
  body: {
    subjectPrefix: "mission:daily",
    sourceDocument: {
      kind: "mission",
      id: "daily",
      revision: 1,
      digest: "d".repeat(64),
    },
    harness: { unit: "workers/agent", ev: "a".repeat(64), ref: `state:${"b".repeat(64)}` },
    exposure: {
      serviceMethods: [],
      userlandServices: { discovery: "bound", bindings: [] },
      network: { mode: "none" },
    },
    grants: [],
    grantDependencies: [],
    lineageClasses: [],
    owner: "user:alice",
    issuer: "do:workers/missions:MissionsDO:workspace-missions",
  },
  closureDigest: "b".repeat(64),
};

describe("reviewed closure publisher admission", () => {
  it("installs directly without preparing an approval surface", async () => {
    const caller = createVerifiedCaller("do:workers/missions:MissionsDO:workspace-missions", "do", {
      callerId: "do:workers/missions:MissionsDO:workspace-missions",
      callerKind: "do",
      repoPath: "workers/missions",
      effectiveVersion: "missions-v1",
      executionDigest: "c".repeat(64),
      requested: [],
    });
    caller.codeApproved = true;
    const registry = { activate: vi.fn(() => ({ state: "active" })) };
    const service = createReviewedClosureService({ registry: registry as never });
    const authorizingCaller = createVerifiedCaller("panel:alice", "panel", null, null, {
      userId: "alice",
      handle: "alice",
    });
    expect(service.authorityPreparation).toBeUndefined();
    await service.handler({ caller, authorizingCaller } as never, "activate", [activate] as never);
    expect(registry.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        publisher: "do:workers/missions:MissionsDO:workspace-missions",
        body: expect.objectContaining({ issuer: activate.body.issuer }),
      })
    );
  });

  it("attributes intrinsic lifecycle transitions to the verified issuer", async () => {
    const caller = createVerifiedCaller("do:workers/missions:MissionsDO:workspace-missions", "do");
    const registry = {
      suspend: vi.fn(() => ({ state: "suspended" })),
      retire: vi.fn(() => ({ state: "retired" })),
    };
    const service = createReviewedClosureService({ registry: registry as never });

    await service.handler({ caller } as never, "suspend", ["mission:daily@digest"]);
    await service.handler({ caller } as never, "retire", ["mission:daily@digest"]);

    expect(registry.suspend).toHaveBeenCalledWith(
      "mission:daily@digest",
      "do:workers/missions:MissionsDO:workspace-missions"
    );
    expect(registry.retire).toHaveBeenCalledWith(
      "mission:daily@digest",
      "do:workers/missions:MissionsDO:workspace-missions"
    );
  });
});
