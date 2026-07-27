import { describe, expect, it, vi } from "vitest";
import type { InvocationSnapshot } from "@vibestudio/rpc";
import { evalMethods } from "@vibestudio/service-schemas/eval";
import {
  AttachedHostEndpoint,
  digest,
  type AttachedHostInvocationEnvelope,
  type AttachedHostSessionFacts,
} from "./attachedHostProtocol.js";
import { MemoryAttachedHostProtocolStore } from "./attachedHostSessionStore.js";

const FACTS: AttachedHostSessionFacts = {
  parentHostId: "host:parent",
  childHostId: "host:child",
  childGenerationId: "0123456789abcdef0123456789abcdef",
  developmentRunId: "development-run-1",
  initiatingRuntimeId: "agent:runtime-1",
  initiatingRuntimeKind: "agent",
  initiatingUserId: "usr_owner",
};
const CEILING = [
  {
    capability: "service:eval.*",
    resource: { kind: "prefix" as const, prefix: "eval:" },
  },
];

function fixture(
  input: {
    childCeiling?: typeof CEILING;
    facts?: AttachedHostSessionFacts;
    dispatch?: (input: { service: string; method: string; args: unknown[] }) => Promise<unknown>;
  } = {}
) {
  const facts = input.facts ?? FACTS;
  let now = 1_000_000;
  let sequence = 0;
  const parentStore = new MemoryAttachedHostProtocolStore();
  const childStore = new MemoryAttachedHostProtocolStore();
  const parent = new AttachedHostEndpoint({
    role: "parent",
    store: parentStore,
    now: () => now,
    randomId: () => `id-${++sequence}`,
    localFacts: () => ({ facts, authorityCeiling: CEILING }),
    resolveApprovalPresentation: (challenge) => {
      const snapshot = challenge.invocationSnapshot;
      if (
        snapshot.service !== "fs" ||
        snapshot.method !== "write" ||
        snapshot.capability !== "workspace.file.write" ||
        snapshot.resourceKey !== "context:one/a.txt" ||
        challenge.tier !== "gated"
      ) {
        return null;
      }
      return {
        title: "Write a workspace file",
        action: "write a.txt",
        description: "Writes the exact prepared contents to a.txt.",
        service: snapshot.service,
        method: snapshot.method,
        capability: snapshot.capability,
        resourceKey: snapshot.resourceKey,
        tier: challenge.tier,
        invocationSnapshotDigest: challenge.invocationSnapshotDigest,
        preparedOperationDigest: challenge.preparedOperationDigest,
      };
    },
  });
  const child = new AttachedHostEndpoint({
    role: "child",
    store: childStore,
    now: () => now,
    randomId: () => `child-${++sequence}`,
    localFacts: () => ({
      facts,
      authorityCeiling: input.childCeiling ?? CEILING,
    }),
    requiredAuthority: (service, method) => [
      {
        capability: `service:${service}.${method}`,
        resource: { kind: "exact", key: "eval:run-1" },
      },
    ],
    dispatch: async ({ service, method, args }) =>
      input.dispatch?.({ service, method, args }) ?? { service, method, args },
  });
  const hello = parent.beginParent({
    facts,
    requestedAuthorityCeiling: CEILING,
    ttlMs: 60_000,
  });
  const acceptance = child.acceptChild(hello);
  const proof = parent.confirmParent(acceptance);
  child.finalizeChild(proof);
  return {
    parent,
    child,
    parentStore,
    childStore,
    sessionId: hello.sessionId,
    advance(ms: number) {
      now += ms;
    },
  };
}

function approvalSnapshot(overrides: Partial<InvocationSnapshot> = {}): InvocationSnapshot {
  return {
    v: 1,
    service: "fs",
    method: "write",
    capability: "workspace.file.write",
    resourceKey: "context:one/a.txt",
    argsDigest: digest(["a.txt", "contents"]),
    preparedStateDigest: "c".repeat(64),
    callerPrincipal: "session:eval-one",
    sessionId: "child-authority-session",
    mission: "-",
    snippetDigest: "d".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    contextLineage: null,
    initiatorChain: ["agent:runtime-1"],
    at: 1_000_000,
    ...overrides,
  };
}

function invocation(
  f: ReturnType<typeof fixture>,
  overrides: Partial<AttachedHostInvocationEnvelope> = {}
): AttachedHostInvocationEnvelope {
  return {
    ...f.parent.createInvocation({
      sessionId: f.sessionId,
      service: "eval",
      method: "start",
      args: [{ runId: "run-1" }],
      requestId: "request-1",
      ttlMs: 10_000,
    }),
    ...overrides,
  };
}

