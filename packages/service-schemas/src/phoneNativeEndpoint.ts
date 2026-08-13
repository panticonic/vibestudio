import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  PhoneDeviceDiscoverySchema,
  PhoneDeviceQuerySchema,
  PhoneProviderSchema,
  PhoneProvisionArgsSchema,
  PhoneProvisioningResultSchema,
} from "./phoneProvisioning.js";

const nonEmpty = z.string().min(1);
const openTransport = {
  tier: "open" as const,
  session: "family" as const,
  residency: "transport" as const,
  family: "phoneNativeEndpoint.transport",
  rationale:
    "Typed account-bound phone transport available only to the exact approved Base phone provider; the provider's public mobile capability is the sole user-facing gate.",
};

export const PhoneNativeDesktopSchema = z
  .object({
    clientId: nonEmpty,
    label: nonEmpty.nullable(),
    platform: nonEmpty.nullable(),
  })
  .strict();
export type PhoneNativeDesktop = z.infer<typeof PhoneNativeDesktopSchema>;

/** Mechanical phone endpoint beneath the reviewed Base provider. It has no
 * generic method/argument conduit and carries no independent user gate. */
export const phoneNativeEndpointMethods = defineServiceMethods({
  desktops: {
    tier: openTransport,
    description: "List live desktop endpoints on the initiating user's account.",
    args: z.tuple([]),
    returns: z.array(PhoneNativeDesktopSchema),
    authority: { principals: ["code"] },
    access: { sensitivity: "read" },
  },
  providers: {
    tier: openTransport,
    description: "Read phone capabilities from one exact connected desktop.",
    args: z.tuple([z.object({ clientId: nonEmpty }).strict()]),
    returns: z.array(PhoneProviderSchema),
    authority: { principals: ["code"] },
    access: { sensitivity: "read" },
  },
  devices: {
    tier: openTransport,
    description: "Discover phones through one exact connected desktop.",
    args: z.tuple([z.object({ clientId: nonEmpty, query: PhoneDeviceQuerySchema }).strict()]),
    returns: PhoneDeviceDiscoverySchema,
    authority: { principals: ["code"] },
    access: { sensitivity: "read" },
  },
  provision: {
    tier: openTransport,
    description: "Run the typed native install-and-pair effect on one exact desktop.",
    args: z.tuple([z.object({ clientId: nonEmpty, input: PhoneProvisionArgsSchema }).strict()]),
    returns: PhoneProvisioningResultSchema,
    authority: { principals: ["code"] },
    access: { sensitivity: "admin" },
  },
});
