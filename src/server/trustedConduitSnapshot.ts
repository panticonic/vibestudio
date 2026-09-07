import {
  sameWorkspaceTemplatePin,
  type DefaultWorkspaceTemplates,
} from "@vibestudio/workspace/baseTemplateRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import type { BuildUnitResolution } from "./buildV2/index.js";
import type { ConduitIdentity } from "./services/conduitBlessingStore.js";
import { PRODUCT_CONDUIT_UNITS } from "./productConduitPolicy.js";

/** App-authored initial snapshots never define which code can attest context. */
export function trustedConduitTemplate(
  root: WorkspaceTemplatePin,
  defaults: DefaultWorkspaceTemplates
): WorkspaceTemplatePin {
  return (
    [defaults.system, defaults.personal].find((pin) => sameWorkspaceTemplatePin(pin, root)) ??
    defaults.base
  );
}

/** The product policy is an allowlist, not a requirement to ship every harness in every distribution. */
export async function resolveTrustedConduits(
  stateHash: string,
  resolve: (paths: readonly string[], state: string) => Promise<Array<BuildUnitResolution | null>>
): Promise<ConduitIdentity[]> {
  const resolved = await resolve(PRODUCT_CONDUIT_UNITS, stateHash);
  if (resolved.length !== PRODUCT_CONDUIT_UNITS.length)
    throw new Error("Incomplete trusted conduit resolution");
  return resolved.flatMap((unit, index) => {
    if (!unit) return [];
    if (unit.kind !== "worker" || unit.unitPath !== PRODUCT_CONDUIT_UNITS[index]) {
      throw new Error(
        `Trusted conduit ${PRODUCT_CONDUIT_UNITS[index]} must resolve to its exact worker unit`
      );
    }
    return [{ repoPath: unit.unitPath, effectiveVersion: unit.effectiveVersion }];
  });
}
