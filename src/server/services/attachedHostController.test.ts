import { describe, expect, it, vi } from "vitest";
import type { InvocationSnapshot } from "@vibestudio/rpc";
import type { DevelopmentInstance } from "@vibestudio/service-schemas/development";
import { evalMethods } from "@vibestudio/service-schemas/eval";
import {
  AttachedHostController,
  type AttachedHostBootstrapPort,
  type AttachedHostPublicationInput,
  type AttachedHostRoutePort,
} from "./attachedHostController.js";
import { AttachedHostEndpoint, type AttachedHostSessionFacts } from "./attachedHostProtocol.js";
import { MemoryAttachedHostProtocolStore } from "./attachedHostSessionStore.js";

const INSTANCE: DevelopmentInstance = {
  instanceId: "development-one",
  generationId: "0123456789abcdef0123456789abcdef",
  lifecycle: "ephemeral",
  state: "ready",
  executionDigest: "a".repeat(64),
  serverBuildId: "b".repeat(64),
  serverId: "server-child",
  serverBootId: "boot-child",
  workspaceId: "workspace-child",
  workspaceName: "development",
  gatewayUrl: "http://127.0.0.1:3210",
  registeredAt: 1,
  readyAt: 2,
  stoppedAt: null,
};
const RUN: AttachedHostPublicationInput["run"] = {
  runId: "run-one",
  ownerRuntimeId: "agent:one",
  ownerRuntimeKind: "agent",
  ownerUserId: "usr_one",
  target: { kind: "isolated-host", includeClient: false },
  instance: INSTANCE,
};
const CEILING = [
  {
    capability: "service:eval.*",
    resource: { kind: "prefix" as const, prefix: "eval:" },
  },
];

function fixture() {
  let facts: AttachedHostSessionFacts | null = null;
  let exchangedHello: Parameters<AttachedHostBootstrapPort["exchange"]>[0] | null = null;
  let revoked = false;
  const parent = new AttachedHostEndpoint({
    role: "parent",
    store: new MemoryAttachedHostProtocolStore(),
    randomId: () => "attached-session",
    localFacts: (input) => {
      facts = input;
      return { facts: input, authorityCeiling: CEILING };
    },
    resolveApprovalPresentation: (challenge) => ({
      title: "Canonical attached operation",
      action: "perform the attached operation",
      description: "Derived by the receiving host.",
      service: challenge.invocationSnapshot.service,
      method: challenge.invocationSnapshot.method,
      capability: challenge.capability,
      resourceKey: challenge.resourceKey,
      tier: challenge.tier,
      invocationSnapshotDigest: challenge.invocationSnapshotDigest,
      preparedOperationDigest: challenge.preparedOperationDigest,
    }),
  });
  const child = new AttachedHostEndpoint({
    role: "child",
    store: new MemoryAttachedHostProtocolStore(),
    localFacts: (input) => ({ facts: input, authorityCeiling: CEILING }),
    requiredAuthority: (service, method) => [
      {
        capability: `service:${service}.${method}`,
        resource: { kind: "exact", key: "eval:run-one" },
      },
    ],
    dispatch: async ({ service, method }) => {
      expect(service).toBe("eval");
      expect(method).toBe("get");
      return { status: "running" };
    },
  });
  const bootstrap: AttachedHostBootstrapPort = {
    async exchange(hello) {
      if (revoked) throw Object.assign(new Error("bootstrap revoked"), { code: "EREVOKED" });
      exchangedHello = hello;
      return child.acceptChild(hello);
    },
    async confirm(proof) {
      if (revoked) throw Object.assign(new Error("bootstrap revoked"), { code: "EREVOKED" });
      child.finalizeChild(proof);
    },
    async revoke() {
      revoked = true;
    },
    async verifyRevoked() {
      return revoked;
    },
  };
  const route: AttachedHostRoutePort = {
    invoke: (envelope, args) => child.receiveInvocation(envelope, args),
    close: vi.fn(async (reason) => {
      child.close("attached-session", reason);
    }),
    recover: vi.fn(async ({ childGenerationId }) =>
      childGenerationId === INSTANCE.generationId ? "recovered" : "generation-lost"
    ),
  };
  const routeLost = vi.fn();
  const controller = new AttachedHostController(parent, routeLost);
  return {
    parent,
    child,
    bootstrap,
    route,
    controller,
    routeLost,
    getFacts: () => facts,
    getExchangedHello: () => exchangedHello,
  };
}

