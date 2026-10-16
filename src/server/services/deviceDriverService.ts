import { deviceDriverMethods } from "@vibestudio/service-schemas/deviceDriver";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  verifiedInitiatingUserId,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { DeviceDriverRelay, type DeviceDriverEvents } from "./deviceDriverRelay.js";

export function createDeviceDriverService(deps: {
  eventService: DeviceDriverEvents;
}): ServiceDefinition {
  const relay = new DeviceDriverRelay(deps.eventService);
  return {
    name: "deviceDriver",
    description:
      "Test drivers: devices the person started so the account's system tests can drive them",
    authority: { principals: ["user", "code"] },
    methods: deviceDriverMethods,
    handler: defineServiceHandler("deviceDriver", deviceDriverMethods, {
      register: (ctx, [{ deviceKind }]) => {
        relay.register({
          runtimeId: ctx.caller.runtime.id,
          userId: requireUser(ctx.caller),
          kind: deviceKind,
        });
        return { accepted: true as const };
      },
      answer: (ctx, [{ callId, outcome }]) => {
        relay.answer(ctx.caller.runtime.id, requireUser(ctx.caller), callId, outcome);
        return { accepted: true as const };
      },
      devices: (ctx) => {
        const userId = verifiedInitiatingUserId(ctx);
        return userId ? relay.list(userId) : [];
      },
      drive: async (ctx, [input]) => {
        const userId = verifiedInitiatingUserId(ctx);
        if (!userId) {
          throw Object.assign(new Error("Driving a device requires an authenticated user"), {
            code: "EACCES",
          });
        }
        return { value: await relay.drive(userId, input, ctx.signal) };
      },
    }),
  };
}

function requireUser(caller: VerifiedCaller): string {
  const userId = caller.subject?.userId;
  if (!userId) {
    throw Object.assign(new Error("A device driver requires an authenticated user"), {
      code: "EACCES",
    });
  }
  return userId;
}
