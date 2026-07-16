import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createVerifiedCaller,
  ServiceAccessError,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { CONTEXT_BOUNDARY_CAPABILITY, contextBoundaryResourceKey } from "./contextBoundary.js";
import {
  createPanelTreeService as createRawPanelTreeService,
  type PanelTreeServiceDeps,
} from "./panelTreeService.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import {
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";
import { withTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";

type PanelTreeTestDeps = PanelTreeServiceDeps & CapabilityPermissionDeps;
let currentAuthorityDeps: PanelTreeTestDeps | null = null;

const createPanelTreeService = (deps: PanelTreeServiceDeps) =>
  withTestServiceDispatcher(createRawPanelTreeService(deps));

function withCanonicalAuthority(ctx: ServiceContext, panelHosting = false): ServiceContext {
  ctx.authorityDecisions = new Map();
  ctx.authority = {
    allows: vi.fn(async ({ capability }) => capability === "panel-hosting" && panelHosting),
    assert: vi.fn(async (input) => {
      if (!currentAuthorityDeps || !input.challenge || input.acquisition?.kind !== "approval") {
        throw new Error("test canonical authority adapter is not configured");
      }
      const permission = await requestCapabilityPermission(currentAuthorityDeps, {
        caller: input.authorizingCaller ?? ctx.caller,
        capability: input.capability,
        resource: { ...input.challenge.resource, key: input.resourceKey },
        operation: input.challenge.operation,
        title: input.challenge.title,
        description: input.challenge.description,
        severity: input.challenge.severity,
        deniedReason: input.challenge.deniedReason,
        dedupKey: input.challenge.dedupKey,
        details: input.challenge.details ? [...input.challenge.details] : undefined,
        signal: input.challenge.signal,
        allowedDecisions: ["once", ...input.acquisition.grantScopes, "deny", "dismiss"],
      });
      if (!permission.allowed) {
        throw new ServiceAccessError("panelTree", "operation", permission.reason, "EACCES");
      }
      if (permission.decision) {
        ctx.authorityDecisions!.set(input.capability, permission.decision);
      }
    }),
  };
  return ctx;
}

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-tree-"));
}

function approvalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestCapability: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
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
  return withCanonicalAuthority({
    caller: createVerifiedCaller("panel:requester", "panel", {
      callerId: "panel:requester",
      callerKind: "panel",
      repoPath: "panels/requester",
      executionDigest: "a".repeat(64),
      delegations: [],
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    }),
  });
}

