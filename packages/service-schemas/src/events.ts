/**
 * Wire schema for the "events" subscription service.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export { readEventWatchRecords, type EventWatchRecord } from "@vibestudio/shared/events";

// Opening a watch mutates activation-local resource ownership.
const SUBSCRIBE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const eventsMethods = defineServiceMethods({
  watch: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "events.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
    description:
      "Open a response stream for named events. The response body owns the subscription and cancelling it is the only unsubscribe operation.",
    args: z.tuple([z.array(z.string()).min(1), z.string().min(1)]),
    access: SUBSCRIBE_ACCESS,
    examples: [{ args: [["panel-tree-invalidated"], "watch-7f4f"] }],
  },
});
