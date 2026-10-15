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
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { LaunchTermination, joinProducer, runOwnedChild } from "./launchTermination.js";
import { signalExitCode } from "../../scripts/run-electron-lifecycle.mjs";
import { resolveDevelopmentTemplateSet } from "./developmentTemplateSet.js";
import {
  assertProductDesktopArguments,
  productDesktopEnvironment,
} from "./productDesktopLaunch.js";
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

async function main(): Promise<void> {
  assertProductDesktopArguments(process.argv.slice(2));
  const templateOptions = extractDevelopmentTemplateCheckoutArguments(process.argv.slice(2));
  const forwarded = templateOptions.forwarded;

  const repoRoot = fs.realpathSync(process.cwd());
  // From here this launcher owns state; a termination request must reach the
  // cleanup below, not end the process before it.
  const termination = new LaunchTermination();
  const scratchParent = path.join(getProfileDataPath(), "source-launches");
  fs.mkdirSync(scratchParent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(scratchParent, "launch-"));
  let desktop: DevInstanceSupervisor | undefined;
  let preparation: WorkspaceReleasePreparation | undefined;
  let retirementFailed = false;
  let launchFailure: unknown;
  let retirementFailure: unknown;
  try {
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

    const env = productDesktopEnvironment({
      parent: process.env,
      repoRoot,
      defaultTemplates,
      bootstrapSystem: needsInitialWorkspace,
      ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
    });
    await runOwnedChild(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], {
      env,
      termination,
    });
    await runOwnedChild(process.execPath, ["scripts/ensure-host-build.mjs"], { env, termination });
    env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(repoRoot, "desktop");
    termination.signal.throwIfAborted();
    const owned = prepareWorkspaceRelease({
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
    const supervisor = new DevInstanceSupervisor({
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
    retirementFailed = (error as NodeJS.ErrnoException)?.code === "EOWNERSHIP";
    if (termination.requested && !retirementFailed) {
      // A requested stop is not a launch failure; the cleanup below still runs.
      console.error("Interrupted.");
      process.exitCode = signalExitCode(termination.requested);
    } else {
      launchFailure = error;
    }
  } finally {
    try {
      // A failed retirement retains the source inputs for the still-owned
      // process. Deletion retries cannot establish that ownership has ended.
      const retirement = await Promise.allSettled([desktop?.stop(), joinProducer(preparation)]);
      const failure = retirement.find((result) => result.status === "rejected");
      if (!retirementFailed && !failure) fs.rmSync(temporaryRoot, { recursive: true, force: true });
      if (failure?.status === "rejected") retirementFailure = failure.reason;
    } catch (error) {
      retirementFailure ??= error;
    } finally {
      try {
        await desktop?.close();
      } catch (error) {
        retirementFailure ??= error;
      }
      termination.dispose();
    }
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

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
