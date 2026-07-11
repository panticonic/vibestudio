import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { UserSubject } from "@vibestudio/shared/users/types";
import { hubControlMethods } from "@vibestudio/shared/serviceSchemas/hubControl";

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
  return {
    name: "hubControl",
    description: "Authenticated workspace-child to server-hub control plane",
    policy: { allowed: ["shell", "panel", "app", "server"] },
    methods: hubControlMethods,
    handler: async (ctx, method, args) => {
      if (!(method in hubControlMethods)) throw new Error(`Unknown hubControl method: ${method}`);
      const subject = ctx.caller.subject;
      if (!subject || subject.userId === "system") {
        throw new Error("Hub control requires an authenticated user");
      }
      const callerId = ctx.caller.runtime.id;
      const deviceId = callerId.startsWith("shell:") ? callerId.slice("shell:".length) : undefined;
      return await client.call(
        `hubControl.${method}` as HubControlRpcMethod,
        args,
        subject,
        deviceId
      );
    },
  };
}
