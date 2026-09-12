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

/**
 * Product conduits this workspace runs at a version the blessing does not
 * cover.
 *
 * A conduit's blessing is keyed to an exact effective version, and that version
 * covers the unit's whole dependency closure — so a blessing resolved against a
 * tree that omits part of that closure matches nothing the workspace ever runs.
 * The failure is silent by construction: the code simply stops being trusted to
 * attest context, and the first symptom arrives much later, in whatever
 * operation needed that attestation. Naming the mismatch where it is created
 * turns that into one readable line.
 *
 * A workspace running its own edited copy of a conduit appears here too, and
 * legitimately: that code is workspace source, not the product's, and refusing
 * it is the policy working. This reports the state; it does not decide it.
 */
export function unblessedLiveConduits(input: {
  units: readonly string[];
  liveVersion: (repoPath: string) => string | null;
  isBlessed: (identity: ConduitIdentity) => boolean;
}): Array<{ repoPath: string; effectiveVersion: string }> {
  return input.units.flatMap((repoPath) => {
    const effectiveVersion = input.liveVersion(repoPath);
    // A unit absent from this distribution is not a mismatch; the product
    // policy is an allowlist, not a manifest of what every root ships.
    if (!effectiveVersion) return [];
    if (input.isBlessed({ repoPath, effectiveVersion })) return [];
    return [{ repoPath, effectiveVersion }];
  });
}
