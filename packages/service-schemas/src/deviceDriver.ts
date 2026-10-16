/**
 * Device drivers: the way the account's system tests reach a person's device.
 *
 * A device host (the terminal CLI, the desktop client) that the person started
 * as a test driver registers here and then answers the operations the server
 * addresses to it. A test runs an operation with `drive` and the call settles
 * only with the driver's answer, the driver's disconnect, or the caller's
 * cancellation, so a wait is always answered by the event that ends it.
 */
import { z } from "zod";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { rpcFailureSchema } from "./rpcFailure.js";

const nonEmpty = z.string().min(1);
/** The test runner is workspace code; it drives and lists the account's drivers. */
const authority: ServiceAuthorityPolicy = { principals: ["user", "code"] };
/** Only a device the person started offers itself as a driver and answers for it. */
const deviceAuthority: ServiceAuthorityPolicy = { principals: ["user"] };
const open = { sensitivity: "read" as const };
const acts = { sensitivity: "write" as const };

/** The kinds of device a driver can be: a terminal CLI host or a desktop client. */
export const deviceKindSchema = z.enum(["terminal", "desktop"]);
export type DeviceKind = z.infer<typeof deviceKindSchema>;

const WEBSITE = {
  kind: "closed",
  reason: "Device drivers belong to the account's own devices; websites have no device to drive.",
} as const;

export const deviceDriverMethods = defineServiceMethods({
  register: {
    website: WEBSITE,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "deviceDriver.register",
      rationale:
        "An authenticated device offers itself as the account's test driver for as long as its transport is live; it grants no authority",
    },
    description:
      "Offer this authenticated device as a driver of the given kind for the account's system tests.",
    args: z.tuple([z.object({ deviceKind: deviceKindSchema }).strict()]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority: deviceAuthority,
    access: open,
  },
  answer: {
    website: WEBSITE,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "deviceDriver.register",
      rationale: "The addressed driver settles exactly one operation it was asked to run",
    },
    description: "Settle one drive operation with its value or its complete failure.",
    args: z.tuple([
      z
        .object({
          callId: nonEmpty,
          outcome: z.discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
            z.object({ ok: z.literal(false), failure: rpcFailureSchema }).strict(),
          ]),
        })
        .strict(),
    ]),
    returns: z.object({ accepted: z.literal(true) }).strict(),
    authority: deviceAuthority,
    access: open,
  },
  devices: {
    website: WEBSITE,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "deviceDriver.drive",
      rationale: "Read-only discovery of the caller's live test drivers",
    },
    description: "List the authenticated user's live device drivers.",
    args: z.tuple([]),
    returns: z.array(z.object({ deviceKind: deviceKindSchema, runtimeId: nonEmpty }).strict()),
    authority,
    access: open,
  },
  drive: {
    website: WEBSITE,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "deviceDriver.drive",
      rationale:
        "Reaches only a device the person started as a test driver, for the lifetime of that driver's transport",
    },
    description:
      "Run one operation on the account's registered driver of this kind and return its value. The call settles with the driver's answer, the driver's disconnect, or the caller's cancellation.",
    args: z.tuple([
      z.object({ deviceKind: deviceKindSchema, op: nonEmpty, args: z.unknown() }).strict(),
    ]),
    returns: z.object({ value: z.unknown() }).strict(),
    authority,
    access: acts,
  },
});
