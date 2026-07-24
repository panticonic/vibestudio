import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import {
  createTestExecutionSession,
  testAuthority,
} from "@vibestudio/shared/serviceDispatcherTestUtils";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import { CONTEXT_BOUNDARY_CAPABILITY, contextBoundaryResourceKey } from "./contextBoundary.js";
import { createPanelCdpService, type PanelCdpServiceDeps } from "./panelCdpService.js";
import type { PanelAccessPermissionDeps } from "./panelAccessPermission.js";
import type { ApprovalQueue } from "./approvalQueue.js";

type AuthorityTestDeps = { approvalQueue: ApprovalQueue; grantStore: CapabilityGrantStore };
type PanelAccessTestDeps = PanelAccessPermissionDeps & AuthorityTestDeps;

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-cdp-"));
}

function approvalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    requestMissionReview: vi.fn(async () => ({
      decision: "dismiss" as const,
      decidedBy: "user:test" as const,
    })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
    resolveMissionReview: vi.fn(),
    requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
    resolveExternalAgent: vi.fn(),
    settleExternalAgent: vi.fn(() => 0),
    resolveExternalAgentByRequest: vi.fn(async () => 0),
    submitClientConfig: vi.fn(),
    submitSecretInput: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

function ctx(id = "panel:requester") {
  return {
    caller: createVerifiedCaller(id, "panel", {
      callerId: id,
      callerKind: "panel",
      repoPath: "panels/requester",
      effectiveVersion: "version-1",
      requested: [
        { capability: "panel.inspect", resource: { kind: "network", value: "*" } },
        { capability: "context.boundary", resource: { kind: "network", value: "*" } },
      ],
    }),
  };
}

function runtimeCtx(kind: "worker" | "do", id: string) {
  return {
    caller: createVerifiedCaller(id, kind, {
      callerId: id,
      callerKind: kind,
      repoPath: `workers/${id}`,
      effectiveVersion: "version-1",
      requested: [
        { capability: "panel.inspect", resource: { kind: "network", value: "*" } },
        { capability: "context.boundary", resource: { kind: "network", value: "*" } },
      ],
    }),
  };
}

/**
 * Context-boundary deps for the CDP gate. Defaults model the requester in
 * `ctx-caller`; a target carrying a foreign, already-existing `contextId`
 * prompts once with `context.boundary`. Same-context / context-less targets are
 * free.
 */
function accessFields(overrides: Partial<PanelAccessTestDeps> = {}): PanelAccessTestDeps {
  return {
    approvalQueue: approvalQueueMock("version"),
    grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    contextExists: vi.fn(() => true),
    resolveContextOwnerLabel: vi.fn(() => "owner"),
    resolveCallerContext: vi.fn(async () => "ctx-caller"),
    resolveEntityContext: vi.fn(() => "ctx-target"),
    resolveSubjectCaller: vi.fn(
      (id: string): VerifiedCaller =>
        createVerifiedCaller(id, "panel", {
          callerId: id,
          callerKind: "panel",
          repoPath: "panels/anchor",
          effectiveVersion: "version-1",
        })
    ),
    ...overrides,
  };
}

type CdpTestDeps = Partial<PanelAccessTestDeps> &
  Omit<PanelCdpServiceDeps, keyof PanelAccessPermissionDeps>;

/** Merge context-boundary defaults (overridable per test) with the CDP deps. */
type ResolvedCdpTestDeps = PanelCdpServiceDeps & AuthorityTestDeps;
const serviceDeps = new WeakMap<object, ResolvedCdpTestDeps>();
function cdpService(deps: CdpTestDeps) {
  const resolved = { ...accessFields(deps), ...deps } as ResolvedCdpTestDeps;
  const service = createPanelCdpService(resolved);
  serviceDeps.set(service, resolved);
  return service;
}

async function dispatchCdp(
  service: ReturnType<typeof createPanelCdpService>,
  context: ServiceContext,
  method: string,
  args: unknown[]
) {
  const deps = serviceDeps.get(service);
  if (!deps) throw new Error("Missing CDP test deps");
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) => {
    const resolved = testAuthority(caller, capability, resourceKey);
    return capability === CONTEXT_BOUNDARY_CAPABILITY
      ? {
          ...resolved,
          grants: deps.grantStore.grantsForSubjects(
            [resolved.context.authorizingOrigin.principal],
            capability
          ),
        }
      : resolved;
  });
  const acquisition = new AcquisitionCoordinator({
    approvalQueue: deps.approvalQueue,
    grantStore: deps.grantStore,
  });
  dispatcher.setAuthorityAcquirer({
    request: (input) => acquisition.request(input),
    acquire: (input) => acquisition.requestAndWait(input),
    consume: (grantId) => acquisition.consume(grantId),
    invalidate: (snapshotDigest, ownerRuntimeId, callerPrincipal) =>
      acquisition.invalidate(snapshotDigest, ownerRuntimeId, callerPrincipal),
  });
  dispatcher.registerService(service);
  dispatcher.markInitialized();
  return dispatcher.dispatch(
    { ...context, authorityAcquisition: "wait" },
    "panelCdp",
    method,
    args
  );
}