function panelHostCtx() {
  return withCanonicalAuthority(
    {
      caller: createVerifiedCaller("@workspace-apps/shell", "app", {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        executionDigest: "a".repeat(64),
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    },
    true
  );
}

/**
 * Context-boundary deps for the panel-tree gate. Defaults model the requester in
 * `ctx-caller`; any target enriched with a foreign `contextId` (or a foreign
 * `requestedContextId` for create/navigate) that already exists prompts once.
 */
function treeDeps(overrides: Partial<PanelTreeTestDeps> = {}): PanelTreeTestDeps {
  const deps = {
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
          executionDigest: "a".repeat(64),
          delegations: [],
          requested: [
            { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
            { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
          ],
        })
    ),
    bridge: vi.fn(),
    ...overrides,
  };
  currentAuthorityDeps = deps;
  return deps;
}

describe("panelTreeService", () => {
  it("is exposed to userland runtimes and trusted shell/server hosts", () => {
    const service = createPanelTreeService(treeDeps({ approvalQueue: approvalQueueMock("deny") }));

    // Runtime callers are admitted but remain context-boundary scoped unless
    // the canonical evaluator grants their exact code panel-hosting authority.
    expect(service.authority).toEqual({
      principals: ["code", "user", "host"],
    });
  });

  it("delegates open list operations without approval", async () => {
    const approvalQueue = approvalQueueMock("deny");
    const bridge = vi.fn(async () => [{ panelId: "panel-1" }]);
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "list", [null])).resolves.toEqual([{ panelId: "panel-1" }]);

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "roots", [])).resolves.toEqual([{ panelId: "root-1" }]);

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "ensureLoaded",
      args: ["target"],
    });
  });

  it("context-boundary gates structural operations before delegating", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-target" }
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "close", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
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
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "close", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "close",
      args: ["target"],
    });
  });

  it("does not prompt when exact code authority permits cross-context panel hosting", async () => {
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
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(panelHostCtx(), "archive", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await service.handler(ctx(), "close", ["target"]);
    await service.handler(ctx(), "close", ["target"]);

    // No double-prompt: the second close reuses the remembered grant.
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester"),
      })
    );
  });

  it("gates creating a panel into another existing context", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string; args: unknown[] }) =>
      request.method === "metadata"
        ? {
            id: request.args[0] as string,
            title: "Parent",
            source: "panels/parent",
            contextId: "ctx-caller",
          }
        : { id: "created", title: "Created", kind: "workspace" }
    );
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, bridge, resolveCallerContext: vi.fn(async () => "ctx-caller") })
    );

    await expect(
      service.handler(ctx(), "create", [
        "panels/child",
        { parentId: "parent", contextId: "ctx-foreign" },
      ])
    ).resolves.toEqual({ id: "created", title: "Created", kind: "workspace" });

    // Exactly one prompt for the single create call.
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        grantResourceKey: contextBoundaryResourceKey("ctx-foreign", "panel:requester"),
      })
    );
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenNthCalledWith(1, {
      callerId: "panel:requester",
      callerKind: "panel",
      method: "metadata",
      args: ["parent"],
    });
    expect(bridge).toHaveBeenNthCalledWith(2, {
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
        : { id: "created", title: "Created", kind: "workspace" }
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(
      service.handler(ctx(), "create", ["panels/child", { parentId: "parent" }])
    ).resolves.toEqual({ id: "created", title: "Created", kind: "workspace" });

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
        : { id: "created", title: "Created", kind: "workspace" }
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(
      service.handler(ctx(), "create", [
        "panels/child",
        { parentId: "parent", contextId: "ctx-foreign" },
      ])
    ).rejects.toThrow("is another agent or panel's existing state");

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
      request.method === "create" ? { id: "created", title: "Created", kind: "workspace" } : null
    );
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, resolveRequesterPanel, bridge })
    );

    await expect(service.handler(ctx(), "create", ["panels/child", {}])).resolves.toEqual({
      id: "created",
      title: "Created",
      kind: "workspace",
    });

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
    const service = createPanelTreeService(
      treeDeps({ approvalQueue: approvalQueueMock("deny"), bridge })
    );

    await expect(
      service.handler(ctx(), "setStateArgs", ["target", { mode: "edit" }])
    ).rejects.toThrow("is another agent or panel's existing state");

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

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "setStateArgs",
      args: ["requester-slot", { mode: "edit" }],
    });
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
        : { id: "requester-slot", title: "Vault" }
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
    ).resolves.toEqual({ id: "requester-slot", title: "Vault" });

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" }
        : { id: "target", title: "Next" }
    );
    const service = createPanelTreeService(
      treeDeps({ approvalQueue, bridge, resolveCallerContext: vi.fn(async () => "ctx-x") })
    );

    await expect(
      service.handler(ctx(), "navigate", ["target", "panels/next", { stateArgs: { a: 1 } }])
    ).resolves.toEqual({ id: "target", title: "Next" });

    // No `contextId` in the navigate options ⇒ no context change ⇒ free, even
    // though the target currently lives in a (foreign, existing) context.
    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenLastCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "navigate",
      args: ["target", "panels/next", { stateArgs: { a: 1 } }],
    });
  });

  it("gates navigating a panel into another existing context (X→Y)", async () => {
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" }
        : { id: "target", title: "Next" }
    );
    const service = createPanelTreeService(
      treeDeps({
        approvalQueue,
        bridge,
        contextExists: vi.fn(() => true),
        resolveCallerContext: vi.fn(async () => "ctx-x"),
      })
    );

    await expect(
      service.handler(ctx(), "navigate", ["target", "panels/next", { contextId: "ctx-y" }])
    ).resolves.toEqual({ id: "target", title: "Next" });

    // Exactly one prompt — keyed on the DESTINATION context (ctx-y), not ctx-x.
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
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
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) => {
      if (request.method === "metadata") {
        return { id: "target", title: "Target", source: "panels/target", contextId: "ctx-x" };
      }
      if (request.method === "historyTargetContext") return "ctx-y";
      return { id: "target", title: "Back" };
    });
    const service = createPanelTreeService(
      treeDeps({
        approvalQueue,
        bridge,
        contextExists: vi.fn(() => true),
        resolveCallerContext: vi.fn(async () => "ctx-x"),
      })
    );

    await service.handler(ctx(), "navigateHistory", ["target", -1]);

    // Peeked the destination history-entry context and prompted once keyed on it.
    expect(bridge).toHaveBeenCalledWith(
      expect.objectContaining({ method: "historyTargetContext", args: ["target", -1] })
    );
    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
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
      return { id: "target", title: "Back" };
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
    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
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
    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("gates object-shaped structural operations (movePanel) by target panel context", async () => {
    const approvalQueue = approvalQueueMock("session");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(
      service.handler(ctx(), "movePanel", [
        { panelId: "target", newParentId: null, targetPosition: 0 },
      ])
    ).resolves.toBeUndefined();

    expect(approvalQueue.requestCapability).toHaveBeenCalledTimes(1);
    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
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
    const approvalQueue = approvalQueueMock("once");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : undefined
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(service.handler(ctx(), "takeOver", ["target"])).resolves.toBeUndefined();
    await expect(
      service.handler(ctx(), "openDevTools", ["target", "detach"])
    ).resolves.toBeUndefined();
    await expect(service.handler(ctx(), "rebuildPanel", ["target"])).resolves.toBeUndefined();

    expect(approvalQueue.requestCapability).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY_CAPABILITY,
        operation: expect.objectContaining({ verb: "Take over panel in" }),
      })
    );
    expect(approvalQueue.requestCapability).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        operation: expect.objectContaining({ verb: "Open DevTools in" }),
      })
    );
    expect(approvalQueue.requestCapability).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        operation: expect.objectContaining({ verb: "Rebuild panel in" }),
      })
    );
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

    expect(approvalQueue.requestCapability).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith({
      callerId: "panel:requester",
      callerKind: "panel",
      method: "callAgent",
      args: ["target", "_agent.tree", []],
    });
  });

  it("gates agent mode changes as a cross-context state change", async () => {
    const approvalQueue = approvalQueueMock("session");
    const bridge = vi.fn(async (request: { method: string }) =>
      request.method === "metadata"
        ? { id: "target", title: "Target", contextId: "ctx-target" }
        : { mode: "fixture" }
    );
    const service = createPanelTreeService(treeDeps({ approvalQueue, bridge }));

    await expect(
      service.handler(ctx(), "callAgent", ["target", "_agent.setMode", ["fixture"]])
    ).resolves.toEqual({
      mode: "fixture",
    });

    expect(approvalQueue.requestCapability).toHaveBeenCalledWith(
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
