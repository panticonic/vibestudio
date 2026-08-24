import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createAuthorityService } from "./authorityService.js";

describe("authorityService", () => {
  it("forwards the inbound cancellation signal to an authority wait", async () => {
    const signal = new AbortController().signal;
    const awaitDecision = vi.fn(async () => ({ state: "closed" as const }));
    const service = createAuthorityService({
      dispatcher: { preflightAuthority: vi.fn() } as never,
      acquisitions: { awaitDecision } as never,
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("agent:1", "agent"), signal },
        "awaitDecision",
        [{ acquisitionId: "acq:1" }]
      )
    ).resolves.toEqual({ state: "closed" });
    expect(awaitDecision).toHaveBeenCalledWith({
      acquisitionId: "acq:1",
      ownerRuntimeId: "agent:1",
      signal,
    });
  });

  it("retires owner-attributed authority only after live executions close", async () => {
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    const hasLiveMissionSubject = vi.fn(() => true);
    const retireTargetSubject = vi.fn(() => ({ cancelledRequests: 2 }));
    const revokeSubject = vi.fn(() => 3);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          policyDigest: "b".repeat(64),
          ownerUser: "user:alice",
          state: "active",
        }),
        retireTargetSubject,
      } as never,
      executionAdmissions: { hasLiveMissionSubject } as never,
      grants: { revokeSubject } as never,
    });
    const context = {
      caller: createVerifiedCaller("do:missions", "do"),
      authorization: { actingUser: "user:alice", ownerChain: ["user:alice"] },
    } as never;
    await expect(
      service.handler(context, "retireTarget", [{ targetSubject: subject }])
    ).rejects.toMatchObject({ code: "EBUSY" });
    hasLiveMissionSubject.mockReturnValue(false);
    await expect(
      service.handler(context, "retireTarget", [{ targetSubject: subject }])
    ).resolves.toEqual({ cancelledRequestCount: 2, revokedGrantCount: 3 });
    expect(retireTargetSubject).toHaveBeenCalledWith(subject);
    expect(revokeSubject).toHaveBeenCalledWith(subject);
  });

  it("attributes target acquisition to the verified authorizing user across a code relay", async () => {
    const registerTargetSubject = vi.fn();
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        registerTargetSubject,
        targetRequestsFor: () => [],
      } as never,
      operationPolicies: {
        get: () => ({ leaves: [] }),
      } as never,
    });
    const context = {
      caller: createVerifiedCaller("do:workers/missions:MissionsDO:workspace", "do"),
      authorizingCaller: createVerifiedCaller("agent:launcher", "agent", undefined, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    await expect(
      service.handler(context, "acquireForTarget", [
        { targetSubject: subject, operationPolicyDigest: "b".repeat(64) },
      ])
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(registerTargetSubject).toHaveBeenCalledWith(subject, "b".repeat(64), "user:alice");
  });
});
