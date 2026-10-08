import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import semver from "semver";
import { appCompatibilityError } from "@vibestudio/workspace-contracts/appCompatibility";

export const HISTORICAL_HOST_MARKER = "workspace-host.json";
export const WORKSPACE_EPOCH_HANDOFF_EXIT_CODE = 75;

const HistoricalWorkspaceHostMarkerSchema = z
  .object({
    version: z.literal(2),
    systemEpoch: z.number().int().nonnegative(),
    appVersion: z.string().refine((value) => semver.valid(value) !== null),
    executable: z.string().min(1),
    runtimeMode: z.enum(["node", "electron-node"]),
    serverEntry: z.string().min(1),
    appRoot: z.string().min(1),
  })
  .strict();

export interface WorkspaceHostLaunchSet {
  systemEpoch: number;
  appVersion: string;
  executable: string;
  serverEntry: string;
  appRoot: string;
  historical: boolean;
  runtimeMode: "node" | "electron-node";
}

export function semverMajor(version: string): number {
  if (!semver.valid(version)) throw new Error(`Invalid Vibestudio application SemVer: ${version}`);
  return semver.major(version);
}

export function requireCompatibleTransitionHost(input: {
  requirement: { systemEpoch: number; minimumAppVersion?: string };
  currentAppVersion: string;
  historical(epoch: number): WorkspaceHostLaunchSet;
}): string {
  const appVersion =
    semverMajor(input.currentAppVersion) === input.requirement.systemEpoch
      ? input.currentAppVersion
      : input.historical(input.requirement.systemEpoch).appVersion;
  const error = appCompatibilityError(input.requirement, appVersion);
  if (error) throw new Error(error);
  return appVersion;
}

function resolveInside(root: string, relative: string, label: string): string {
  if (path.isAbsolute(relative)) throw new Error(`Historical host ${label} must be relative`);
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`Historical host ${label} escapes its root`);
  if (!fs.existsSync(resolved)) throw new Error(`Historical host ${label} is missing: ${resolved}`);
  return resolved;
}

export function resolveHistoricalWorkspaceHost(
  hostVersionsRoot: string,
  systemEpoch: number
): WorkspaceHostLaunchSet {
  const root = path.join(hostVersionsRoot, String(systemEpoch));
  const markerPath = path.join(root, HISTORICAL_HOST_MARKER);
  try {
    const marker = HistoricalWorkspaceHostMarkerSchema.parse(
      JSON.parse(fs.readFileSync(markerPath, "utf8"))
    );
    if (marker.systemEpoch !== systemEpoch || semverMajor(marker.appVersion) !== systemEpoch) {
      throw new Error("Retained host marker has inconsistent versions");
    }
    return {
      systemEpoch,
      appVersion: marker.appVersion,
      executable: resolveInside(root, marker.executable, "executable"),
      serverEntry: resolveInside(root, marker.serverEntry, "server entry"),
      appRoot: resolveInside(root, marker.appRoot, "app root"),
      historical: true,
      runtimeMode: marker.runtimeMode,
    };
  } catch (error) {
    throw new Error(
      `Historical workspace host ${systemEpoch} is unavailable or invalid. This workspace requires Vibestudio ${systemEpoch}.x. Restore its retained installation or ask an agent in another workspace to help plan a migration.`,
      { cause: error }
    );
  }
}
