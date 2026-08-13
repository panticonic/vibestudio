/**
 * push service method schemas — mobile/remote shell push device registration
 * plus server-only delivery helpers.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export const PushPlatformSchema = z.enum(["ios", "android", "web"]);

// Access descriptors classify the push methods; the service and method
// authority declarations independently select the required principals.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const PushRegistrationSchema = z.object({
  token: z.string().describe("Platform push token (APNs/FCM/Web Push)."),
  platform: PushPlatformSchema.describe("Device platform the token belongs to."),
  clientId: z.string().describe("Stable client identifier the device registered under."),
  registeredAt: z.number().describe("Epoch milliseconds when the device was registered."),
});
export type PushRegistration = z.infer<typeof PushRegistrationSchema>;

export const PushSendOptionsSchema = z.object({
  clientId: z.string().describe("Client identifier of the registered device to deliver to."),
  title: z.string().describe("Notification title."),
  body: z.string().optional().describe("Notification body text."),
  category: z.string().optional().describe("Notification category for grouping/handling."),
  data: z
    .record(z.unknown())
    .optional()
    .describe("Arbitrary data payload delivered with the push."),
});
export type PushSendOptions = z.infer<typeof PushSendOptionsSchema>;

export const PushSendResultSchema = z.object({
  clientId: z.string().describe("Client identifier the push was addressed to."),
  platform: PushPlatformSchema.describe("Platform of the delivered registration."),
  sent: z.boolean().describe("Whether delivery was accepted (true even for log-only)."),
  logOnly: z.boolean().describe("True when Firebase was unavailable and the push was only logged."),
  error: z.string().optional().describe("Failure reason when delivery did not succeed."),
});
export type PushSendResult = z.infer<typeof PushSendResultSchema>;

export const PushRegisterRequestSchema = z
  .object({
    token: z.string().describe("Platform push token (APNs/FCM/Web Push)."),
    platform: PushPlatformSchema.describe("Device platform the token belongs to."),
    clientId: z.string().describe("Stable client identifier to register the device under."),
  })
  .strict();
export type PushRegisterRequest = z.infer<typeof PushRegisterRequestSchema>;

export const pushMethods = defineServiceMethods({
  register: {
    capability: "push.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.create",
      rationale: "G5: push registration is device and approval plumbing; §3 push precedent",
    },
    presentation: {
      title: "Enable notifications on a device",
      action: "enable notifications on a device",
      description: "Register a device to receive push notifications.",
      group: "notifications",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description:
      "Register a device's push token for a client id, persisting it so it survives server restarts.",
    args: z.tuple([PushRegisterRequestSchema]),
    returns: z.object({ registered: z.boolean() }),
    access: WRITE_ACCESS,
    examples: [
      {
        args: [{ token: "abc123", platform: "ios", clientId: "client-1" }],
        returns: { registered: true },
      },
    ],
  },
  unregister: {
    capability: "push.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.control",
      rationale:
        "G5: push registration lifecycle is device and approval plumbing; §3 push precedent",
    },
    presentation: {
      title: "Disable notifications on a device",
      action: "disable notifications on a device",
      description: "Stop sending push notifications to a device.",
      group: "notifications",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description:
      "Remove the persisted push registration for a client id; returns whether one existed.",
    args: z.tuple([z.string()]),
    returns: z.object({ unregistered: z.boolean() }),
    access: { sensitivity: "destructive" },
    examples: [{ args: ["client-1"], returns: { unregistered: true } }],
  },
  send: {
    capability: "push.send",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.control",
      rationale: "G1/G5: external push delivery is host approval plumbing; §3 push precedent",
    },
    presentation: {
      title: "Send a notification",
      action: "send a notification",
      description: "Deliver a push notification to a registered device.",
      group: "notifications",
      authorityCategory: {
        domain: "sharing",
        verb: "act",
      },
    },
    description:
      "Deliver a push notification to a registered device via Firebase, degrading to log-only when credentials are unavailable. Server-only.",
    args: z.tuple([PushSendOptionsSchema]),
    returns: PushSendResultSchema,
    authority: { principals: ["host"] },
    access: WRITE_ACCESS,
  },
  listRegistrations: {
    capability: "push.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "transport",
      family: "push.read",
      rationale: "G4/G5: push-token inventory is private approval plumbing; §3 push precedent",
    },
    presentation: {
      title: "View devices registered for notifications",
      action: "view devices registered for notifications",
      description: "See which devices are set up to receive push notifications.",
      group: "notifications",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "List all currently persisted push registrations. Server-only.",
    args: z.tuple([]),
    returns: z.array(PushRegistrationSchema),
    authority: { principals: ["host"] },
    access: READ_ACCESS,
  },
});
