import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { createVerifiedCaller, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { AttachedHostEndpoint, digest } from "./attachedHostProtocol.js";
import { MemoryAttachedHostProtocolStore } from "./attachedHostSessionStore.js";
import { createAttachedHostChildEndpoint } from "./attachedHostRuntime.js";
import {
  AttachedHostAuthorityBridge,
  AttachedHostDecisionConsumer,
  attachedHostAwareAuthorityAcquirer,
} from "./attachedHostAuthorityBridge.js";
import { AttachedHostApprovalPresenter } from "./attachedHostApprovalPresenter.js";
import {
  CliAttachedHostBootstrapPort,
  HttpAttachedHostApprovalClient,
  HttpAttachedHostRoutePort,
  attachedHostHttpRoutes,
  attachedHostParentHttpRoutes,
} from "./attachedHostTransport.js";
import type { CliCredentials } from "../../cli/credentialStore.js";

const FACTS = {
  parentHostId: "host:parent",
  childHostId: "host:child",
  childGenerationId: "0123456789abcdef0123456789abcdef",
  developmentRunId: "development-run",
  initiatingRuntimeId: "agent:owner",
  initiatingRuntimeKind: "agent" as const,
  initiatingUserId: "usr_owner",
};
const CAPABILITY = "workspace.file.write";
const RESOURCE = "context:one/file.txt";
const CEILING = [
  {
    capability: CAPABILITY,
    resource: { kind: "exact" as const, key: RESOURCE },
  },
];
const methods = defineServiceMethods({
  write: {
    args: z.tuple([z.object({ value: z.string() }).strict()]),
    returns: z.object({ written: z.string() }).strict(),
    capability: CAPABILITY,
    tier: {
      tier: "gated",
      session: "family",
      rationale: "Attached-host transport test effect",
    },
    authority: {
      requirement: requirementForPrincipals(["user"], CAPABILITY),
      resource: { kind: "literal" as const, key: RESOURCE },
    },
    access: { sensitivity: "write" as const },
  },
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

async function fixture(queueDecision: "once" | "deny" | "reject" = "once") {
  const parentStore = new MemoryAttachedHostProtocolStore();
  const childStore = new MemoryAttachedHostProtocolStore();
  const grants: Array<Record<string, unknown>> = [];
  const effect = vi.fn(async (_ctx, [_input]: [{ value: string }]) => ({
    written: _input.value,
  }));
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller }) => {
    const baseline = testAuthority(caller, CAPABILITY, RESOURCE);
    return { ...baseline, grants: grants as never[] };
  });
  dispatcher.registerService({
    name: "files",
    description: "test files",
    authority: { principals: ["user"] },
    methods,
    handler: async (ctx, _method, args) => effect(ctx, args as [{ value: string }]),
  });
  const child = createAttachedHostChildEndpoint({
    store: childStore,
    dispatcher,
    localFacts: (_facts) => ({ facts: FACTS, authorityCeiling: CEILING }),
    resolveCaller: () =>
      createVerifiedCaller(FACTS.initiatingRuntimeId, "agent", null, null, {
        userId: FACTS.initiatingUserId,
        handle: "owner",
      }),
  });
  const parent = new AttachedHostEndpoint({
    role: "parent",
    store: parentStore,
    randomId: () => "attached-session",
    localFacts: () => ({ facts: FACTS, authorityCeiling: CEILING }),
    resolveApprovalPresentation: (challenge) => {
      if (
        challenge.invocationSnapshot.service !== "files" ||
        challenge.invocationSnapshot.method !== "write" ||
        challenge.capability !== CAPABILITY ||
        challenge.resourceKey !== RESOURCE
      ) {
        return null;
      }
      return {
        title: "Write one workspace file",
        action: "write the prepared workspace file",
        description: "Writes the exact prepared contents to the selected workspace file.",
        service: "files",
        method: "write",
        capability: CAPABILITY,
        resourceKey: RESOURCE,
        tier: challenge.tier,
        invocationSnapshotDigest: challenge.invocationSnapshotDigest,
        preparedOperationDigest: challenge.preparedOperationDigest,
      };
    },
  });
  const hello = parent.beginParent({
    facts: FACTS,
    requestedAuthorityCeiling: CEILING,
    ttlMs: 60_000,
  });
  const proof = parent.confirmParent(child.acceptChild(hello));
  child.finalizeChild(proof);

  const grantStore = {
    issue: vi.fn((input: Record<string, unknown>) => {
      const grant = {
        id: `grant-${grants.length + 1}`,
        ...input,
        createdAt: Date.now(),
      };
      grants.push(grant);
      return grant;
    }),
  };
  const consumer = new AttachedHostDecisionConsumer({
    endpoint: child,
    grantStore: grantStore as never,
    revalidate: (challenge) =>
      challenge.invocationSnapshot.capability === CAPABILITY &&
      challenge.invocationSnapshot.resourceKey === RESOURCE,
  });
  const queue = {
    request: vi.fn(async (_request: unknown) => {
      if (queueDecision === "reject") throw new Error("parent route lost");
      return queueDecision;
    }),
  };
  const presenter = new AttachedHostApprovalPresenter({
    endpoint: parent,
    approvalQueue: queue as never,
  });
  const parentRoutes = attachedHostParentHttpRoutes(parent, presenter);
  const parentServer = createServer((req, res) => {
    const suffix = new URL(req.url ?? "/", "http://localhost").pathname.split("/").at(-1);
    const route = parentRoutes.find((candidate) => candidate.path === `/${suffix}`);
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void route.handler(req, res, {});
  });
  servers.push(parentServer);
  await new Promise<void>((resolve) => parentServer.listen(0, "127.0.0.1", resolve));
  const parentAddress = parentServer.address() as AddressInfo;
  const approvalClient = new HttpAttachedHostApprovalClient({
    parentGatewayUrl: `http://127.0.0.1:${parentAddress.port}`,
    endpoint: child,
  });
  const attachedBridge = new AttachedHostAuthorityBridge({
    endpoint: child,
    decisionConsumer: consumer,
    present: (challenge, signal) => approvalClient.present(challenge, signal),
  });
  const ordinary = {
    request: vi.fn(() => {
      throw new Error("ordinary request path must not handle attached acquisition");
    }),
    acquire: vi.fn(async () => {
      throw new Error("ordinary acquire path must not handle attached acquisition");
    }),
    consume: vi.fn(() => true),
    invalidate: vi.fn(),
  };
  dispatcher.setAuthorityAcquirer(attachedHostAwareAuthorityAcquirer(ordinary, attachedBridge));
  dispatcher.markInitialized();

  const childRoutes = attachedHostHttpRoutes(child);
  const childServer = createServer((req, res) => {
    const suffix = new URL(req.url ?? "/", "http://localhost").pathname.split("/").at(-1);
    const route = childRoutes.find((candidate) => candidate.path === `/${suffix}`);
    if (!route) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void route.handler(req, res, {});
  });
  servers.push(childServer);
  await new Promise<void>((resolve) => childServer.listen(0, "127.0.0.1", resolve));
  const childAddress = childServer.address() as AddressInfo;
  const routePort = new HttpAttachedHostRoutePort({
    gatewayUrl: `http://127.0.0.1:${childAddress.port}`,
    childGenerationId: FACTS.childGenerationId,
    endpoint: parent,
  });
  const client = parent.createServiceClient(
    hello.sessionId,
    "files",
    methods,
    (envelope, args) => routePort.invoke(envelope, args),
    () => `request-${digest(Date.now())}`
  );
  return { client, queue, grantStore, grants, effect, parent, child };
}

