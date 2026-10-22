#!/usr/bin/env node
import type { WorkspaceReleasePreparation } from "../../scripts/prepare-workspace-release.mjs";
import * as fs from "node:fs";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, sweep } from "@vibestudio/shared/ownership";
import { ledgerDirOf } from "@vibestudio/shared/ownershipLedger";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { LaunchTermination, joinProducer } from "./launchTermination.js";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import { hasOwnershipFailure } from "../../scripts/lib/owned-cleanup.mjs";
import { assertProductLaunchArguments } from "./productLaunch.js";
import { prepareProductRelease } from "./productRelease.js";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";

/**
 * Build this checkout and run it with installed-product semantics: the
 * ordinary profile, production runtime behavior and the canonical templates.
 * `desktop` opens the desktop app (`pnpm start`); `terminal` opens the
 * product's own `vibestudio terminal` (`pnpm start:terminal`), which starts or
 * reuses the profile's local server exactly as an installation does.
 */
async function main(): Promise<void> {
  const surface = process.argv[2];
  if (surface !== "desktop" && surface !== "terminal") {
    throw new Error("usage: runProduct.ts desktop|terminal [options]");
  }
  const argv = process.argv.slice(3);
  assertProductLaunchArguments(argv, surface);
  const templateOptions = extractDevelopmentTemplateCheckoutArguments(argv);
  const forwarded = templateOptions.forwarded;

  const repoRoot = fs.realpathSync(process.cwd());
  const profileDir = getProfileDataPath();
  // Whatever an earlier launcher that died left behind is retired first.
  await sweep(ledgerDirOf(profileDir));
  // Everything this launch starts or creates is owned by its ownership: the
  // scratch root and every process are retired by its reaper, whether this
  // launcher finishes or is killed. A termination request must reach the
  // cleanup below, not end the process before it.
  const ownership = await Ownership.open({
    profileDir,
    lifetime: "leased",
    meta: { kind: "source-product-launch", surface },
  });
  const termination = new LaunchTermination();
  ownership.signal.addEventListener("abort", () => termination.request("SIGTERM"), { once: true });
  let desktop: DevInstanceSupervisor | undefined;
  let preparation: WorkspaceReleasePreparation | undefined;
  let launchFailure: unknown;
  let retirementFailure: unknown;
  try {
    const temporaryRoot = await ownership.scratch("source-launch-");
    const { env, developmentTemplates } = await prepareProductRelease({
      ownership,
      termination,
      repoRoot,
      temporaryRoot,
      templateCheckouts: templateOptions.checkouts,
      register: (owned) => {
        preparation = owned;
        // The cleanup below joins the same stop and reports its failure.
        termination.onRequest(() => void owned.stop().catch(() => {}));
      },
    });
    termination.signal.throwIfAborted();
    if (surface === "terminal") {
      process.exitCode = await runProductTerminal(env, forwarded);
      return;
    }
    const supervisor = new DevInstanceSupervisor({
      ownership,
      label: "desktop",
      sourceRoot: repoRoot,
      command: process.execPath,
      args: [
        "scripts/run-electron.mjs",
        ...forwarded,
        ...(developmentTemplates[0]
          ? [
              createShellSurfaceLink({
                kind: "workspace-chooser",
                template: developmentTemplates[0].pin,
              }),
            ]
          : []),
      ],
      env,
      stdio: "inherit",
    });
    desktop = supervisor;
    termination.onRequest((signal) => void supervisor.stop(signal).catch(() => {}));
    await supervisor.start();
    const foreground = desktop.wait();
    process.exitCode = await foreground;
  } catch (error) {
    if (termination.requested && !hasOwnershipFailure(error)) {
      // A requested stop is not a launch failure; the cleanup below still runs.
      console.error("Interrupted.");
      process.exitCode = signalExitCode(termination.requested);
    } else {
      launchFailure = error;
    }
  } finally {
    // The desktop and the producer are stopped and joined before their
    // scratch is retired under them.
    const retirement = await Promise.allSettled([desktop?.stop(), joinProducer(preparation)]);
    const stopFailure = retirement.find((result) => result.status === "rejected");
    if (stopFailure?.status === "rejected") retirementFailure = stopFailure.reason;
    try {
      await ownership.release();
    } catch (error) {
      retirementFailure =
        retirementFailure === undefined
          ? error
          : new AggregateError([retirementFailure, error], "Source launch retirement failed", {
              cause: retirementFailure,
            });
    }
    termination.dispose();
  }
  if (retirementFailure) {
    if (launchFailure && launchFailure !== retirementFailure)
      throw Object.assign(
        new AggregateError(
          [launchFailure, retirementFailure],
          "Workspace launch and retirement failed"
        ),
        {
          code: (retirementFailure as NodeJS.ErrnoException).code,
          cause: launchFailure,
        }
      );
    throw retirementFailure;
  }
  if (launchFailure) throw launchFailure;
}

/**
 * The product's `vibestudio terminal`, in this process: the browser must own
 * this terminal, which a supervised child in its own process group cannot
 * read. It sees the prepared environment exactly as an installed CLI would,
 * and starts and stops the profile's local server itself.
 */
async function runProductTerminal(env: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  const { main: runCli } = await import("../cli/client.js");
  return await runCli(["terminal", ...args]);
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
