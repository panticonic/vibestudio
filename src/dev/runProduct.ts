#!/usr/bin/env node
import {
  prepareWorkspaceRelease,
  type WorkspaceReleasePreparation,
} from "../../scripts/prepare-workspace-release.mjs";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, sweep } from "@vibestudio/shared/ownership";
import { ledgerDirOf } from "@vibestudio/shared/ownershipLedger";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { LaunchTermination, joinProducer, runOwnedChild } from "./launchTermination.js";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import { hasOwnershipFailure } from "../../scripts/lib/owned-cleanup.mjs";
import { resolveDevelopmentTemplateSet } from "./developmentTemplateSet.js";
import { assertProductLaunchArguments, productLaunchEnvironment } from "./productLaunch.js";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";
import {
  inspectWorkspaceSources,
  workspaceSourceFromCheckout,
} from "../workspaceTemplateSource.js";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";

function profileHasWorkspace(): boolean {
  const centralData = new CentralDataManager({
    databasePath: path.join(getProfileDataPath(), "server-auth", "identity.db"),
  });
  try {
    return centralData.listWorkspaces().length > 0;
  } finally {
    centralData.close();
  }
}

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
    const needsInitialWorkspace = !profileHasWorkspace();
    const defaultTemplates =
      (await resolveDevelopmentTemplateSet({
        repoRoot,
        checkpointRoot: path.join(temporaryRoot, "default-template-checkpoints"),
      })) ?? undefined;
    if (!defaultTemplates) {
      throw new Error(
        "A source product launch needs the canonical template checkouts. Run `pnpm dev:templates setup`."
      );
    }
    const developmentTemplates = await inspectWorkspaceSources({
      sources: templateOptions.checkouts.map(workspaceSourceFromCheckout),
      checkpointRoot: path.join(temporaryRoot, "template-checkpoints"),
    });

    const env = productLaunchEnvironment({
      parent: process.env,
      repoRoot,
      defaultTemplates,
      bootstrapSystem: needsInitialWorkspace,
      ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
    });
    await runOwnedChild(
      ownership,
      process.execPath,
      ["scripts/native-host-dependencies.mjs", "--repair"],
      { env, termination }
    );
    await runOwnedChild(ownership, process.execPath, ["scripts/ensure-host-build.mjs"], {
      env,
      termination,
    });
    env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(repoRoot, "desktop");
    termination.signal.throwIfAborted();
    const owned = prepareWorkspaceRelease({
      ownership,
      executable: process.execPath,
      entry: path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "prepare-workspace-templates.mjs"),
      appRoot: repoRoot,
      output: path.join(temporaryRoot, "workspace-release"),
      scratch: path.join(temporaryRoot, "template-preparation"),
      env,
    });
    preparation = owned;
    // The cleanup below joins the same stop and reports its failure.
    termination.onRequest(() => void owned.stop().catch(() => {}));
    await owned.completed;
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
