import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { createWorkspaceHubControlService } from "./workspaceHubControlService.js";
import { WORKSPACE_CREATION_AUTHORITY_RESOLVER } from "@vibestudio/service-schemas/workspaceCreation";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";

const input = { operationId: "creation_operation_1", workspace: "Example" };
function fixture() {
  const hub = {
    createWorkspace: vi.fn(),
    workspaceCreationReceipt: vi.fn(),
    observeDevices: vi.fn(),
  };
  return { hub, service: createWorkspaceHubControlService({ workspaceId: "ws_source", hub }) };
}
function context(kind: "panel" | "worker", id: string): ServiceContext {
  return {
    caller: createVerifiedCaller(id, kind, null, null, { userId: "alice", handle: "Alice" }),
  } as ServiceContext;
}

describe("workspace creation runtime entry", () => {
  it("seals the requested workspace and exact template into shared approval presentation", async () => {
    const f = fixture();
    const rootTemplate = {
      url: "https://github.com/example/template.git",
      ref: "refs/heads/main",
      commit: "0123456789abcdef0123456789abcdef01234567",
    };
    const prepared = await f.service.authorityPreparation![WORKSPACE_CREATION_AUTHORITY_RESOLVER]!(
      context("panel", "panel:one"),
      [{ ...input, rootTemplate }]
    );
    expect(prepared.payload).toEqual({ ...input, rootTemplate });
    expect(prepared.selections).toEqual([
      expect.objectContaining({
        capability: "workspaces.create",
        resourceKey: input.operationId,
        challenge: expect.objectContaining({
          title: "Create “Example” workspace",
          resource: { type: "workspace", label: "Workspace", value: "Example" },
          details: [
            { label: "Template source", value: rootTemplate.url },
            { label: "Template ref", value: rootTemplate.ref },
            { label: "Template commit", value: rootTemplate.commit },
            { label: "Request ID", value: input.operationId, format: "code" },
          ],
          substance: expect.objectContaining({
            facts: expect.arrayContaining([
              { label: "Workspace", value: "Example" },
              { label: "Template source", value: rootTemplate.url },
              { label: "Template commit", value: rootTemplate.commit },
            ]),
          }),
        }),
      }),
    ]);
  });

  it.each(["panel", "worker"] as const)(
    "uses the same owner for %s creation and receipt recovery",
    async (kind) => {
      const f = fixture();
      const ctx = context(kind, `${kind}:one`);
      await f.service.handler(ctx, "createWorkspace", [input]);
      await f.service.handler(ctx, "workspaceCreationReceipt", [
        { operationId: input.operationId },
      ]);
      const requester = { userId: "alice", subject: `runtime:${kind}:one` };
      expect(f.hub.createWorkspace).toHaveBeenCalledWith({ requester, input });
      expect(f.hub.workspaceCreationReceipt).toHaveBeenCalledWith({
        requester,
        input: { operationId: input.operationId },
      });
      expect(Object.keys(f.service.methods!)).toEqual([
        "createWorkspace",
        "workspaceCreationReceipt",
        "observeDevices",
      ]);
    }
  );

  it("binds fresh website documents to the same authenticated site receipt subject", async () => {
    const f = fixture();
    for (const id of ["panel:old", "panel:replacement"]) {
      const ctx = context("panel", id);
      ctx.caller.website = {
        subject: "website:site",
        userId: "user:alice",
        workspaceId: "ws_source",
        origin: "https://example.com",
        connected: true,
        binding: { subject: "website:site", generation: 1, documentId: id },
      };
      await f.service.handler(ctx, "workspaceCreationReceipt", [
        { operationId: input.operationId },
      ]);
    }
    expect(f.hub.workspaceCreationReceipt.mock.calls[0]).toEqual(
      f.hub.workspaceCreationReceipt.mock.calls[1]
    );
    expect(f.hub.createWorkspace).not.toHaveBeenCalled();
  });

  it("rejects disconnected websites and absent account evidence before contacting the hub", async () => {
    const f = fixture();
    const ctx = context("panel", "panel:page");
    ctx.caller.website = {
      subject: "website:site",
      userId: "user:alice",
      workspaceId: "ws_source",
      origin: "https://example.com",
      connected: false,
      binding: { subject: "website:site", generation: 1 },
    };
    await expect(f.service.handler(ctx, "createWorkspace", [input])).rejects.toThrow("Connect");
    delete ctx.caller.website;
    delete ctx.caller.subject;
    await expect(f.service.handler(ctx, "createWorkspace", [input])).rejects.toThrow(
      "authenticated account"
    );
    expect(f.hub.createWorkspace).not.toHaveBeenCalled();
  });

  it("binds device observation to the authenticated caller and forwards cancellation", async () => {
    const f = fixture();
    const ctx = context("panel", "panel:one");
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const observation = { afterVersion: "opaque-version" };
    await f.service.handler(ctx, "observeDevices", [observation]);
    expect(f.hub.observeDevices).toHaveBeenCalledWith(
      { userId: "alice", input: observation },
      { signal: controller.signal }
    );
    expect(Object.keys(f.service.methods!)).not.toContain("listDevices");
    controller.abort();
  });

  it("admits a code caller with a verified account subject through the dispatcher", async () => {
    const f = fixture();
    f.hub.observeDevices.mockResolvedValue({ version: "opaque-version" });
    const dispatcher = new ServiceDispatcher();
    dispatcher.setAuthorityResolver(({ caller, service, capability, resourceKey }) =>
      authorizeVerifiedCaller(caller, {
        workspaceId: "ws_source",
        workspaceMember: true,
        sessionId: caller.runtime.id,
        audience: `service:${service}`,
        capability,
        resourceKey,
      })
    );
    dispatcher.registerService(f.service);
    dispatcher.markInitialized();
    const caller = createVerifiedCaller(
      "worker:setup",
      "worker",
      {
        callerId: "worker:setup",
        callerKind: "worker",
        repoPath: "workers/setup",
        effectiveVersion: "version:one",
      },
      null,
      { userId: "alice", handle: "Alice" }
    );
    const signal = new AbortController().signal;
    await expect(
      dispatcher.dispatch({ caller, signal }, "hubControl", "observeDevices", [{}])
    ).resolves.toEqual({ version: "opaque-version" });
    expect(f.hub.observeDevices).toHaveBeenCalledWith({ userId: "alice", input: {} }, { signal });
  });

  it("rejects guest RPC callers before contacting the hub", async () => {
    const f = fixture();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(f.service);
    dispatcher.markInitialized();
    const caller = createVerifiedCaller("worker:guest", "worker", null, null, null);
    await expect(
      dispatcher.dispatch({ caller }, "hubControl", "observeDevices", [{}])
    ).rejects.toThrow();
    expect(f.hub.observeDevices).not.toHaveBeenCalled();
  });
});
