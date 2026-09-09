import { afterPack as checkElectronPackageBoundary } from "./check-electron-package-boundary.mjs";
import adhocSignMac from "./electron-adhoc-sign-mac.mjs";

/**
 * electron-builder accepts one afterPack hook, so the packaged-bundle steps are
 * sequenced here rather than competing for the same key.
 */
export async function afterPack(context) {
  // Reject a bundle that reintroduces the in-tree workspace or a Base source
  // projection before anything downstream trusts its contents.
  await checkElectronPackageBoundary(context);
  // Sign last: an ad-hoc signature seals exactly the bundle the check approved.
  await adhocSignMac(context);
}

export default afterPack;
