#!/usr/bin/env node
import {
  prepareWorkspaceRelease,
  type WorkspaceReleasePreparation,
} from "../../scripts/prepare-workspace-release.mjs";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
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

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`${path.basename(command)} exited on ${signal}`));
      if (code !== 0)
        return reject(new Error(`${path.basename(command)} exited with code ${code}`));
      resolve();
    });
  });
}

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
    await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], env);
    await run(process.execPath, ["scripts/ensure-host-build.mjs"], env);
    env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(repoRoot, "desktop");
    preparation = prepareWorkspaceRelease({
      executable: process.execPath,
      entry: path.join(env["VIBESTUDIO_HOST_ARTIFACT_ROOT"]!, "prepare-workspace-templates.mjs"),
      appRoot: repoRoot,
      output: path.join(temporaryRoot, "workspace-release"),
      scratch: path.join(temporaryRoot, "template-preparation"),
      env,
    });

    await preparation.sourcesReady;
    desktop = new DevInstanceSupervisor({
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
      forwardParentSignals: true,
    });
    const started = desktop.start();
    await Promise.race([started, preparation.completed.then(() => started)]);
    const foreground = desktop.wait();
    process.exitCode = await Promise.race([
      foreground,
      preparation.completed.then(() => foreground),
    ]);
  } catch (error) {
    retirementFailed = (error as NodeJS.ErrnoException)?.code === "EOWNERSHIP";
    launchFailure = error;
  } finally {
    try {
      // A failed retirement retains the source inputs for the still-owned
      // process. Deletion retries cannot establish that ownership has ended.
      const retirement = await Promise.allSettled([desktop?.stop(), preparation?.stop()]);
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
