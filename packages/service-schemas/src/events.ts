/**
 * Wire schema for the "events" subscription service.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/servicePolicy";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

export {
  readEventWatchRecords,
  type EventWatchRecord,
} from "@vibestudio/shared/events";

// Opening a watch mutates activation-local resource ownership.
const SUBSCRIBE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const eventsMethods = defineServiceMethods({
  watch: {
    description:
      "Open a response stream for named events. The response body owns the subscription and cancelling it is the only unsubscribe operation.",
    args: z.tuple([z.array(z.string()).min(1), z.string().min(1)]),
    access: SUBSCRIBE_ACCESS,
    examples: [{ args: [["panel-tree-updated"], "watch-7f4f"] }],
  },
});
