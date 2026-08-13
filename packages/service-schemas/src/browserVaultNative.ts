import {
  defineServiceMethods,
  type MethodSchema,
  type ServiceMethodSchemas,
} from "@vibestudio/shared/typedServiceClient";
import { browserVaultMethods } from "./browserData.js";

const nativeTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "browserVaultNative.host",
  rationale:
    "Protected browser material is reachable only by authenticated host code; workspace code has no route to this service.",
};

/**
 * Mechanical host route to BrowserVaultDO. This deliberately reuses only the
 * receiver's wire validators. It does not inherit the receiver's workspace
 * capability or prompt policy.
 */
export const browserVaultNativeMethods = defineServiceMethods(
  Object.fromEntries(
    Object.entries(browserVaultMethods).map(([name, receiver]) => [
      name,
      {
        description: receiver.description,
        args: receiver.args,
        returns: receiver.returns,
        tier: nativeTier,
        authority: { principals: ["host"] },
        access: receiver.access,
        agentFacing: false,
      } satisfies MethodSchema,
    ])
  ) as ServiceMethodSchemas
);