function approvalSnapshot(index: number): InvocationSnapshot {
  return {
    v: 1,
    service: "files",
    method: "write",
    capability: "workspace.file.write",
    resourceKey: `context:one/file-${index}.txt`,
    argsDigest: "a".repeat(64),
    preparedStateDigest: "b".repeat(64),
    callerPrincipal: "session:attached-owner",
    sessionId: "attached-authority-session",
    mission: "-",
    snippetDigest: "c".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    contextLineage: null,
    initiatorChain: [RUN.ownerRuntimeId],
    at: index,
  };
}

async function recordDecision(
  f: ReturnType<typeof fixture>,
  index: number,
  decision: "once" | "deny" = "once"
) {
  const challenge = f.child.prepareApproval({
    sessionId: "attached-session",
    nonce: `approval-${index}`,
    requestId: `request-${index}`,
    invocationSnapshot: approvalSnapshot(index),
    capability: "workspace.file.write",
    resourceKey: `context:one/file-${index}.txt`,
    tier: "gated",
    ttlMs: 10_000,
  });
  const { shownPresentationDigest } = f.parent.verifyChallenge(challenge);
  f.parent.createDecision({
    challenge,
    shownPresentationDigest,
    decision,
    ttlMs: 10_000,
  });
  return { challenge, shownPresentationDigest };
}

