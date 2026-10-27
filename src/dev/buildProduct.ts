#!/usr/bin/env node
import type { WorkspaceReleasePreparation } from "../../scripts/prepare-workspace-release.mjs";
import * as fs from "node:fs";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, sweep } from "@vibestudio/shared/ownership";
import { ledgerDirOf } from "@vibestudio/shared/ownershipLedger";
import { LaunchTermination, joinProducer } from "./launchTermination.js";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import { hasOwnershipFailure } from "../../scripts/lib/owned-cleanup.mjs";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";
import { prepareProductRelease } from "./productRelease.js";

/**
 * Prepare this checkout's complete workspace release ahead of `pnpm start`, the
 * way the packager does for an installed product: the host build, then every
 * template runtime, built and sealed in the shared derived cache. A later
 * `pnpm start` over the same host and template sources projects that release
 * and builds nothing. Missing or stale artifacts are a launch prerequisite failure.
 */
async function main(): Promise<void> {
  const templateOptions = extractDevelopmentTemplateCheckoutArguments(process.argv.slice(2));
  if (templateOptions.forwarded.length) {
    throw new Error(`Unsupported arguments: ${templateOptions.forwarded.join(" ")}`);
  }
  const repoRoot = fs.realpathSync(process.cwd());
  const profileDir = getProfileDataPath();
  await sweep(ledgerDirOf(profileDir));
  const ownership = await Ownership.open({
    profileDir,
    lifetime: "leased",
    meta: { kind: "source-product-build" },
  });
  const termination = new LaunchTermination();
  ownership.signal.addEventListener("abort", () => termination.request("SIGTERM"), { once: true });
  let preparation: WorkspaceReleasePreparation | undefined;
  let failure: unknown;
  try {
    await prepareProductRelease({
      ownership,
      termination,
      repoRoot,
      temporaryRoot: await ownership.scratch("source-build-"),
      templateCheckouts: templateOptions.checkouts,
      register: (owned) => {
        preparation = owned;
        termination.onRequest(() => void owned.stop().catch(() => {}));
      },
    });
  } catch (error) {
    if (termination.requested && !hasOwnershipFailure(error)) {
      console.error("Interrupted.");
      process.exitCode = signalExitCode(termination.requested);
    } else {
      failure = error;
    }
  } finally {
    // The producer is joined before its scratch is retired under it.
    await joinProducer(preparation);
    try {
      await ownership.release();
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "Product build and retirement failed", {
              cause: failure,
            });
    }
    termination.dispose();
  }
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
