import { workspaceHubControlMethods } from "@vibestudio/service-schemas/workspaceHubControl";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceChildHubPort } from "../workspaceChildHubPort.js";
import { workspaceCreationAuthorityPreparation } from "./workspaceCreationAuthority.js";

/** Narrow workspace-child entry to existing hub-owned controls. */
export function createWorkspaceHubControlService(deps: {
  workspaceId: string;
  hub: Pick<
    WorkspaceChildHubPort,
    "createWorkspace" | "workspaceCreationReceipt" | "observeDevices"
  >;
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
    description: "Authenticated workspace creation and device observation through the owning hub",
    methods: workspaceHubControlMethods,
    authority: { principals: ["user", "host", "code", "website"] },
    authorityPreparation: workspaceCreationAuthorityPreparation,
    handler: defineServiceHandler("hubControl", workspaceHubControlMethods, {
      createWorkspace: (ctx, [input]) =>
        deps.hub.createWorkspace({ requester: requester(ctx), input }),
      workspaceCreationReceipt: (ctx, [input]) =>
        deps.hub.workspaceCreationReceipt({ requester: requester(ctx), input }),
      observeDevices: (ctx, [input]) => {
        if (!ctx.caller.subject)
          throw new Error("Device observation requires an authenticated account");
        return deps.hub.observeDevices(
          { userId: ctx.caller.subject.userId, input },
          { signal: ctx.signal }
        );
      },
    }),
  };
}
