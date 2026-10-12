import { writeAfterPackCompletion } from "./lib/after-pack-completion.mjs";

/**
 * electron-builder accepts one afterPack hook, so the packaged-bundle steps are
 * sequenced here rather than competing for the same key.
 */
export async function afterPack(context) {
  try {
    const { failIfOperationOutlivesEventLoop } =
      await import("./lib/pending-operation-lifecycle.mjs");
    await failIfOperationOutlivesEventLoop(
      completeAfterPack(context),
      `electron-builder afterPack for ${context.electronPlatformName}/${context.arch}`
    );
  } catch (error) {
    process.exitCode = 1;
    try {
      await reportAfterPackFailure(error);
    } catch (diagnosticError) {
      // The formatter itself may be unavailable when a build dependency failed
      // to load. Reporting must never replace the failure from the hook.
      console.error(error);
      console.error("Failed to format electron afterPack error", diagnosticError);
    }
    throw error;
  }
}

/** Run every configured hook stage before publishing the owned completion witness. */
export async function completeAfterPack(context, overrides = {}) {
  // electron-builder imports this module even for --prepackaged, where it
  // skips afterPack. Keep application-build dependencies out of that import.
  const imports = await Promise.allSettled([
    overrides.checkBoundary ? undefined : import("./check-electron-package-boundary.mjs"),
    overrides.prepareUserland ? undefined : import("./prebuild-release-userland.mjs"),
    overrides.sign ? undefined : import("./electron-adhoc-sign-mac.mjs"),
  ]);
  const failures = imports
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, "Could not load electron afterPack stages");
  const [boundary, release, signing] = imports.map((result) => result.value);
  const checkBoundary = overrides.checkBoundary ?? boundary.afterPack;
  const prepareUserland = overrides.prepareUserland ?? release.prebuildReleaseUserland;
  const sign = overrides.sign ?? signing.default;
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
export async function reportAfterPackFailure(error, log = console.error) {
  const { formatRpcFailure } = await import("@vibestudio/rpc");
  log(formatRpcFailure(error));
}

export default afterPack;