describe("attached-host HTTP routed connectivity", () => {
  it("retires the ordinary bootstrap credential and rejects every later use", async () => {
    const parent = new AttachedHostEndpoint({
      role: "parent",
      store: new MemoryAttachedHostProtocolStore(),
      randomId: () => "bootstrap-session",
      localFacts: () => ({ facts: FACTS, authorityCeiling: CEILING }),
    });
    const child = new AttachedHostEndpoint({
      role: "child",
      store: new MemoryAttachedHostProtocolStore(),
      localFacts: () => ({ facts: FACTS, authorityCeiling: CEILING }),
    });
    const hello = parent.beginParent({
      facts: FACTS,
      requestedAuthorityCeiling: CEILING,
      ttlMs: 60_000,
    });
    let exists = true;
    const credentials = {
      deviceId: "device-bootstrap",
      refreshToken: "refresh-bootstrap",
    } as CliCredentials;
    const call = vi.fn(async (method: string, args: unknown[]) => {
      if (method === "attachedHosts.bootstrapExchange") {
        return child.acceptChild(args[0] as never);
      }
      if (method === "attachedHosts.bootstrapConfirm") {
        child.finalizeChild(args[0] as never);
        return { attachedHostSessionId: "bootstrap-session" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const revoke = vi.fn(async () => ({ revoked: true }));
    const port = new CliAttachedHostBootstrapPort(
      "/private/bootstrap.json",
      "http://127.0.0.1:4242",
      {
        load: () => credentials,
        createClient: () => ({ call, close }) as never,
        revoke: revoke as never,
        exists: () => exists,
        unlink: () => {
          exists = false;
        },
      }
    );
    const acceptance = await port.exchange(hello);
    await port.confirm(parent.confirmParent(acceptance));
    await port.revoke();
    await expect(port.verifyRevoked()).resolves.toBe(true);
    await expect(port.exchange(hello)).rejects.toMatchObject({
      code: "EATTACHED_BOOTSTRAP_REVOKED",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(credentials, "http://127.0.0.1:4242");
    expect(exists).toBe(false);
  });

  it("uses the canonical parent queue, child-local once grant, and ordinary typed client", async () => {
    const f = await fixture("once");
    await expect(f.client.write({ value: "hello" })).resolves.toEqual({ written: "hello" });
    expect(f.queue.request).toHaveBeenCalledOnce();
    const request = f.queue.request.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({
      title: "Write one workspace file",
      capability: CAPABILITY,
      allowedDecisions: ["once", "deny"],
    });
    expect(request).not.toHaveProperty("operationSubstance");
    expect(f.grantStore.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: "allow",
        capability: CAPABILITY,
        resource: { kind: "exact", key: RESOURCE },
        scope: "once",
      })
    );
    expect(f.effect).toHaveBeenCalledOnce();
  });

  it("does not execute or mint an allow grant after an explicit denial", async () => {
    const f = await fixture("deny");
    await expect(f.client.write({ value: "no" })).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(f.grants).toEqual([expect.objectContaining({ effect: "deny", scope: "once" })]);
    expect(f.effect).not.toHaveBeenCalled();
  });

  it("closes the parent route and mints no grant when approval routing is lost", async () => {
    const f = await fixture("reject");
    await expect(f.client.write({ value: "lost" })).rejects.toMatchObject({
      code: "EAPPROVALROUTELOST",
    });
    expect(f.grants).toEqual([]);
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.child.sessionRecord("attached-session")?.state).toBe("closed");
  });
});
