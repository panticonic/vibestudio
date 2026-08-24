import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TargetAuthorityRequestStore } from "./targetAuthorityRequestStore.js";

function statePath(): string {
  return mkdtempSync(join(tmpdir(), "target-authority-store-"));
}

describe("TargetAuthorityRequestStore", () => {
  it("owns pending acquisition by target revision and deduplicates it across restart", () => {
    const root = statePath();
    const subject = `mission:nightly@${"a".repeat(64)}` as const;
    const input = {
      targetSubject: subject,
      authorityPlanDigest: "b".repeat(64),
      operationKey: `notification.showToUser:${"c".repeat(64)}`,
      capability: "notification.show",
      capabilityDefinitionDigest: "c".repeat(64),
      resource: { kind: "exact" as const, key: "user:alice" },
      tier: "gated" as const,
      sourceUser: "user:alice" as const,
      review: {
        action: "show a notification",
        domain: "people" as const,
        verb: "act" as const,
        declaredBy: "host:notification.showToUser",
      },
    };
    const firstStore = new TargetAuthorityRequestStore({ statePath: root });
    firstStore.registerSubject(
      subject,
      input.authorityPlanDigest,
      input.sourceUser,
      "do:missions",
      10
    );
    expect(() =>
      firstStore.registerSubject(subject, "d".repeat(64), input.sourceUser, "do:missions", 11)
    ).toThrow(/different ownership, controller, or policy/);
    const first = firstStore.ensure(input, 20);
    firstStore.close();

    const reopened = new TargetAuthorityRequestStore({ statePath: root });
    expect(reopened.subject(subject)).toEqual({
      authorityPlanDigest: input.authorityPlanDigest,
      ownerUser: input.sourceUser,
      controllerRuntimeId: "do:missions",
      state: "active",
    });
    expect(reopened.ensure(input, 30)).toEqual(first);
    expect(reopened.pending()).toEqual([first]);
    reopened.settle(first.requestId, "granted", "grant:one", 40);
    expect(reopened.pending()).toEqual([]);
    expect(reopened.forPlan(subject, input.authorityPlanDigest)).toEqual([
      { ...first, state: "granted", settledAt: 40, grantId: "grant:one" },
    ]);
    reopened.close();
  });

  it("fences a retired subject and durably cancels its pending requests", () => {
    const store = new TargetAuthorityRequestStore({ statePath: statePath() });
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    const policy = "b".repeat(64);
    store.registerSubject(subject, policy, "user:alice", "do:missions", 10);
    store.ensure(
      {
        targetSubject: subject,
        authorityPlanDigest: policy,
        operationKey: "notification.showToUser:leaf",
        capability: "notification.show",
        capabilityDefinitionDigest: "c".repeat(64),
        resource: { kind: "exact", key: "user:alice" },
        tier: "gated",
        sourceUser: "user:alice",
        review: {
          action: "show a notification",
          domain: "people",
          verb: "act",
          declaredBy: "host:notification.showToUser",
        },
      },
      20
    );
    expect(store.retireSubject(subject, 30)).toEqual({ cancelledRequests: 1 });
    expect(store.subject(subject)?.state).toBe("retired");
    expect(store.pending()).toEqual([]);
    expect(store.retireSubject(subject, 40)).toEqual({ cancelledRequests: 0 });
    store.close();
  });
});
