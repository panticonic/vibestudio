/** Desktop-owned phone discovery, installation, and secure pairing launch. */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const readAccess: MethodAccessDescriptor = { sensitivity: "read" };
const adminAccess: MethodAccessDescriptor = { sensitivity: "admin" };
const USER_CODE_HOST: ServiceAuthorityPolicy = { principals: ["user", "code", "host"] };
const MOBILE_DEVICES_PRESENTATION = {
  title: "View available mobile devices",
  action: "view available mobile devices",
  description: "Allows {requesterKind} to view available mobile devices.",
  group: "accounts",
  authorityCategory: { domain: "people", verb: "see" },
} as const;
const MOBILE_PROVISION_PRESENTATION = {
  title: "Install and pair a mobile device",
  action: "install and pair a mobile device",
  description: "Allows {requesterKind} to install and pair a mobile device.",
  group: "accounts",
  authorityCategory: { domain: "people", verb: "manage" },
} as const;

export const PhonePlatformSchema = z.enum(["android", "ios"]);
export type PhonePlatform = z.infer<typeof PhonePlatformSchema>;

export const PhoneProviderSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1),
  hostPlatform: z.string().min(1),
  platforms: z.array(PhonePlatformSchema),
  sourcePlatforms: z.array(PhonePlatformSchema),
  appVersion: z.string().min(1),
});
export type PhoneProvider = z.infer<typeof PhoneProviderSchema>;

export const PhoneInstalledAppSchema = z.object({
  packageId: z.string().min(1),
  versionName: z.string().min(1).optional(),
});

export const PhoneDeviceSchema = z.object({
  providerId: z.string().min(1),
  platform: PhonePlatformSchema,
  deviceId: z.string().min(1),
  name: z.string().min(1).optional(),
  state: z.string().min(1),
  kind: z.enum(["physical", "emulator", "simulator"]),
  ready: z.boolean(),
  installedApps: z.array(PhoneInstalledAppSchema),
  compatibleAppInstalled: z.boolean(),
});
export type PhoneDevice = z.infer<typeof PhoneDeviceSchema>;

export const PhoneProvisioningIssueSchema = z.object({
  providerId: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  action: z.string().min(1).optional(),
});
export type PhoneProvisioningIssue = z.infer<typeof PhoneProvisioningIssueSchema>;

export const PhoneDeviceDiscoverySchema = z.object({
  devices: z.array(PhoneDeviceSchema),
  issues: z.array(PhoneProvisioningIssueSchema),
});
export type PhoneDeviceDiscovery = z.infer<typeof PhoneDeviceDiscoverySchema>;

export const PhoneProvisioningResultSchema = z.object({
  providerId: z.string().min(1),
  platform: PhonePlatformSchema,
  workspace: z.string().min(1),
  attachedDeviceId: z.string().min(1),
  installStatus: z.enum(["installed", "already-compatible"]),
  compatibleAppInstalled: z.literal(true),
  pairingStatus: z.literal("paired"),
  pairedDevice: z
    .object({
      deviceId: z.string().min(1),
      label: z.string().min(1),
      platform: z.string().min(1).optional(),
      createdAt: z.number(),
    })
    .strict(),
});
export type PhoneProvisioningResult = z.infer<typeof PhoneProvisioningResultSchema>;

export const PhoneDeviceQuerySchema = z
  .object({
    providerId: z.string().min(1).optional(),
    platform: PhonePlatformSchema.optional(),
  })
  .strict()
  .optional();

export const PhoneProvisionArgsSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    platform: PhonePlatformSchema,
    deviceId: z.string().min(1).optional(),
    mode: z.enum(["auto", "release", "source"]).optional(),
  })
  .strict();
export type PhoneProvisionArgs = z.infer<typeof PhoneProvisionArgsSchema>;

export const phoneProvisioningMethods = defineServiceMethods({
  providers: {
    description:
      "List account-scoped desktop capability providers that can access phones attached to them.",
    args: z.tuple([]),
    returns: z.array(PhoneProviderSchema),
    access: readAccess,
    authority: USER_CODE_HOST,
    capability: "mobile.devices.read",
    presentation: MOBILE_DEVICES_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "phoneProvisioning.read",
      rationale:
        "Builtin policy composes account-bound connected-client transport without retaining product policy in the kernel.",
    },
  },
  devices: {
    description:
      "Discover Android and iOS devices through the selected desktop, including readiness and compatible app state.",
    args: z.tuple([PhoneDeviceQuerySchema]),
    returns: PhoneDeviceDiscoverySchema,
    access: readAccess,
    authority: USER_CODE_HOST,
    capability: "mobile.devices.read",
    presentation: MOBILE_DEVICES_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "phoneProvisioning.read",
      rationale:
        "Builtin policy invokes the receiver-owned native device endpoint over account-bound transport.",
    },
  },
  provision: {
    description:
      "Install when needed, immediately pair through the selected desktop, and wait for the new device to join the current account.",
    args: z.tuple([PhoneProvisionArgsSchema]),
    returns: PhoneProvisioningResultSchema,
    access: adminAccess,
    authority: USER_CODE_HOST,
    capability: "mobile.provision",
    presentation: MOBILE_PROVISION_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "phoneProvisioning.provision",
      rationale:
        "Builtin policy invokes the exact receiver-owned native install and pairing endpoint on the selected desktop.",
    },
  },
});
