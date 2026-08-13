import { describe, expect, it } from "vitest";
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
    harness: { unit: "workers/agent", ev: "a".repeat(64) },
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
  presentation: {
    title: "Activate daily summary",
    description: "Review this automation.",
    summary: "Summarize today",
  },
};

function prepare(caller: ReturnType<typeof createVerifiedCaller>) {
  const service = createReviewedClosureService({ registry: {} as never });
  return service.authorityPreparation?.["reviewedClosure.activate.presentation"]?.({ caller }, [
    activate,
  ]);
}

describe("reviewed closure publisher admission", () => {
  it("admits the exact reviewed workspace MissionsDO identity", async () => {
    const caller = createVerifiedCaller("do:workers/missions:MissionsDO:workspace-missions", "do", {
      callerId: "do:workers/missions:MissionsDO:workspace-missions",
      callerKind: "do",
      repoPath: "workers/missions",
      effectiveVersion: "missions-v1",
      executionDigest: "c".repeat(64),
      requested: [],
    });
    caller.codeApproved = true;

    expect(prepare(caller)).toMatchObject({
      selections: [{ capability: "reviewed-closure.activate" }],
    });
  });

  it("rejects builtin identity and mismatched or unreviewed workspace code", async () => {
    const builtin = createVerifiedCaller(
      "do:vibestudio/internal:MissionsDO:workspace-missions",
      "do",
      {
        callerId: "do:vibestudio/internal:MissionsDO:workspace-missions",
        callerKind: "do",
        repoPath: "vibestudio/internal",
        effectiveVersion: "host",
        executionDigest: "c".repeat(64),
        requested: [],
      }
    );
    builtin.codeApproved = true;
    expect(() => prepare(builtin)).toThrow(
      "Reviewed closure presentation requires the exact admitted workspace worker identity"
    );

    const unreviewed = createVerifiedCaller(
      "do:workers/missions:MissionsDO:workspace-missions",
      "do",
      {
        callerId: "do:workers/missions:MissionsDO:workspace-missions",
        callerKind: "do",
        repoPath: "workers/missions",
        effectiveVersion: "missions-v1",
        executionDigest: "c".repeat(64),
        requested: [],
      }
    );
    expect(() => prepare(unreviewed)).toThrow(
      "Reviewed closure presentation requires the exact admitted workspace worker identity"
    );

    const mismatched = { ...unreviewed, codeApproved: true as const };
    mismatched.code = { ...unreviewed.code!, repoPath: "workers/other" };
    expect(() => prepare(mismatched)).toThrow(
      "Reviewed closure presentation requires the exact admitted workspace worker identity"
    );

    const admitted = { ...unreviewed, codeApproved: true as const };
    expect(() =>
      createReviewedClosureService({ registry: {} as never }).authorityPreparation?.[
        "reviewedClosure.activate.presentation"
      ]?.({ caller: admitted }, [
        {
          ...activate,
          body: { ...activate.body, issuer: "do:workers/other:OtherDO:key" },
        },
      ])
    ).toThrow(
      "Reviewed closure presentation requires the exact admitted workspace worker identity"
    );
  });
});
