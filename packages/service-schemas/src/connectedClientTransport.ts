import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const nonEmpty = z.string().min(1);
type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };
const wireValueSchema: z.ZodType<WireValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(wireValueSchema),
    z.record(wireValueSchema),
  ])
);
const CONNECTED_CLIENT_TRANSPORT_PRESENTATION = {
  title: "Use a connected client",
  action: "send an authenticated request to a connected client",
  description:
    "Allows {requesterKind} to communicate with an exact connected client on the current account.",
  group: "runtime",
  authorityCategory: { domain: "computer", verb: "manage" },
} as const;

export const connectedClientDescriptorSchema = z
  .object({
    clientId: nonEmpty,
    label: nonEmpty.nullable(),
    platform: nonEmpty.nullable(),
    runtimeKind: nonEmpty,
  })
  .strict();
export type ConnectedClientDescriptor = z.infer<typeof connectedClientDescriptorSchema>;

export const connectedClientTransportMethods = defineServiceMethods({
  list: {
    capability: "connected-client.transport",
    presentation: CONNECTED_CLIENT_TRANSPORT_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "connectedClientTransport.read",
      rationale:
        "Enumerates only live transport endpoints bound to the authenticated caller's account.",
    },
    description:
      "List live client transport endpoints bound to the authenticated caller's account.",
    args: z.tuple([]),
    returns: z.array(connectedClientDescriptorSchema),
    authority: { principals: ["code", "host"] },
    access: { sensitivity: "read" },
  },
  invoke: {
    capability: "connected-client.transport",
    presentation: CONNECTED_CLIENT_TRANSPORT_PRESENTATION,
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "connectedClientTransport.control",
      rationale:
        "Carries one authenticated RPC frame to an exact live client endpoint on the caller's account; endpoint policy remains at the receiving client.",
    },
    description:
      "Invoke one receiver-owned method on an exact live client transport endpoint bound to the authenticated caller's account.",
    args: z.tuple([
      z
        .object({
          clientId: nonEmpty,
          method: nonEmpty,
          args: z.array(wireValueSchema).max(32),
        })
        .strict(),
    ]),
    returns: wireValueSchema,
    authority: { principals: ["code", "host"] },
    access: { sensitivity: "write" },
  },
});