describe("panelCdpService", () => {
  it("gates endpoint minting on a cross-context target", async () => {
    const approvalQueue = approvalQueueMock("version");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(dispatchCdp(service, ctx(), "getCdpEndpoint", ["target"])).resolves.toEqual(
      endpoint
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        operation: expect.objectContaining({ verb: "Automate panel in" }),
      })
    );
    expect(getEndpoint).toHaveBeenCalledWith("target", "panel:requester");
  });

  it("does not prompt for a CDP target in the caller's own context", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = cdpService({
      approvalQueue,
      resolveCallerContext: vi.fn(async () => "ctx-same"),
      getTarget: () => ({ id: "target", title: "Target", kind: "browser", contextId: "ctx-same" }),
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["target"])).resolves.toEqual(endpoint);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(getEndpoint).toHaveBeenCalledWith("target", "panel:requester");
  });

  it("remembers cross-context CDP access per (target context, requester)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await dispatchCdp(service, ctx("panel:requester-one"), "getCdpEndpoint", ["target"]);
    await dispatchCdp(service, ctx("panel:requester-one"), "getCdpEndpoint", ["target"]);
    await dispatchCdp(service, ctx("panel:requester-two"), "getCdpEndpoint", ["target"]);

    expect(getEndpoint).toHaveBeenCalledTimes(3);
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester-one"),
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester-two"),
      })
    );
  });

  it("checks approval before transparent endpoint loading work", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = cdpService({
      approvalQueue: approvalQueueMock("deny"),
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(dispatchCdp(service, ctx(), "getCdpEndpoint", ["target"])).rejects.toThrow(
      /denied/i
    );

    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("does not mint an endpoint when the cross-context prompt is denied", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" }));
    const service = cdpService({
      approvalQueue: approvalQueueMock("deny"),
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(dispatchCdp(service, ctx(), "getCdpEndpoint", ["target"])).rejects.toThrow(
      /denied/i
    );
    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it("does not treat non-panel runtime ids as CDP targets", async () => {
    const getEndpoint = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/worker", token: "t" }));
    const service = cdpService({
      approvalQueue: approvalQueueMock("version"),
      getTarget: (panelId) =>
        panelId.startsWith("worker:") || panelId.startsWith("do:") ? null : { id: panelId },
      getEndpoint,
    });

    await expect(service.handler(ctx(), "getCdpEndpoint", ["worker:agent"])).rejects.toThrow(
      "Panel not found: worker:agent"
    );
    await expect(service.handler(ctx(), "getCdpEndpoint", ["do:Store:key"])).rejects.toThrow(
      "Panel not found: do:Store:key"
    );

    expect(getEndpoint).not.toHaveBeenCalled();
  });

  it.each([["worker", "worker:agent"] as const, ["do", "do:Store:key"] as const])(
    "allows %s callers to request CDP for cross-context panel targets",
    async (kind, callerId) => {
      const approvalQueue = approvalQueueMock("version");
      const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
      const getEndpoint = vi.fn(async () => endpoint);
      const service = cdpService({
        approvalQueue,
        getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
        getEndpoint,
      });

      await expect(
        dispatchCdp(service, runtimeCtx(kind, callerId), "getCdpEndpoint", ["target"])
      ).resolves.toEqual(endpoint);

      expect(approvalQueue.request).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: CONTEXT_BOUNDARY_CAPABILITY,
          grantResourceKey: contextBoundaryResourceKey("ctx-target", callerId),
        })
      );
      expect(getEndpoint).toHaveBeenCalledWith("target", callerId);
    }
  );

  it("uses severe severity for privileged cross-context targets", async () => {
    const approvalQueue = approvalQueueMock("once");
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "shell",
        title: "Shell",
        privileged: true,
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/shell", token: "t" })),
    });

    const caller = createVerifiedCaller(
      "agent:privileged",
      "agent",
      null,
      { entityId: "privileged", contextId: "ctx-caller", channelId: "chan" },
      null,
      createTestExecutionSession({
        runtimeId: "agent:privileged",
        contextId: "ctx-caller",
        agentBinding: {
          entityId: "privileged",
          channelId: "chan",
          bindingId: "privileged",
        },
      })
    );
    await dispatchCdp(service, { caller }, "getCdpEndpoint", ["shell"]);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        severity: "severe",
      })
    );
  });

  it("gates drive verbs with the context-boundary capability", async () => {
    const approvalQueue = approvalQueueMock("version");
    const drive = vi.fn(async () => undefined);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      dispatchCdp(service, ctx(), "navigate", ["target", "https://example.com"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(drive).toHaveBeenCalledWith("target", "panel:requester", "navigate", [
      "https://example.com",
    ]);
  });

  it("allows panel caller drive verbs against cross-context workspace panels with approval", async () => {
    const approvalQueue = approvalQueueMock("version");
    const drive = vi.fn(async () => undefined);
    const logAccess = vi.fn();
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "chat-panel",
        title: "Chat",
        source: "panels/chat",
        kind: "workspace",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
      logAccess,
    });

    await expect(
      dispatchCdp(service, ctx(), "navigate", ["chat-panel", "https://example.com"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(drive).toHaveBeenCalledWith("chat-panel", "panel:requester", "navigate", [
      "https://example.com",
    ]);
    expect(logAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "navigate",
        requesterId: "panel:requester",
        requesterKind: "panel",
        targetId: "chat-panel",
        targetKind: "workspace",
        targetSource: "panels/chat",
      })
    );
  });

  it("allows panel caller raw CDP endpoints against cross-context workspace panels with approval", async () => {
    const approvalQueue = approvalQueueMock("version");
    const endpoint = { wsEndpoint: "ws://server/cdp/chat", token: "t" };
    const getEndpoint = vi.fn(async () => endpoint);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "chat-panel",
        title: "Chat",
        source: "panels/chat",
        kind: "workspace",
        contextId: "ctx-target",
      }),
      getEndpoint,
    });

    await expect(dispatchCdp(service, ctx(), "getCdpEndpoint", ["chat-panel"])).resolves.toEqual(
      endpoint
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(getEndpoint).toHaveBeenCalledWith("chat-panel", "panel:requester");
  });

  it("allows non-panel callers to drive same-context workspace panels without prompting", async () => {
    const approvalQueue = approvalQueueMock("version");
    const drive = vi.fn(async () => undefined);
    const service = cdpService({
      approvalQueue,
      // No contextId on the target ⇒ no context change ⇒ free.
      getTarget: () => ({ id: "target", title: "Target", kind: "workspace" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(runtimeCtx("worker", "worker:agent"), "reload", ["target"])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(drive).toHaveBeenCalledWith("target", "worker:agent", "reload", []);
  });

  it("gates historical console access with the context-boundary capability", async () => {
    const approvalQueue = approvalQueueMock("version");
    const consoleHistory = vi.fn(async () => ({
      entries: [
        {
          timestamp: 1,
          level: "info" as const,
          message: "loaded",
          line: 1,
          sourceId: "app.tsx",
          url: "https://example.com",
        },
      ],
      errors: [],
      dropped: { entries: 0, errors: 0 },
      capacity: { entries: 1000, errors: 500 },
    }));
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      consoleHistory,
    });

    await expect(
      dispatchCdp(service, ctx(), "consoleHistory", ["target", { limit: 20, errorLimit: 20 }])
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: "loaded" })],
      capacity: { entries: 1000, errors: 500 },
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(consoleHistory).toHaveBeenCalledWith("target", "panel:requester", {
      limit: 20,
      errorLimit: 20,
    });
  });

  it("does not read console history when approval is denied", async () => {
    const consoleHistory = vi.fn();
    const service = cdpService({
      approvalQueue: approvalQueueMock("deny"),
      getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      consoleHistory,
    });

    await expect(dispatchCdp(service, ctx(), "consoleHistory", ["target"])).rejects.toThrow(
      /denied/i
    );
    expect(consoleHistory).not.toHaveBeenCalled();
  });

  it("rejects non-http navigation before prompting or driving", async () => {
    const approvalQueue = approvalQueueMock("version");
    const drive = vi.fn(async () => undefined);
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({ id: "target", title: "Target", contextId: "ctx-target" }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      drive,
    });

    await expect(
      service.handler(ctx(), "navigate", ["target", "file:///etc/passwd"])
    ).rejects.toThrow("Invalid URL");

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(drive).not.toHaveBeenCalled();
  });

  it("captures a screenshot through deps.screenshot with the cdp gate", async () => {
    const approvalQueue = approvalQueueMock("version");
    const shot = { data: "aGk=", mimeType: "image/png" as const, width: 800, height: 600 };
    const screenshot = vi.fn(async () => shot);
    const recordContextIngestion = vi.fn();
    const service = cdpService({
      approvalQueue,
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "browser",
        source: "browser:https://docs.example.com/guide",
        contextId: "ctx-target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target" })),
      screenshot,
      recordContextIngestion,
    });

    await expect(
      dispatchCdp(service, ctx(), "screenshot", ["target", { format: "png" }])
    ).resolves.toEqual(shot);
    // Cross-context ⇒ the same context-boundary prompt as raw CDP access.
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(screenshot).toHaveBeenCalledWith("target", "panel:requester", { format: "png" });
    expect(recordContextIngestion).toHaveBeenCalledWith(expect.anything(), {
      key: "web:docs.example.com",
      via: "panel-cdp:screenshot",
      classification: "external",
    });
    expect(screenshot.mock.invocationCallOrder[0]).toBeLessThan(
      recordContextIngestion.mock.invocationCallOrder[0]!
    );
  });

  it("agent callers screenshot same-context panels freely via their credential binding", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const shot = { data: "aGk=", mimeType: "image/png" as const, width: 1, height: 1 };
    const screenshot = vi.fn(async () => shot);
    const service = cdpService({
      approvalQueue,
      // resolveCallerContext must NOT be consulted for agent callers — return a
      // mismatching context to prove the binding wins.
      resolveCallerContext: vi.fn(async () => "ctx-elsewhere"),
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "workspace",
        contextId: "ctx-agent",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target" })),
      screenshot,
    });
    const agentCaller = createVerifiedCaller("agent:ent-1", "agent", null, {
      entityId: "ent-1",
      contextId: "ctx-agent",
      channelId: "chan-1",
      agentId: "agt_1",
    });

    await expect(
      service.handler({ caller: agentCaller }, "screenshot", ["target", undefined])
    ).resolves.toEqual(shot);
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("lets a session-bound agent acquire cross-context panel access without anchor substitution", async () => {
    const approvalQueue = approvalQueueMock("once");
    const screenshot = vi.fn(async () => ({
      data: "aGk=",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
    }));
    const service = cdpService({
      approvalQueue,
      // If the agent wrongly fell into the anchor branch, the target panel's
      // own entity would become the subject and access would be free — the
      // deny below proves the agent is judged as its own subject.
      resolveSubjectCaller: vi.fn(() => {
        throw new Error("agent callers must not resolve an anchor subject");
      }),
      getTarget: () => ({
        id: "target",
        title: "Target",
        kind: "workspace",
        contextId: "ctx-foreign",
        runtimeEntityId: "panel:target",
      }),
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target" })),
      screenshot,
    });
    const agentCaller = createVerifiedCaller(
      "agent:ent-1",
      "agent",
      null,
      {
        entityId: "ent-1",
        contextId: "ctx-agent",
        channelId: "chan-1",
        agentId: "agt_1",
      },
      null,
      createTestExecutionSession({
        runtimeId: "agent:ent-1",
        contextId: "ctx-agent",
        agentBinding: {
          entityId: "ent-1",
          channelId: "chan-1",
          bindingId: "agt_1",
        },
      })
    );

    await expect(
      dispatchCdp(service, { caller: agentCaller }, "screenshot", ["target", undefined])
    ).resolves.toEqual({ data: "aGk=", mimeType: "image/png", width: 1, height: 1 });
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({ capability: CONTEXT_BOUNDARY_CAPABILITY })
    );
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it("bypasses approval for shell callers", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const endpoint = { wsEndpoint: "ws://server/cdp/target", token: "t" };
    const service = cdpService({
      approvalQueue,
      // A host-mediated `shell` call with no resolvable anchor entity ⇒ free.
      resolveSubjectCaller: vi.fn(() => null),
      getTarget: () => ({ id: "target", title: "Target" }),
      getEndpoint: vi.fn(async () => endpoint),
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getCdpEndpoint", [
        "target",
      ])
    ).resolves.toEqual(endpoint);
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("routes internal host-provider transport without panel target approval", async () => {
    const response = new Response("stream");
    const hostProvider = {
      open: vi.fn(() => response),
      send: vi.fn(),
      close: vi.fn(),
    };
    const getTarget = vi.fn(() => {
      throw new Error("host-provider transport should not resolve panel targets");
    });
    const service = cdpService({
      getTarget,
      getEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/target", token: "t" })),
      hostProvider,
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "hostProvider.open", [
        "provider-session",
        "desktop-host",
      ])
    ).resolves.toBe(response);
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "hostProvider.send", [
        "provider-session",
        "{}",
      ])
    ).resolves.toBeUndefined();
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "hostProvider.close", [
        "provider-session",
      ])
    ).resolves.toBeUndefined();

    expect(hostProvider.open).toHaveBeenCalledWith("provider-session", "desktop-host", {
      id: "shell",
      kind: "shell",
    });
    expect(hostProvider.send).toHaveBeenCalledWith("provider-session", "{}", {
      id: "shell",
      kind: "shell",
    });
    expect(hostProvider.close).toHaveBeenCalledWith("provider-session", {
      id: "shell",
      kind: "shell",
    });
    expect(getTarget).not.toHaveBeenCalled();
    expect(service.methods["hostProvider.open"]?.authority).toEqual({
      principals: ["user", "host"],
    });
    expect(service.methods["hostProvider.send"]?.authority).toEqual({
      principals: ["user", "host"],
    });
    expect(service.methods["hostProvider.close"]?.authority).toEqual({
      principals: ["user", "host"],
    });
  });
});
