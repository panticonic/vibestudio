import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";

export interface HubControlClient {
  call(
    method: HubControlRpcMethod,
    args: unknown[],
    subject: UserSubject,
    deviceId?: string
  ): Promise<unknown>;
}

export type HubControlMethod = keyof typeof hubControlMethods & string;
export type HubControlRpcMethod = `hubControl.${HubControlMethod}`;

export function createHubControlClient(input: {
  hubUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
}): HubControlClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async call(method, args, subject, deviceId) {
      const response = await fetchImpl(new URL("/rpc", input.hubUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.controlToken}`,
        },
        body: JSON.stringify({
          method,
          args,
          subject: { userId: subject.userId, ...(deviceId ? { deviceId } : {}) },
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || typeof payload["error"] === "string") {
        throw new Error(
          typeof payload["error"] === "string"
            ? payload["error"]
            : `Hub control request failed with HTTP ${response.status}`
        );
      }
      return payload["result"];
    },
  };
}

/**
 * Typed child→hub control façade. Remote clients stay on their direct child
 * pipe while control calls cross the loopback capability channel; identity is
 * taken from `ctx.caller.subject`, never from wire arguments.
 */
export function createHubControlService(client: HubControlClient): ServiceDefinition {
  async function forward(
    ctx: ServiceContext,
    method: HubControlMethod,
    args: unknown[]
  ): Promise<unknown> {
    const subject = ctx.caller.subject;
    if (!subject || subject.userId === "system") {
      throw new Error("Hub control requires an authenticated user");
    }
    const callerId = ctx.caller.runtime.id;
    const deviceId = callerId.startsWith("shell:") ? callerId.slice("shell:".length) : undefined;
    const rpcMethod: HubControlRpcMethod = `hubControl.${method}`;
    return client.call(rpcMethod, args, subject, deviceId);
  }

  return {
    name: "hubControl",
    description: "Authenticated workspace-child to server-hub control plane",
    policy: { allowed: ["shell", "panel", "app", "server"] },
    methods: hubControlMethods,
    handler: defineServiceHandler("hubControl", hubControlMethods, {
      listWorkspaces: (ctx, args) => forward(ctx, "listWorkspaces", args),
      routeWorkspace: (ctx, args) => forward(ctx, "routeWorkspace", args),
      createWorkspace: (ctx, args) => forward(ctx, "createWorkspace", args),
      deleteWorkspace: (ctx, args) => forward(ctx, "deleteWorkspace", args),
      addWorkspaceMember: (ctx, args) => forward(ctx, "addWorkspaceMember", args),
      removeWorkspaceMember: (ctx, args) => forward(ctx, "removeWorkspaceMember", args),
      listWorkspaceMembers: (ctx, args) => forward(ctx, "listWorkspaceMembers", args),
      listUserPresence: (ctx, args) => forward(ctx, "listUserPresence", args),
      inviteUser: (ctx, args) => forward(ctx, "inviteUser", args),
      pairDevice: (ctx, args) => forward(ctx, "pairDevice", args),
      listDevices: (ctx, args) => forward(ctx, "listDevices", args),
      revokeDevice: (ctx, args) => forward(ctx, "revokeDevice", args),
      revokeUser: (ctx, args) => forward(ctx, "revokeUser", args),
      setRole: (ctx, args) => forward(ctx, "setRole", args),
      updateProfile: (ctx, args) => forward(ctx, "updateProfile", args),
      getProfile: (ctx, args) => forward(ctx, "getProfile", args),
    }),
  };
}
