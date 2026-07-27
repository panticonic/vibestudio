import { attachedHostsMethods } from "@vibestudio/service-schemas/attachedHosts";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { AttachedHostApprovalPresenter } from "./attachedHostApprovalPresenter.js";
import type { AttachedHostController } from "./attachedHostController.js";
import type { AttachedHostEndpoint } from "./attachedHostProtocol.js";

export interface AttachedHostsServiceDeps {
  /** Child-side endpoint, present only on an attachable isolated host. */
  child?: AttachedHostEndpoint;
  /** Parent-side endpoint and canonical queue bridge. */
  parent?: AttachedHostEndpoint;
  approvalPresenter?: AttachedHostApprovalPresenter;
  controller?: Pick<
    AttachedHostController,
    "attachClient" | "invokeAttached" | "listApprovalAudit"
  >;
}

export function createAttachedHostsService(deps: AttachedHostsServiceDeps): ServiceDefinition {
  return {
    name: "attachedHosts",
    description:
      "Internal owner-bound routing for ordinary generated service clients on an isolated host",
    authority: { principals: ["host"] },
    methods: attachedHostsMethods,
    handler: defineServiceHandler("attachedHosts", attachedHostsMethods, {
      attachClient: (ctx, [input]) =>
        requireController(deps).attachClient(input.sessionId, ownerFrom(ctx)),
      invokeAttached: async (ctx, [input]) =>
        await requireController(deps).invokeAttached(
          input.sessionId,
          ownerFrom(ctx),
          input.service,
          input.method,
          input.args
        ),
      listApprovalAudit: (ctx, [input]) =>
        requireController(deps).listApprovalAudit(input.sessionId, ownerFrom(ctx), input),
      bootstrapExchange: async (ctx, [hello]) => {
        const child = requireChild(deps);
        const transportUserId = ctx.caller.subject?.userId ?? null;
        if (transportUserId !== hello.initiatingUserId) {
          throw serviceError(
            "EATTACHED_OWNER",
            "Bootstrap device user does not own the attached development run"
          );
        }
        return child.acceptChild(hello);
      },
      bootstrapConfirm: async (ctx, [proof]) => {
        const child = requireChild(deps);
        const transportUserId = ctx.caller.subject?.userId ?? null;
        if (transportUserId !== proof.transcript.initiatingUserId) {
          throw serviceError(
            "EATTACHED_OWNER",
            "Bootstrap device user does not own the attached development run"
          );
        }
        child.finalizeChild(proof);
        return { attachedHostSessionId: proof.transcript.sessionId };
      },
      invoke: async (_ctx, [input]) =>
        await requireChild(deps).receiveInvocation(input.envelope, input.args),
      presentApproval: async (ctx, [challenge]) => {
        if (!ctx.caller.hostOriginated) {
          throw serviceError(
            "EATTACHED_TRANSPORT",
            "Approval challenge requires verified attached-host route ingress"
          );
        }
        const presenter = deps.approvalPresenter;
        if (!deps.parent || !presenter) {
          throw serviceError(
            "EATTACHED_PARENT",
            "Attached-host parent approval bridge is unavailable"
          );
        }
        return await presenter.present(challenge, ctx.signal);
      },
      close: async (_ctx, [input]) => {
        const endpoint = deps.child ?? deps.parent;
        if (!endpoint) {
          throw serviceError("EATTACHED_ENDPOINT", "Attached-host endpoint is unavailable");
        }
        endpoint.close(input.attachedHostSessionId, input.reason);
      },
    }),
  };
}

function requireController(
  deps: AttachedHostsServiceDeps
): Pick<AttachedHostController, "attachClient" | "invokeAttached" | "listApprovalAudit"> {
  if (!deps.controller) {
    throw serviceError("EATTACHED_PARENT", "Attached-host client registry is unavailable");
  }
  return deps.controller;
}

function ownerFrom(ctx: {
  caller: {
    runtime: { id: string; kind: import("@vibestudio/rpc").CallerKind };
    subject?: { userId: string };
  };
}) {
  return {
    runtimeId: ctx.caller.runtime.id,
    runtimeKind: ctx.caller.runtime.kind,
    userId: ctx.caller.subject?.userId ?? null,
  };
}

function requireChild(deps: AttachedHostsServiceDeps): AttachedHostEndpoint {
  if (!deps.child) {
    throw serviceError("EATTACHED_CHILD", "This host does not accept attached child routes");
  }
  return deps.child;
}

function serviceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
