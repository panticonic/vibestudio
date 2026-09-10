import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createWorkspaceCreationService } from "./workspaceCreationService.js";
import { WORKSPACE_CREATION_AUTHORITY_RESOLVER } from "@vibestudio/service-schemas/workspaceCreation";

const input = { operationId: "creation_operation_1", workspace: "Example" };
function fixture() {
  const hub = { createWorkspace: vi.fn(), workspaceCreationReceipt: vi.fn() };
  return { hub, service: createWorkspaceCreationService({ workspaceId: "ws_source", hub }) };
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
});
