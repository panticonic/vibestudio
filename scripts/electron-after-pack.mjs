import { afterPack as checkElectronPackageBoundary } from "./check-electron-package-boundary.mjs";
import { prebuildReleaseUserland } from "./prebuild-release-userland.mjs";
import adhocSignMac from "./electron-adhoc-sign-mac.mjs";
import { formatRpcFailure } from "@vibestudio/rpc";

/**
 * electron-builder accepts one afterPack hook, so the packaged-bundle steps are
 * sequenced here rather than competing for the same key.
 */
export async function afterPack(context) {
  try {
    // Reject a bundle that reintroduces the in-tree workspace or a Base source
    // projection before anything downstream trusts its contents.
    await checkElectronPackageBoundary(context);
    await prebuildReleaseUserland(context);
    await checkElectronPackageBoundary(context);
    // Sign last: an ad-hoc signature seals exactly the bundle the check approved.
    await adhocSignMac(context);
  } catch (error) {
    reportAfterPackFailure(error);
    throw error;
  }
}

/** Electron-builder otherwise renders only AggregateError.message and stack. */
export function reportAfterPackFailure(error, log = console.error) {
  log(formatRpcFailure(error));
}

export default afterPack;
