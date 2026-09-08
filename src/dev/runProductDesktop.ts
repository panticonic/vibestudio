#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { resolveDevelopmentBaseSelection } from "./developmentBaseSelection.js";
import {
  assertProductDesktopArguments,
  productDesktopEnvironment,
} from "./productDesktopLaunch.js";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";
import { inspectWorkspaceSources } from "../workspaceTemplateSource.js";
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
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-start-"));
  try {
    const needsInitialWorkspace = !profileHasWorkspace();
    const distributions =
      (await resolveDevelopmentBaseSelection({
        repoRoot,
        checkpointTarget: path.join(temporaryRoot, "workspace-distributions"),
      })) ?? undefined;
    if (!distributions) {
      throw new Error(
        "A source product launch needs the linked development Base. Run `pnpm dev:base setup`."
      );
    }
    const developmentTemplates = await inspectWorkspaceSources({
      checkouts: templateOptions.checkouts,
      checkpointRoot: path.join(temporaryRoot, "template-checkpoints"),
    });

    const env = productDesktopEnvironment({
      parent: process.env,
      repoRoot,
      distributions,
      bootstrapSystem: needsInitialWorkspace,
      ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
    });
    await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], env);
    await run(process.execPath, ["scripts/ensure-host-build.mjs"], env);

    const desktop = new DevInstanceSupervisor({
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
    await desktop.start();
    process.exitCode = await desktop.wait();
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
