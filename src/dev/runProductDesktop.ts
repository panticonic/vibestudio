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
  const forwarded = process.argv.slice(2);
  assertProductDesktopArguments(forwarded);

  const repoRoot = fs.realpathSync(process.cwd());
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-start-"));
  try {
    const needsInitialWorkspace = !profileHasWorkspace();
    const initialBase = needsInitialWorkspace
      ? ((await resolveDevelopmentBaseSelection({
          repoRoot,
          checkpointTarget: path.join(temporaryRoot, "base-checkpoint"),
        })) ?? undefined)
      : undefined;
    if (needsInitialWorkspace && !initialBase) {
      throw new Error(
        "The first source launch needs the linked development Base. Run `pnpm dev:base setup`."
      );
    }

    const env = productDesktopEnvironment({
      parent: process.env,
      repoRoot,
      ...(initialBase ? { initialBase } : {}),
    });
    await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], env);
    await run(process.execPath, ["scripts/ensure-host-build.mjs"], env);

    const desktop = new DevInstanceSupervisor({
      sourceRoot: repoRoot,
      command: process.execPath,
      args: ["scripts/run-electron.mjs", ...forwarded],
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
