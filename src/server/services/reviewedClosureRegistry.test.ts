import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reviewedExecutionClosureDigest,
  type ReviewedExecutionClosureBody,
} from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { ReviewedClosureRegistry } from "./reviewedClosureRegistry.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function harness() {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-closure-"));
  const grantStore = new CapabilityGrantStore({ statePath });
  const registry = new ReviewedClosureRegistry({
    statePath,
    grantStore,
    isHarnessBlessed: ({ unit, ev }) => unit === "workers/agent" && ev === "a".repeat(64),
  });
  cleanups.push(() => {
    registry.close();
    grantStore.close();
    fs.rmSync(statePath, { recursive: true, force: true });
  });
  const body: ReviewedExecutionClosureBody = {
    subjectPrefix: "mission:msn_test",
    exposure: {
      serviceMethods: ["docs.read"],
      userlandServices: {
        discovery: "bound",
        bindings: [
          {
            name: "mail",
            provider: "extensions/mail",
            providerEv: "b".repeat(64),
            upgradePolicy: "pinned",
          },
        ],
      },
      network: { mode: "declared-origins", origins: ["https://api.example.test"] },
    },
    harness: { unit: "workers/agent", ev: "a".repeat(64), ref: `state:${"b".repeat(64)}` },
    grants: [
      {
        effect: "allow",
        capability: "docs.read",
        resource: { kind: "prefix", prefix: "docs/" },
        tier: "gated",
      },
    ],
    grantDependencies: [],
    lineageClasses: ["none"],
    owner: "user:owner",
    issuer: "builtin:missions",
    sourceDocument: {
      kind: "mission",
      id: "msn_test",
      revision: 1,
      digest: "c".repeat(64),
    },
  };
  return { registry, grantStore, body };
}

describe("ReviewedClosureRegistry", () => {
  it("binds hot-path enforcement to the immutable compiled closure", () => {
    const { registry, grantStore, body } = harness();
    const closureDigest = reviewedExecutionClosureDigest(body);
    const closure = registry.activate({
      body,
      closureDigest,
      publisher: "builtin:missions",
      decidedBy: "user:owner",
      now: 10,
    });
    expect(closure.subject).toBe(`mission:msn_test@${closureDigest}`);
    expect(grantStore.listActiveAuthorityGrants()).toEqual([
      expect.objectContaining({
        subject: closure.subject,
        capability: "docs.read",
      }),
    ]);

    registry.bindSession({
      subject: closure.subject,
      closureDigest,
      sessionId: "session-1",
      taskRef: "task-1",
      binderId: "builtin:missions",
      now: 11,
    });
    expect(() => registry.assertServiceExposure("session-1", "docs.read")).not.toThrow();
    expect(() => registry.assertServiceExposure("session-1", "docs.write")).toThrowError(
      /does not expose/
    );
    expect(registry.assertNetworkExposure("session-1", "https://api.example.test")).toBe(true);
    expect(() =>
      registry.assertNetworkExposure("session-1", "https://other.example.test")
    ).toThrowError(/does not expose network origin/);
  });

  it("fails closed on digest drift and suspension", () => {
    const { registry, body } = harness();
    expect(() =>
      registry.activate({
        body,
        closureDigest: "d".repeat(64),
        publisher: "builtin:missions",
        decidedBy: "user:owner",
      })
    ).toThrowError(/digest/);

    const closureDigest = reviewedExecutionClosureDigest(body);
    const closure = registry.activate({
      body,
      closureDigest,
      publisher: "builtin:missions",
      decidedBy: "user:owner",
    });
    registry.bindSession({
      subject: closure.subject,
      closureDigest,
      sessionId: "session-1",
      taskRef: "task-1",
      binderId: "builtin:missions",
    });
    expect(() => registry.suspend(closure.subject, "another-worker")).toThrowError(
      /Only the reviewed closure issuer/
    );
    registry.suspend(closure.subject, "builtin:missions");
    expect(registry.factForSession("session-1")).toBeNull();
  });

  it("finishes a bound session idempotently without weakening binder ownership", () => {
    const { registry, body } = harness();
    const closureDigest = reviewedExecutionClosureDigest(body);
    const closure = registry.activate({
      body,
      closureDigest,
      publisher: "builtin:missions",
      decidedBy: "user:owner",
    });
    registry.bindSession({
      subject: closure.subject,
      closureDigest,
      sessionId: "session-finish",
      taskRef: "task-finish",
      binderId: "builtin:missions",
    });

    expect(() => registry.finishSession("session-finish", "builtin:missions", 20)).not.toThrow();
    expect(() => registry.finishSession("session-finish", "builtin:missions", 21)).not.toThrow();
    expect(() => registry.finishSession("session-finish", "other-worker", 22)).toThrowError(
      /Only the session binder/
    );
    expect(() => registry.finishSession("unknown-session", "builtin:missions", 23)).toThrowError(
      /Unknown reviewed closure session/
    );
  });

  it("rejects critical standing grants", () => {
    const { registry, body } = harness();
    const unsafeBody: ReviewedExecutionClosureBody = {
      ...body,
      grants: body.grants.map((grant) => ({ ...grant, tier: "critical" })),
    };
    expect(() =>
      registry.activate({
        body: unsafeBody,
        closureDigest: reviewedExecutionClosureDigest(unsafeBody),
        publisher: "builtin:missions",
        decidedBy: "user:owner",
      })
    ).toThrowError(/Critical authority/);
  });

  it("suspends the closure and its sessions when an upstream grant is withdrawn", () => {
    const { registry, grantStore, body } = harness();
    const upstream = grantStore.issue({
      effect: "allow",
      capability: "docs.read",
      resource: { kind: "prefix", prefix: "docs/" },
      subject: "agent:agent-one",
      constraints: { lineageAtConsent: ["none"], agentBindingId: "agent-one" },
      issuedBy: "user:owner",
      provenance: "acquisition",
      scope: "agent",
    });
    const dependentBody: ReviewedExecutionClosureBody = {
      ...body,
      grantDependencies: [
        {
          subject: "agent:agent-one",
          capability: "docs.read",
          resource: { kind: "prefix", prefix: "docs/" },
        },
      ],
    };
    const closureDigest = reviewedExecutionClosureDigest(dependentBody);
    const closure = registry.activate({
      body: dependentBody,
      closureDigest,
      publisher: "builtin:missions",
      decidedBy: "user:owner",
    });
    registry.bindSession({
      subject: closure.subject,
      closureDigest,
      sessionId: "dependent-session",
      taskRef: "task",
      binderId: "builtin:missions",
    });

    expect(grantStore.revoke(upstream.id!)).toBe(true);
    expect(registry.get(closure.subject)?.state).toBe("suspended");
    expect(registry.factForSession("dependent-session")).toBeNull();
  });
});
