import { afterPack as checkElectronPackageBoundary } from "./check-electron-package-boundary.mjs";
import { prebuildReleaseUserland } from "./prebuild-release-userland.mjs";
import adhocSignMac from "./electron-adhoc-sign-mac.mjs";
import { formatRpcFailure } from "@vibestudio/rpc";
import { writeAfterPackCompletion } from "./lib/after-pack-completion.mjs";
import { failIfOperationOutlivesEventLoop } from "./lib/pending-operation-lifecycle.mjs";

/**
 * electron-builder accepts one afterPack hook, so the packaged-bundle steps are
 * sequenced here rather than competing for the same key.
 */
export async function afterPack(context) {
  try {
    await failIfOperationOutlivesEventLoop(
      completeAfterPack(context),
      `electron-builder afterPack for ${context.electronPlatformName}/${context.arch}`
    );
  } catch (error) {
    process.exitCode = 1;
    reportAfterPackFailure(error);
    throw error;
  }
}

/** Run every configured hook stage before publishing the owned completion witness. */
export async function completeAfterPack(
  context,
  {
    checkBoundary = checkElectronPackageBoundary,
    prepareUserland = prebuildReleaseUserland,
    sign = adhocSignMac,
  } = {}
) {
  // Reject a bundle that reintroduces the in-tree workspace or a Base source
  // projection before anything downstream trusts its contents.
  await checkBoundary(context);
  await prepareUserland(context);
  await checkBoundary(context);
  // Sign last: an ad-hoc signature seals exactly the bundle the check approved.
  await sign(context);
  writeAfterPackCompletion(context);
}

/** Electron-builder otherwise renders only AggregateError.message and stack. */
export function reportAfterPackFailure(error, log = console.error) {
  log(formatRpcFailure(error));
}

export default afterPack;
