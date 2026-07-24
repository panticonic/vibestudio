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
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import { CONTEXT_BOUNDARY_CAPABILITY, contextBoundaryResourceKey } from "./contextBoundary.js";
import { createPanelTreeService, type PanelTreeServiceDeps } from "./panelTreeService.js";
import type { ApprovalQueue } from "./approvalQueue.js";

type PanelTreeTestDeps = PanelTreeServiceDeps & {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
};

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-tree-"));
}

function readyPanelResult(id: string, title: string) {
  return {
    id,
    title,
    kind: "workspace" as const,
    observation: {
      panelId: id,
      title,
      source: "panels/target",
      kind: "workspace" as const,
      parentId: null,
      contextId: "ctx-caller",
      requestedRef: "main",
      runtimeEntityId: `panel:${id}`,
      attemptId: `attempt:${id}`,
      effectiveVersion: "ev-test",
      buildKey: "b".repeat(64),
      phase: "ready" as const,
      updatedAt: 1,
    },
  };
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

function ctx() {
  return {
    caller: createVerifiedCaller("panel:requester", "panel", {
      callerId: "panel:requester",
      callerKind: "panel",
      repoPath: "panels/requester",
      effectiveVersion: "v1",
      requested: [
        { capability: "service:panelTree.*", resource: { kind: "network", value: "*" } },
        { capability: "service:workspace-state.*", resource: { kind: "network", value: "*" } },
        { capability: "context.boundary", resource: { kind: "network", value: "*" } },
      ],
    }),
  };
}

async function dispatchPanelTree(
  service: ReturnType<typeof createPanelTreeService>,
  deps: PanelTreeTestDeps,
  context: ServiceContext,
  method: string,
  args: unknown[]
) {
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
    "panelTree",
    method,
    args
  );
}

function chromeAppCtx() {
  return {
    caller: createVerifiedCaller("@workspace-apps/shell", "app", {
      callerId: "@workspace-apps/shell",
      callerKind: "app",
      repoPath: "apps/shell",
      effectiveVersion: "v1",
      requested: [
        { capability: "service:panelTree.*", resource: { kind: "network", value: "*" } },
        { capability: "context.boundary", resource: { kind: "network", value: "*" } },
      ],
    }),
  };
}

/**
 * Context-boundary deps for the panel-tree gate. Defaults model the requester in
 * `ctx-caller`; any target enriched with a foreign `contextId` (or a foreign
 * `requestedContextId` for create/navigate) that already exists prompts once.
 */
function treeDeps(overrides: Partial<PanelTreeTestDeps> = {}): PanelTreeTestDeps {
  return {
    approvalQueue: approvalQueueMock("session"),
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
          effectiveVersion: "v1",
        })
    ),
    bridge: vi.fn(),
    ...overrides,
  };
}

