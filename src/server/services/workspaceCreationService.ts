import { workspaceCreationMethods } from "@vibestudio/service-schemas/workspaceCreation";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceChildHubPort } from "../workspaceChildHubPort.js";

/** Host-attested entry to the hub's existing lifecycle owner; no local creation state. */
export function createWorkspaceCreationService(deps: {
  workspaceId: string;
  hub: Pick<WorkspaceChildHubPort, "createWorkspace" | "workspaceCreationReceipt">;
}): ServiceDefinition {
  const requester = (ctx: ServiceContext) => {
    const caller = ctx.caller;
    if (!caller.subject) throw new Error("Workspace creation requires an authenticated account");
    if (caller.website) {
      if (!caller.website.connected || caller.website.workspaceId !== deps.workspaceId)
        throw new Error("Connect this website to the workspace first");
      return { userId: caller.subject.userId, subject: caller.website.subject };
    }
    // Receipts belong to the authenticated runtime, not a mutable display name,
    // caller-supplied principal, or a version shared by multiple runtimes.
    return { userId: caller.subject.userId, subject: `runtime:${caller.runtime.id}` };
  };
  return {
    name: "hubControl",
    description: "Scoped workspace creation through the authenticated owning hub",
    methods: workspaceCreationMethods,
    authority: { principals: ["user", "host", "code", "website"] },
    handler: defineServiceHandler("hubControl", workspaceCreationMethods, {
      createWorkspace: (ctx, [input]) =>
        deps.hub.createWorkspace({ requester: requester(ctx), input }),
      workspaceCreationReceipt: (ctx, [input]) =>
        deps.hub.workspaceCreationReceipt({ requester: requester(ctx), input }),
    }),
  };
}