describe("AttachedHostController", () => {
  it("publishes only after exact-generation handshake and bootstrap revocation", async () => {
    const f = fixture();
    const published = await f.controller.attach({
      run: RUN,
      instance: INSTANCE,
      parentHostId: "server-parent",
      authorityCeiling: CEILING,
      bootstrap: f.bootstrap,
      route: f.route,
    });
    expect(published).toMatchObject({
      attachedHostSessionId: "attached-session",
      childGenerationId: INSTANCE.generationId,
    });
    expect(f.getFacts()).toMatchObject({
      developmentRunId: RUN.runId,
      initiatingRuntimeId: RUN.ownerRuntimeId,
      initiatingRuntimeKind: RUN.ownerRuntimeKind,
      initiatingUserId: RUN.ownerUserId,
      childGenerationId: INSTANCE.generationId,
    });
    await expect(f.bootstrap.exchange(f.getExchangedHello()!)).rejects.toMatchObject({
      code: "EREVOKED",
    });

    const evalClient = f.controller.client("attached-session", "eval", evalMethods);
    await expect(evalClient.get({ target: { kind: "caller" }, runId: "run-one" })).resolves.toEqual(
      { status: "running" }
    );
    expect(
      f.controller.attachClient("attached-session", {
        runtimeId: RUN.ownerRuntimeId,
        runtimeKind: RUN.ownerRuntimeKind,
        userId: RUN.ownerUserId,
      })
    ).toMatchObject({
      sessionId: "attached-session",
      developmentRunId: RUN.runId,
      childGenerationId: INSTANCE.generationId,
    });
    await expect(
      f.controller.invokeAttached(
        "attached-session",
        {
          runtimeId: RUN.ownerRuntimeId,
          runtimeKind: RUN.ownerRuntimeKind,
          userId: RUN.ownerUserId,
        },
        "eval",
        "get",
        [{ target: { kind: "caller" }, runId: "run-one" }]
      )
    ).resolves.toEqual({ status: "running" });
    expect(() =>
      f.controller.attachClient("attached-session", {
        runtimeId: "agent:foreign",
        runtimeKind: "agent",
        userId: RUN.ownerUserId,
      })
    ).toThrow(expect.objectContaining({ code: "EATTACHED_OWNER" }));
  });

  it("refuses a foreign instance generation before using bootstrap", async () => {
    const f = fixture();
    const exchange = vi.spyOn(f.bootstrap, "exchange");
    await expect(
      f.controller.attach({
        run: RUN,
        instance: { ...INSTANCE, generationId: "fedcba9876543210fedcba9876543210" },
        parentHostId: "server-parent",
        authorityCeiling: CEILING,
        bootstrap: f.bootstrap,
        route: f.route,
      })
    ).rejects.toMatchObject({ code: "EATTACHED_GENERATION" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("closes instead of recovering when generation proof drifts", async () => {
    const f = fixture();
    await f.controller.attach({
      run: RUN,
      instance: INSTANCE,
      parentHostId: "server-parent",
      authorityCeiling: CEILING,
      bootstrap: f.bootstrap,
      route: f.route,
    });
    await expect(
      f.controller.recover("attached-session", "fedcba9876543210fedcba9876543210")
    ).resolves.toBe("generation-lost");
    expect(f.route.close).toHaveBeenCalledWith("generation-lost");
  });

  it("surfaces route loss with exact run/session/generation provenance", async () => {
    const f = fixture();
    await f.controller.attach({
      run: RUN,
      instance: INSTANCE,
      parentHostId: "server-parent",
      authorityCeiling: CEILING,
      bootstrap: f.bootstrap,
      route: f.route,
    });
    await f.controller.close("attached-session", "route-lost");
    expect(f.routeLost).toHaveBeenCalledWith({
      sessionId: "attached-session",
      developmentRunId: RUN.runId,
      childGenerationId: INSTANCE.generationId,
    });
  });

  it("returns only owner-scoped canonical terminal decision receipts in stable pages", async () => {
    const f = fixture();
    await f.controller.attach({
      run: RUN,
      instance: INSTANCE,
      parentHostId: "server-parent",
      authorityCeiling: CEILING,
      bootstrap: f.bootstrap,
      route: f.route,
    });
    const owner = {
      runtimeId: RUN.ownerRuntimeId,
      runtimeKind: RUN.ownerRuntimeKind,
      userId: RUN.ownerUserId,
    } as const;
    expect(f.controller.listApprovalAudit("attached-session", owner, { limit: 1 })).toEqual({
      events: [],
      nextCursor: null,
    });

    const first = await recordDecision(f, 1);
    await recordDecision(f, 2, "deny");
    const pageOne = f.controller.listApprovalAudit("attached-session", owner, { limit: 1 });
    expect(pageOne).toMatchObject({
      events: [
        {
          sessionId: "attached-session",
          developmentRunId: RUN.runId,
          childGenerationId: INSTANCE.generationId,
          requestId: "request-1",
          service: "files",
          method: "write",
          invocationSnapshotDigest: first.challenge.invocationSnapshotDigest,
          preparedOperationDigest: first.challenge.preparedOperationDigest,
          shownPresentationDigest: first.shownPresentationDigest,
          decision: "once",
        },
      ],
    });
    expect(pageOne.events[0]).not.toHaveProperty("arguments");
    expect(pageOne.events[0]).not.toHaveProperty("signature");
    expect(pageOne.nextCursor).toBe(pageOne.events[0]?.cursor);

    const pageTwo = f.controller.listApprovalAudit("attached-session", owner, {
      after: pageOne.nextCursor!,
      limit: 1,
    });
    expect(pageTwo).toMatchObject({
      events: [expect.objectContaining({ requestId: "request-2", decision: "deny" })],
      nextCursor: null,
    });
    expect(() =>
      f.controller.listApprovalAudit(
        "attached-session",
        {
          ...owner,
          runtimeId: "agent:foreign",
        },
        {}
      )
    ).toThrow(expect.objectContaining({ code: "EATTACHED_OWNER" }));
  });
});
