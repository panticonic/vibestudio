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
    capability: "browser-passwords.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "autofill.control",
      rationale: "Stores or suppresses a credential only after an explicit browser save prompt.",
    },
    presentation: {
      title: "Save this password choice",
      action: "save this password choice",
      description:
        "Allows {requesterKind} to save a password or remember that password saving is disabled for this site.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "manage",
      },
    },
    description:
      "Resolve a pending password save/update prompt for a panel: 'save' stores the credential, 'never' permanently suppresses saves for its origin, 'dismiss' snoozes the prompt.",
    args: z.tuple([z.string(), z.enum(["save", "never", "dismiss"])]),
    returns: z.void(),
    access: CONFIRM_SAVE_ACCESS,
    examples: [{ args: ["panel-abc123", "save"] }],
  },
  confirmFormFill: {
    capability: "browser-form-fill.manage",
    tier: {
      tier: "gated",
      session: "family",
      residency: "native-effect",
      family: "autofill.control",
      rationale:
        "Stores personal form-fill values only after an explicit post-submission browser prompt.",
    },
    presentation: {
      title: "Save form-fill values",
      action: "save personal form-fill values",
      description:
        "Allows {requesterKind} to save the personal form values shown in a browser submission prompt.",
      group: "credentials",
      authorityCategory: {
        domain: "accounts",
        verb: "act",
      },
    },
    description:
      "Resolve a pending structured form-fill learning prompt. Values remain in trusted main-process memory until this call.",
    args: z.tuple([z.string(), z.enum(["save", "dismiss"])]),
    returns: z.void(),
    access: CONFIRM_SAVE_ACCESS,
    examples: [{ args: ["panel-abc123", "save"] }],
  },
});
