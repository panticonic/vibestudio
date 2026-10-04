import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";

const owners = new Set<CapabilityGrantStore>();
const roots: string[] = [];
afterEach(() => {
  for (const owner of owners) owner.close();
  owners.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), "target-authority-owner-"));
  roots.push(root);
  return root;
}
function open(root: string) {
  const owner = new CapabilityGrantStore({ statePath: root });
  owners.add(owner);
  return owner;
}
function close(owner: CapabilityGrantStore) {
  owner.close();
  owners.delete(owner);
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
    const firstOwner = open(root);
    const firstStore = firstOwner.targetRequests;
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
    close(firstOwner);

    const reopenedOwner = open(root);
    const reopened = reopenedOwner.targetRequests;
    expect(reopened.subject(subject)).toEqual({
      authorityPlanDigest: input.authorityPlanDigest,
      ownerUser: input.sourceUser,
      controllerRuntimeId: "do:missions",
      state: "active",
    });
    expect(reopened.ensure(input, 30)).toEqual(first);
    expect(reopened.pending()).toEqual([first]);
    reopened.settle(first.requestId, "granted", () => "grant:one", 40);
    expect(reopened.pending()).toEqual([]);
    expect(reopened.forPlan(subject, input.authorityPlanDigest)).toEqual([
      { ...first, state: "granted", settledAt: 40, grantId: "grant:one" },
    ]);
    close(reopenedOwner);
  });

  it("fences a retired subject and durably cancels its pending requests", () => {
    const owner = open(statePath());
    const store = owner.targetRequests;
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
    close(owner);
  });

  it("associates one semantic request with every plan that references it", () => {
    const owner = open(statePath());
    const store = owner.targetRequests;
    const subject = `task:${"a".repeat(64)}` as const;
    const firstPlan = "b".repeat(64);
    const secondPlan = "d".repeat(64);
    const common = {
      targetSubject: subject,
      operationKey: "notification.showToUser:owner",
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

    const first = store.ensure({ ...common, authorityPlanDigest: firstPlan }, 10);
    const second = store.ensure({ ...common, authorityPlanDigest: secondPlan }, 20);

    expect(second.requestId).toBe(first.requestId);
    expect(store.pending()).toHaveLength(1);
    expect(store.forPlan(subject, firstPlan)).toEqual([
      expect.objectContaining({ requestId: first.requestId, authorityPlanDigest: firstPlan }),
    ]);
    expect(store.forPlan(subject, secondPlan)).toEqual([
      expect.objectContaining({ requestId: first.requestId, authorityPlanDigest: secondPlan }),
    ]);
    close(owner);
  });
});
