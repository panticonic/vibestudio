/**
 * settings service method schemas.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

// Pure read of the resolved settings/model-role config; touches no persistent
// state. The service-level `policy` is the enforced caller gate; `access`
// intentionally contains descriptive sensitivity metadata only.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const settingsMethods = defineServiceMethods({
  getData: {
    description:
      "Return the resolved settings snapshot, including the central-config model-role map (role → 'provider:model' string).",
    args: z.tuple([]),
    returns: z.object({ modelRoles: z.record(z.string()) }),
    access: READ_ACCESS,
  },
});