describe("attached-host owner-bound protocol", () => {
  it("routes ordinary generated eval clients through a signed exact-generation session", async () => {
    const dispatch = vi.fn(async ({ service, method }) => {
      expect(service).toBe("eval");
      expect(method).toBe("start");
      return {
        runId: "run-1",
        runDigest: "a".repeat(64),
        authorityManifestDigest: "b".repeat(64),
        status: "accepted",
      };
    });
    const f = fixture({ dispatch });
    const evalClient = f.parent.createServiceClient(
      f.sessionId,
      "eval",
      evalMethods,
      (envelope, args) => f.child.receiveInvocation(envelope, args),
      () => "request-eval"
    );

    await expect(
      evalClient.start({
        runId: "run-1",
        target: { kind: "caller" },
        source: { kind: "inline", code: "return 1" },
        authority: {
          mode: "strict",
          effects: "read-only",
          approvals: "pregranted-only",
          requests: [],
        },
      })
    ).resolves.toMatchObject({ runId: "run-1", status: "accepted" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each([
    ["run", { invocationReference: { developmentRunId: "other-run" } }],
    ["owner", { invocationReference: { ownerRuntimeId: "agent:other" } }],
    ["owner-kind", { invocationReference: { ownerRuntimeKind: "worker" } }],
    ["user", { invocationReference: { ownerUserId: "usr_other" } }],
    ["generation", { childGenerationId: "fedcba9876543210fedcba9876543210" }],
    ["session", { sessionId: "other-session" }],
  ])("rejects a stolen/substituted route proof crossing %s", async (_label, mutation) => {
    const f = fixture();
    const original = invocation(f);
    const changed =
      "invocationReference" in mutation
        ? {
            ...original,
            invocationReference: {
              ...original.invocationReference,
              ...mutation.invocationReference,
            },
          }
        : { ...original, ...mutation };
    await expect(
      f.child.receiveInvocation(changed as AttachedHostInvocationEnvelope, [{ runId: "run-1" }])
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^EATTACHED_(?:BINDING|SESSION|SIGNATURE)$/u),
    });
  });

  it("does not let one host's stolen route key cross to another child host", async () => {
    const source = fixture();
    const otherHost = fixture({
      facts: { ...FACTS, childHostId: "host:other-child" },
    });
    await expect(
      otherHost.child.receiveInvocation(invocation(source), [{ runId: "run-1" }])
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^EATTACHED_(?:BINDING|SIGNATURE)$/u),
    });
  });

  it("rejects argument substitution and monotonically replayed envelopes", async () => {
    const f = fixture();
    const envelope = invocation(f);
    await expect(
      f.child.receiveInvocation(envelope, [{ runId: "substituted" }])
    ).rejects.toMatchObject({ code: "EATTACHED_ARGUMENTS" });
    await expect(f.child.receiveInvocation(envelope, [{ runId: "run-1" }])).resolves.toBeTruthy();
    await expect(f.child.receiveInvocation(envelope, [{ runId: "run-1" }])).rejects.toMatchObject({
      code: "EATTACHED_REPLAY",
    });
  });

  it("accepts valid concurrent delivery out of message-id order", async () => {
    const f = fixture();
    const first = invocation(f);
    const second = invocation(f);
    expect(BigInt(second.messageId)).toBeGreaterThan(BigInt(first.messageId));
    await expect(f.child.receiveInvocation(second, [{ runId: "run-1" }])).resolves.toBeTruthy();
    await expect(f.child.receiveInvocation(first, [{ runId: "run-1" }])).resolves.toBeTruthy();
  });

  it("rejects expired sessions and downgrade to an unknown direct route", async () => {
    const f = fixture();
    const old = invocation(f);
    f.advance(60_001);
    await expect(f.child.receiveInvocation(old, [{ runId: "run-1" }])).rejects.toMatchObject({
      code: "EATTACHED_EXPIRY",
    });
    await expect(
      f.child.receiveInvocation({ ...old, sessionId: "unattached-direct-address" }, [
        { runId: "run-1" },
      ])
    ).rejects.toMatchObject({ code: "EATTACHED_SESSION" });
    const fresh = fixture();
    await expect(
      fresh.child.receiveInvocation(
        {
          ...invocation(fresh),
          protocolVersion: 0,
        } as unknown as AttachedHostInvocationEnvelope,
        [{ runId: "run-1" }]
      )
    ).rejects.toMatchObject({ code: "EATTACHED_VERSION" });
  });

  it("rejects a parent-requested ceiling broader than child-local policy", () => {
    let now = 1_000;
    const parent = new AttachedHostEndpoint({
      role: "parent",
      store: new MemoryAttachedHostProtocolStore(),
      now: () => now,
      randomId: () => "session",
      localFacts: () => ({ facts: FACTS, authorityCeiling: CEILING }),
    });
    const child = new AttachedHostEndpoint({
      role: "child",
      store: new MemoryAttachedHostProtocolStore(),
      now: () => now,
      localFacts: () => ({
        facts: FACTS,
        authorityCeiling: [
          {
            capability: "service:eval.get",
            resource: { kind: "exact", key: "eval:run-1" },
          },
        ],
      }),
    });
    const hello = parent.beginParent({
      facts: FACTS,
      requestedAuthorityCeiling: CEILING,
      ttlMs: 10_000,
    });
    expect(() => child.acceptChild(hello)).toThrow(
      expect.objectContaining({ code: "EATTACHED_CEILING" })
    );
    now += 1;
  });

  it("binds one canonical approval decision and consumes it exactly once", () => {
    const f = fixture();
    const challenge = f.child.prepareApproval({
      sessionId: f.sessionId,
      nonce: "nonce-1",
      requestId: "request-approval-1",
      invocationSnapshot: approvalSnapshot(),
      capability: "workspace.file.write",
      resourceKey: "context:one/a.txt",
      tier: "gated",
      childDisplayText: "Totally harmless, click approve",
      ttlMs: 10_000,
    });
    const { presentation, shownPresentationDigest: shown } = f.parent.verifyChallenge(challenge);
    expect(presentation).toMatchObject({
      title: "Write a workspace file",
      capability: "workspace.file.write",
      resourceKey: "context:one/a.txt",
    });
    expect(JSON.stringify(presentation)).not.toContain("Totally harmless");
    const decision = f.parent.createDecision({
      challenge,
      shownPresentationDigest: shown,
      decision: "once",
      ttlMs: 10_000,
    });
    const mint = vi.fn();
    expect(
      f.child.consumeDecision({
        decision,
        evaluateLocally: () => true,
        mintLocalOnce: mint,
      })
    ).toBe("once");
    expect(mint).toHaveBeenCalledWith({ challenge, decision: "once" });
    expect(() =>
      f.child.consumeDecision({
        decision,
        evaluateLocally: () => true,
        mintLocalOnce: mint,
      })
    ).toThrow(expect.objectContaining({ code: "EATTACHED_REPLAY" }));
  });

  it("rejects decision substitution and dishonest parent presentation", () => {
    const f = fixture();
    const challenge = f.child.prepareApproval({
      sessionId: f.sessionId,
      nonce: "nonce-substitution",
      requestId: "request-approval-substitution",
      invocationSnapshot: approvalSnapshot({ method: "unresolved" }),
      capability: "workspace.file.write",
      resourceKey: "context:one/a.txt",
      tier: "gated",
      ttlMs: 10_000,
    });
    expect(() => f.parent.verifyChallenge(challenge)).toThrow(
      expect.objectContaining({ code: "EATTACHED_PRESENTATION" })
    );
    const validChallenge = f.child.prepareApproval({
      sessionId: f.sessionId,
      nonce: "nonce-valid",
      requestId: "request-approval-valid",
      invocationSnapshot: approvalSnapshot(),
      capability: "workspace.file.write",
      resourceKey: "context:one/a.txt",
      tier: "gated",
      ttlMs: 10_000,
    });
    const { shownPresentationDigest: shown } = f.parent.verifyChallenge(validChallenge);
    const decision = f.parent.createDecision({
      challenge: validChallenge,
      shownPresentationDigest: shown,
      decision: "once",
      ttlMs: 10_000,
    });
    expect(() =>
      f.child.consumeDecision({
        decision: { ...decision, invocationSnapshotDigest: "0".repeat(64) },
        evaluateLocally: () => true,
        mintLocalOnce: vi.fn(),
      })
    ).toThrow(expect.objectContaining({ code: "EATTACHED_SIGNATURE" }));
  });

  it("closes a pending approval on route loss without minting a grant", () => {
    const f = fixture();
    const challenge = f.child.prepareApproval({
      sessionId: f.sessionId,
      nonce: "nonce-route-loss",
      requestId: "request-approval-route-loss",
      invocationSnapshot: approvalSnapshot(),
      capability: "workspace.file.write",
      resourceKey: "context:one/a.txt",
      tier: "gated",
      ttlMs: 10_000,
    });
    const { shownPresentationDigest: shown } = f.parent.verifyChallenge(challenge);
    const decision = f.parent.createDecision({
      challenge,
      shownPresentationDigest: shown,
      decision: "once",
      ttlMs: 10_000,
    });
    f.child.close(f.sessionId, "route-lost");
    expect(f.childStore.getChallenge(f.sessionId, challenge.nonce)?.state).toBe("route-lost");
    const mint = vi.fn();
    expect(() =>
      f.child.consumeDecision({
        decision,
        evaluateLocally: () => true,
        mintLocalOnce: mint,
      })
    ).toThrow(expect.objectContaining({ code: "EATTACHED_SESSION" }));
    expect(mint).not.toHaveBeenCalled();
  });

  it("persists only public session material and binding digests", () => {
    const f = fixture();
    const json = JSON.stringify(f.parentStore.getSession(f.sessionId));
    expect(json).not.toMatch(
      /privateKey|adminToken|refreshToken|deviceSecret|databasePath|inspector|encryptionKey/iu
    );
    expect(json).toContain("parentRoutePublicKey");
    expect(json).toContain("authorityCeilingDigest");
  });
});
