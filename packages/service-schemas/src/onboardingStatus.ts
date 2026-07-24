import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const availability = z.enum(["available", "unknown"]);

export const OnboardingHostTopologySnapshotSchema = z
  .object({
    devices: z
      .object({
        availability,
        pairedDeviceCount: z.number().int().nonnegative(),
        thisDevicePaired: z.boolean(),
      })
      .strict(),
    remote: z
      .object({
        availability,
        route: z.enum(["local", "remote"]),
        workspaceCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const onboardingStatusMethods = defineServiceMethods({
  read: {
    description:
      "Read the redacted device, workspace, and remote-routing topology used by onboarding.",
    args: z.tuple([]),
    returns: OnboardingHostTopologySnapshotSchema,
    access: { sensitivity: "read" as const },
  },
});

export type OnboardingHostTopologySnapshot = z.infer<typeof OnboardingHostTopologySnapshotSchema>;