describe("panelTreeService", () => {
  it("declares compositional authority for code, users, and the trusted host", () => {
    const service = createPanelTreeService(treeDeps({ approvalQueue: approvalQueueMock("deny") }));

    expect(service.authority).toEqual({ principals: ["code", "user", "host"] });
  });

  it("delegates open list operations without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => [{ panelId: "panel-1" }]);
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(service.handler(ctx(), "list", [null])).resolves.toEqual([{ panelId: "panel-1" }]);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "list",
      // Direct handler calls use the same wire normalization as dispatcher
      // calls: JSON null at a trailing optional position becomes undefined.
      args: [undefined],
    });
  });

  it("delegates root listing without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => [{ panelId: "root-1" }]);
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(service.handler(ctx(), "roots", [])).resolves.toEqual([{ panelId: "root-1" }]);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "roots",
      args: [],
    });
  });

  it("delegates ensureLoaded without rewriting it to focus", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => ({ loaded: true }));
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "ensureLoaded", ["target"])).resolves.toEqual({
      loaded: true,
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "ensureLoaded",
      args: ["target"],
    });
  });

  it("context-boundary gates structural operations before delegating", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-target" }
        : {
            panelId: "target",
            operation: "close",
            status: "closed",
            loaded: false,
            rebuilt: false,
            reloaded: false,
          }
    );
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "close", ["target"])
    ).resolves.toMatchObject({ panelId: "target", status: "closed" });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester"),
      })
    );
    // The actual mutation runs only AFTER the gate (metadata probe, then close).
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "close",
      args: ["target"],
    });
  });

  it("does not prompt when closing a panel in the caller's own context", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-caller" }
        : {
            panelId: "target",
            operation: "close",
            status: "archived",
            loaded: false,
            rebuilt: false,
            reloaded: false,
          }
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "close", ["target"])).resolves.toMatchObject({
      panelId: "target",
      status: "archived",
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "close",
      args: ["target"],
    });
  });

  it("does not prompt when authorized chrome closes a panel in another context", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? {
            id: "target",
            title: "Target",
            source: "panels/target",
            runtimeEntityId: "panel:target",
            contextId: "ctx-target",
          }
        : {
            panelId: "target",
            operation: "close",
            status: "archived",
            loaded: false,
            rebuilt: false,
            reloaded: false,
          }
    );
    const hasAppCapability = vi.fn(
      (_callerId: string, capability: string) => capability === "panel-hosting"
    );
    const deps = treeDeps({ approvalQueue, bridge, hasAppCapability });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, chromeAppCtx(), "archive", ["target"])
    ).resolves.toMatchObject({ panelId: "target", status: "archived" });

    expect(hasAppCapability).toHaveBeenCalledWith("@workspace-apps/shell", "panel-hosting");
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "@workspace-apps/shell",
      callerKind: "app",
      method: "archive",
      args: ["target"],
    });
  });

  it("remembers a context-boundary approval across repeated ops on the same target context", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-target" }
        : {
            panelId: "target",
            operation: "close",
            status: "closed",
            loaded: false,
            rebuilt: false,
            reloaded: false,
          }
    );
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await dispatchPanelTree(service, deps, ctx(), "close", ["target"]);
    await dispatchPanelTree(service, deps, ctx(), "close", ["target"]);

    // No double-prompt: the second close reuses the remembered grant.
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester"),
      })
    );
  });

  it("gates creating a panel into another existing context", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string; args: unknown[] }) =>
      request.method === "metadata"
        ? {
            id: request.args[0] as string,
            title: "Parent",
            source: "panels/parent",
            contextId: "ctx-caller",
          }
        : readyPanelResult("created", "Created")
    );
    const deps = treeDeps({
      approvalQueue,
      bridge,
      resolveCallerContext: vi.fn(async () => "ctx-caller"),
    });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "create", [
        "panels/child",
        { parentId: "parent", contextId: "ctx-foreign" },
      ])
    ).resolves.toMatchObject({ id: "created", title: "Created", kind: "workspace" });

    // Exactly one prompt for the single create call.
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-foreign", "panel:requester"),
      })
    );
    // Prepared host state is resolved once before acquisition and once again
    // at the handler boundary, then the mutation runs.
    expect(bridge).toHaveBeenCalledTimes(3);
    expect(bridge).toHaveBeenNthCalledWith(1, {
      callerId: "panel:requester",
      callerKind: "panel",
      method: "metadata",
      args: ["parent"],
    });
    expect(bridge).toHaveBeenNthCalledWith(2, {
      callerId: "panel:requester",
      callerKind: "panel",
      method: "metadata",
      args: ["parent"],
    });
    expect(bridge).toHaveBeenNthCalledWith(3, {
      callerId: "panel:requester",
      callerKind: "panel",
      method: "create",
      args: ["panels/child", { parentId: "parent", contextId: "ctx-foreign" }],
    });
  });

  it("does not prompt when creating a panel with no requested context (fresh)", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string; args: unknown[] }) =>
      request.method === "metadata"
        ? { id: request.args[0] as string, title: "Parent", source: "panels/parent" }
        : readyPanelResult("created", "Created")
    );
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(
      service.handler(ctx(), "create", ["panels/child", { parentId: "parent" }])
    ).resolves.toMatchObject({ id: "created", title: "Created", kind: "workspace" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("validates panel creation sources before approval or bridge mutation", async () => {
    const approvalQueue = approvalQueueMock("once");
    const validateOpenPanelSource = vi.fn(async () => {
      throw new Error("Unknown build unit: panels/missing");
    });
    const bridge = vi.fn();
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, validateOpenPanelSource, bridge })
    );

    await expect(
      service.handler(ctx(), "create", ["panels/missing", { parentId: "parent" }])
    ).rejects.toThrow("Unknown build unit: panels/missing");

    expect(validateOpenPanelSource).toHaveBeenCalledWith({
      method: "create",
      source: "panels/missing",
      options: { parentId: "parent" },
    });
    expect(validateOpenPanelSource).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("does not delegate panel creation when the context-boundary prompt is denied", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async (request: { method: string; args: unknown[] }) =>
      request.method === "metadata"
        ? {
            id: request.args[0] as string,
            title: "Parent",
            source: "panels/parent",
            contextId: "ctx-caller",
          }
        : readyPanelResult("created", "Created")
    );
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "create", [
        "panels/child",
        { parentId: "parent", contextId: "ctx-foreign" },
      ])
    ).rejects.toThrow(/denied/i);

    // The gate runs before bridge mutation: only the metadata probe ran.
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ method: "metadata", args: ["parent"] })
    );
  });

  it("does not prompt for implicit child panel creation in a fresh context", async () => {
    const approvalQueue = approvalQueueMock("once");
    const resolveRequesterPanel = vi.fn(async () => ({
      id: "requester-slot",
      title: "Requester Panel",
      source: "panels/requester",
      runtimeEntityId: "panel:requester",
    }));
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "create" ? readyPanelResult("created", "Created") : null
    );
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, resolveRequesterPanel, bridge })
    );

    await expect(service.handler(ctx(), "create", ["panels/child", {}])).resolves.toMatchObject({
      id: "created",
      title: "Created",
      kind: "workspace",
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "create",
      args: ["panels/child", {}],
    });
  });

  it("does not delegate structural operations when approval is denied", async () => {
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : undefined
    );
    const deps = treeDeps({ approvalQueue: approvalQueueMock("deny"), bridge });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "setStateArgs", ["target", { mode: "edit" }])
    ).rejects.toThrow(/denied/i);

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ method: "metadata", args: ["target"] })
    );
  });

  it("lets a panel set its own stateArgs without approval (same context)", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? {
            id: "requester-slot",
            title: "Requester",
            source: "panels/requester",
            runtimeEntityId: "panel:requester",
            contextId: "ctx-self",
          }
        : { mode: "edit" }
    );
    const service = createPanelTreeService(
      treeDeps({
        approvalQueue,
        bridge,
        resolveCallerContext: vi.fn(async () => "ctx-self"),
        resolveRequesterPanel: vi.fn(async () => ({
          id: "requester-slot",
          runtimeEntityId: "panel:requester",
        })),
      })
    );

    await expect(
      service.handler(ctx(), "setStateArgs", ["requester-slot", { mode: "edit" }])
    ).resolves.toEqual({ mode: "edit" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "setStateArgs",
      args: ["requester-slot", { mode: "edit" }],
    });
  });

  it("reserves contextId for panel lifecycle options instead of application state", async () => {
    const bridge = vi.fn();
    const service = createPanelTreeService(treeDeps({ bridge }));

    await expect(
      service.handler(ctx(), "setStateArgs", ["requester-slot", { contextId: "ctx-other" }])
    ).rejects.toThrow(/stateArgs\.contextId cannot select a workspace branch/);
    await expect(
      service.handler(ctx(), "create", [
        "panels/chat",
        { contextId: "ctx-other", stateArgs: { contextId: "ctx-other" } },
      ])
    ).rejects.toThrow(/stateArgs\.contextId cannot select a workspace branch/);
    await expect(
      service.handler(ctx(), "navigate", [
        "requester-slot",
        "panels/chat",
        { contextId: "ctx-other", stateArgs: { contextId: "ctx-other" } },
      ])
    ).rejects.toThrow(/stateArgs\.contextId cannot select a workspace branch/);

    expect(bridge).not.toHaveBeenCalled();
  });

  it("does not prompt when a panel navigates into a fresh context", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? {
            id: "requester-slot",
            title: "Requester",
            source: "panels/requester",
            runtimeEntityId: "panel:requester",
            contextId: "ctx-x",
          }
        : readyPanelResult("requester-slot", "Vault")
    );
    const service = createPanelTreeService(
      treeDeps({
        approvalQueue,
        bridge,
        // The destination context does not yet exist ⇒ fresh ⇒ free.
        contextExists: vi.fn(() => false),
        resolveCallerContext: vi.fn(async () => "ctx-x"),
      })
    );

    await expect(
      service.handler(ctx(), "navigate", [
        "requester-slot",
        "panels/spectrolite",
        { contextId: "ctx-vault", stateArgs: { repoRoot: "/repo" } },
      ])
    ).resolves.toMatchObject({ id: "requester-slot", title: "Vault" });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "navigate",
      args: [
        "requester-slot",
        "panels/spectrolite",
        { contextId: "ctx-vault", stateArgs: { repoRoot: "/repo" } },
      ],
    });
  });

  it("does not prompt when navigating a panel with no context change (no contextId)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" }
        : readyPanelResult("target", "Next")
    );
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, bridge, resolveCallerContext: vi.fn(async () => "ctx-x") })
    );

    await expect(
      service.handler(ctx(), "navigate", ["target", "panels/next", { stateArgs: { a: 1 } }])
    ).resolves.toMatchObject({ id: "target", title: "Next" });

    // No `contextId` in the navigate options ⇒ no context change ⇒ free, even
    // though the target currently lives in a (foreign, existing) context.
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "navigate",
      args: ["target", "panels/next", { stateArgs: { a: 1 } }],
    });
  });

  it("gates navigating a panel into another existing context (X→Y)", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" }
        : readyPanelResult("target", "Next")
    );
    const deps = treeDeps({
      approvalQueue,
      bridge,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-x"),
    });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "navigate", [
        "target",
        "panels/next",
        { contextId: "ctx-y" },
      ])
    ).resolves.toMatchObject({ id: "target", title: "Next" });

    // Exactly one prompt — keyed on the DESTINATION context (ctx-y), not ctx-x.
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-y", "panel:requester"),
        operation: expect.objectContaining({ verb: "Navigate panel in" }),
      })
    );
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "navigate",
      args: ["target", "panels/next", { contextId: "ctx-y" }],
    });
  });

  it("gates a history back/forward into another existing context", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) => {
      if (request.method === "metadata") {
        return { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" };
      }
      if (request.method === "historyTargetContext") return "ctx-y";
      return readyPanelResult("target", "Back");
    });
    const deps = treeDeps({
      approvalQueue,
      bridge,
      contextExists: vi.fn(() => true),
      resolveCallerContext: vi.fn(async () => "ctx-x"),
    });
    const service = createPanelTreeService(deps);

    await dispatchPanelTree(service, deps, ctx(), "navigateHistory", ["target", -1]);

    // Peeked the destination history-entry context and prompted once keyed on it.
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ method: "historyTargetContext", args: ["target", -1] })
    );
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-y", "panel:requester"),
      })
    );
  });

  it("does not prompt for a history move within the panel's own context", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) => {
      if (request.method === "metadata") {
        return { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" };
      }
      if (request.method === "historyTargetContext") return "ctx-x";
      return readyPanelResult("target", "Back");
    });
    const service = createPanelTreeService(
      treeDeps({
        approvalQueue,
        bridge,
        contextExists: vi.fn(() => true),
        resolveCallerContext: vi.fn(async () => "ctx-x"),
      })
    );

    await service.handler(ctx(), "navigateHistory", ["target", 1]);
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("validates navigation sources before approval or bridge mutation", async () => {
    const approvalQueue = approvalQueueMock("once");
    const validateOpenPanelSource = vi.fn(async () => {
      throw new Error("Unknown build unit: panels/missing");
    });
    const bridge = vi.fn();
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, validateOpenPanelSource, bridge })
    );

    await expect(
      service.handler(ctx(), "navigate", ["target", "panels/missing", { contextId: "ctx-missing" }])
    ).rejects.toThrow("Unknown build unit: panels/missing");

    expect(validateOpenPanelSource).toHaveBeenCalledWith({
      method: "navigate",
      source: "panels/missing",
      options: { contextId: "ctx-missing" },
      targetPanelId: "target",
    });
    expect(validateOpenPanelSource).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("gates object-shaped structural operations (movePanel) by target panel context", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : undefined
    );
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "movePanel", [
        { panelId: "target", newParentId: null, targetPosition: 0 },
      ])
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        operation: expect.objectContaining({ verb: "Move panel in" }),
      })
    );
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "movePanel",
      args: [{ panelId: "target", newParentId: null, targetPosition: 0 }],
    });
  });

  it("forwards operation-specific verbs for host control-plane operations", async () => {
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ bridge }));
    const cases = [
      ["takeOver", ["target"], "Take over panel in"],
      ["openDevTools", ["target", "detach"], "Open DevTools in"],
      ["rebuildPanel", ["target"], "Rebuild panel in"],
    ] as const;
    for (const [method, args, verb] of cases) {
      const prepare = service.authorityPreparation?.[`panelTree.${method}.contextBoundary`];
      await expect(prepare?.(ctx(), [...args])).resolves.toEqual([
        expect.objectContaining({
          capability: CONTEXT_BOUNDARY_CAPABILITY,
          challenge: expect.objectContaining({
            operation: expect.objectContaining({ verb }),
          }),
        }),
      ]);
    }
  });

  it("leaves read-only built-in agent introspection open", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => ({ ok: true }));
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(
      service.handler(ctx(), "callAgent", ["target", "_agent.tree", []])
    ).resolves.toEqual({
      ok: true,
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "callAgent",
      args: ["target", "_agent.tree", []],
    });
  });

  it("gates agent mode changes as a cross-context state change", async () => {
    const approvalQueue = approvalQueueMock("version");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : { mode: "fixture" }
    );
    const deps = treeDeps({ approvalQueue, bridge });
    const service = createPanelTreeService(deps);

    await expect(
      dispatchPanelTree(service, deps, ctx(), "callAgent", [
        "target",
        "_agent.setMode",
        ["fixture"],
      ])
    ).resolves.toEqual({
      mode: "fixture",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester"),
        operation: expect.objectContaining({ verb: "Change panel state in" }),
      })
    );
  });

  it("rejects arbitrary userland agent calls outside the built-in handle surface", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const service = createPanelTreeService(
      treeDeps({ approvalQueue: approvalQueueMock("session"), bridge })
    );

    await expect(
      service.handler(ctx(), "callAgent", ["target", "custom.method", []])
    ).rejects.toThrow("Unknown panel agent method: custom.method");

    expect(bridge).not.toHaveBeenCalled();
  });
});
