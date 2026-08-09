import { readChannelSubscriptionRecords } from "@vibestudio/service-schemas/channel";
import {
  type ClaudeBridgeAuthority,
  type ClaudeBridgeJson,
  type ClaudeBridgeStreamRecord,
} from "./claudeBridgeBroker.js";

/** Launcher-owned transport. These generic primitives never cross the broker. */
export interface ClaudeBridgeAuthorityTransport {
  callVessel<T>(method: string, args: unknown[]): Promise<T>;
  streamVessel(method: string, args: unknown[], signal: AbortSignal): Promise<Response>;
  callWorkspace<T>(method: string, args: unknown[]): Promise<T>;
  onRecovery(handler: () => void | Promise<void>): Promise<() => void>;
  close(): Promise<void>;
}

/**
 * Seal one authenticated RPC transport behind the exact Claude channel surface.
 * The returned authority has no caller-selected target or method escape.
 */
export function createClaudeBridgeAuthority(
  transport: ClaudeBridgeAuthorityTransport
): ClaudeBridgeAuthority {
  return {
    openBridge: async function* (request, signal): AsyncIterable<ClaudeBridgeStreamRecord> {
      const response = await transport.streamVessel("openBridge", [request], signal);
      for await (const record of readChannelSubscriptionRecords<
        {
          ok: true;
          bridgeSessionId: string;
          attachmentGeneration: string;
          pendingCount: number;
          primaryChannelId: string | null;
          contextId: string | null;
          channelIds: string[];
        },
        Record<string, unknown>
      >(response)) {
        if (record.kind === "subscribed") {
          yield { kind: "subscribed", result: record.result };
        } else {
          yield { kind: "event", payload: record.payload as never };
        }
      }
    },
    say: (request) => transport.callVessel("say", [request]) as Promise<ClaudeBridgeJson>,
    complete: ({ report, outcome }) =>
      transport.callVessel("completeFromBridge", [
        { report, outcome },
      ]) as Promise<ClaudeBridgeJson>,
    requestPermission: async () => {
      throw new Error(
        "Claude permission relay is disabled until workspace approvals provide a trusted verdict"
      );
    },
    acceptDelivery: (request) =>
      transport.callVessel("acceptDelivery", [request]) as Promise<ClaudeBridgeJson>,
    ingestHookEvent: (request) =>
      transport.callVessel("ingestHookEvent", [request]) as Promise<ClaudeBridgeJson>,
    listSkills: () =>
      transport.callWorkspace("workspace.listSkills", []) as Promise<ClaudeBridgeJson>,
    readSkill: ({ name }) =>
      transport.callWorkspace("workspace.readSkill", [name]) as Promise<ClaudeBridgeJson>,
    linkedStatus: () => transport.callVessel("linkedStatus", []) as Promise<ClaudeBridgeJson>,
    onRecovery: (handler) => transport.onRecovery(handler),
    close: () => transport.close(),
  };
}
