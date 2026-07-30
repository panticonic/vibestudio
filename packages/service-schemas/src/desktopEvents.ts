import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { eventsMethods } from "./events.js";

/** Electron-owned event projection. It shares the watch wire shape with the
 * server event bus but has its own host-residency declaration. */
export const desktopEventsMethods = defineServiceMethods({
  watch: {
    ...eventsMethods.watch,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "desktopEvents.control",
      rationale: "Open bias: no C1-C4 or G1-G5 rule applies; §2 default {code, session} family",
    },
  },
});
