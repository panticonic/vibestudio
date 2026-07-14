/**
 * autofill service method schemas.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

// `confirmSave` resolves a pending save/update prompt: "save" persists the
// credential, "never" suppresses saves for the origin, "dismiss" snoozes it.
// All three mutate stored autofill state, so it is a write side effect.
const CONFIRM_SAVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const autofillMethods = defineServiceMethods({
  confirmSave: {
    description:
      "Resolve a pending password save/update prompt for a panel: 'save' stores the credential, 'never' permanently suppresses saves for its origin, 'dismiss' snoozes the prompt.",
    args: z.tuple([z.string(), z.enum(["save", "never", "dismiss"])]),
    returns: z.void(),
    access: CONFIRM_SAVE_ACCESS,
    examples: [{ args: ["panel-abc123", "save"] }],
  },
  listSavedPasswords: {
    description:
      "List secret-free saved browser-password summaries for the trusted Credentials page.",
    args: z.tuple([]),
    returns: z.array(z.object({ id: z.number(), origin: z.string(), username: z.string() })),
    access: { sensitivity: "read" },
  },
  deleteSavedPassword: {
    description: "Delete one saved browser password by id.",
    args: z.tuple([z.number()]),
    returns: z.void(),
    access: CONFIRM_SAVE_ACCESS,
  },
  listNeverSaveOrigins: {
    description: "List sites for which browser password saving is disabled.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: { sensitivity: "read" },
  },
  removeNeverSaveOrigin: {
    description: "Allow browser password save prompts for a site again.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: CONFIRM_SAVE_ACCESS,
  },
});
