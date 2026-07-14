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
  deviceId: z.string().min(1).optional(),
  status: z.enum(["installed", "already-compatible", "launched", "manual-action"]),
  packageId: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});
export type PhoneProvisioningResult = z.infer<typeof PhoneProvisioningResultSchema>;

export const PhoneDeviceQuerySchema = z
  .object({
    providerId: z.string().min(1).optional(),
    platform: PhonePlatformSchema.optional(),
  })
  .strict()
  .optional();

export const PhoneInstallArgsSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    platform: PhonePlatformSchema,
    deviceId: z.string().min(1).optional(),
    mode: z.enum(["auto", "release", "source"]).optional(),
  })
  .strict();
export type PhoneInstallArgs = z.infer<typeof PhoneInstallArgsSchema>;

export const PhoneOpenPairingArgsSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    platform: PhonePlatformSchema,
    deviceId: z.string().min(1).optional(),
    pairUrl: z.string().min(1),
    packageId: z.string().min(1).optional(),
    bundleId: z.string().min(1).optional(),
  })
  .strict();
export type PhoneOpenPairingArgs = z.infer<typeof PhoneOpenPairingArgsSchema>;

export const phoneProvisioningMethods = defineServiceMethods({
  providers: {
    description:
      "List account-scoped desktop capability providers that can access phones attached to them.",
    args: z.tuple([]),
    returns: z.array(PhoneProviderSchema),
    access: readAccess,
  },
  devices: {
    description:
      "Discover Android and iOS devices through the selected desktop, including readiness and compatible app state.",
    args: z.tuple([PhoneDeviceQuerySchema]),
    returns: PhoneDeviceDiscoverySchema,
    access: readAccess,
  },
  install: {
    description:
      "Install a compatible mobile app through the selected desktop, resolving release tooling lazily when possible.",
    args: z.tuple([PhoneInstallArgsSchema]),
    returns: PhoneProvisioningResultSchema,
    access: adminAccess,
  },
  openPairing: {
    description:
      "Open a one-time pairing link on a phone through the selected desktop without returning or logging the link.",
    args: z.tuple([PhoneOpenPairingArgsSchema]),
    returns: PhoneProvisioningResultSchema,
    access: adminAccess,
  },
});
