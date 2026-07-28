/** Desktop-owned phone discovery, installation, and secure pairing launch. */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const readAccess: MethodAccessDescriptor = { sensitivity: "read" };
const adminAccess: MethodAccessDescriptor = { sensitivity: "admin" };

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
    capability: "mobile.devices.read",
    tier: {
      tier: "gated",
      session: "family",
      rationale: "Connected desktop-provider inventory is private device state.",
    },
  },
  devices: {
    description:
      "Discover Android and iOS devices through the selected desktop, including readiness and compatible app state.",
    args: z.tuple([PhoneDeviceQuerySchema]),
    returns: PhoneDeviceDiscoverySchema,
    access: readAccess,
    capability: "mobile.devices.read",
    tier: {
      tier: "gated",
      session: "family",
      rationale: "Attached device inventory and installed-app state are private.",
    },
  },
  provision: {
    description:
      "Install when needed, immediately pair through the selected desktop, and wait for the new device to join the current account.",
    args: z.tuple([PhoneProvisionArgsSchema]),
    returns: PhoneProvisioningResultSchema,
    access: adminAccess,
    capability: "mobile.provision",
    tier: {
      tier: "gated",
      session: "family",
      rationale:
        "Installs software and adds the attached phone to the current account through a connected desktop.",
    },
  },
});
