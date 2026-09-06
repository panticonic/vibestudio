import * as fs from "node:fs";
import * as path from "node:path";
import { assertMxcPrerequisites } from "@vibestudio/process-adapter/mxc";
import { resolveClaudeRuntimeCommand, confineClaudeReadOnly } from "./claudeReadOnlyLaunch.js";
import {
  collectInstalledRuntimeReadRoots,
  getMxcExecutable,
  getPhysicalAppPath,
} from "./runtimePaths.js";
import type { MaterializedClaudeLaunch, ClaudeCliInvocation } from "./claudeLaunchProfile.js";
export function installedClaudeCli(
  appRoot = process.env["VIBESTUDIO_APP_ROOT"]
): ClaudeCliInvocation {
  if (!appRoot) throw new Error("Linked Claude requires the installed Vibestudio application");
  const entry = getPhysicalAppPath(appRoot, "dist/cli/client.mjs");
  fs.accessSync(entry, fs.constants.R_OK);
  if (!fs.statSync(entry).isFile()) throw new Error("Installed Claude CLI entry must be a file");
  return {
    command: process.execPath,
    args: [entry],
    environment: {
      VIBESTUDIO_APP_ROOT: appRoot,
      ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
}
/** Trusted installed launch preparation shared by CLI and host receiver. */
export async function prepareInstalledClaudeLaunch(
  launch: MaterializedClaudeLaunch,
  contextDirectory: string,
  appRoot = process.env["VIBESTUDIO_APP_ROOT"]
) {
  if (!appRoot) throw new Error("Linked Claude requires the installed Vibestudio launcher");
  const executableAlias = resolveClaudeRuntimeCommand(launch.argv[0]!);
  const executable = fs.realpathSync(executableAlias);
  const report = process.report.getReport() as unknown as { sharedObjects?: unknown };
  const sharedObjects = Array.isArray(report.sharedObjects)
    ? report.sharedObjects
        .filter((value): value is string => typeof value === "string" && path.isAbsolute(value))
        .map((value) => path.normalize(value))
    : [];
  const confined = confineClaudeReadOnly({
    argv: [executable, ...launch.argv.slice(1)],
    launcher: getMxcExecutable(appRoot),
    readPaths: [
      ...new Set([
        getPhysicalAppPath(appRoot, ""),
        ...collectInstalledRuntimeReadRoots([executableAlias, process.execPath, ...sharedObjects]),
      ]),
    ],
    launchEnv: launch.env,
    profileDir: launch.profileDir,
    contextDirectory,
  });
  await assertMxcPrerequisites({
    platform: process.platform as "linux" | "darwin" | "win32",
    launcher: confined.command,
    environment: confined.env,
  });
  return confined;
}
