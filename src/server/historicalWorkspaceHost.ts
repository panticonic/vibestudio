import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import semver from "semver";

export const HISTORICAL_HOST_MARKER = "workspace-host.json";
export const WORKSPACE_EPOCH_HANDOFF_EXIT_CODE = 75;

const HistoricalWorkspaceHostMarkerSchema = z
  .object({
    version: z.literal(1),
    systemEpoch: z.number().int().nonnegative(),
    appVersion: z.string().refine((value) => semver.valid(value) !== null),
    executable: z.string().min(1),
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
}

export function semverMajor(version: string): number {
  if (!semver.valid(version)) throw new Error(`Invalid Vibestudio application SemVer: ${version}`);
  return semver.major(version);
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
  let marker: z.infer<typeof HistoricalWorkspaceHostMarkerSchema>;
  try {
    marker = HistoricalWorkspaceHostMarkerSchema.parse(
      JSON.parse(fs.readFileSync(markerPath, "utf8"))
    );
  } catch (error) {
    throw new Error(`Historical workspace host ${systemEpoch} is unavailable or invalid`, {
      cause: error,
    });
  }
  if (marker.systemEpoch !== systemEpoch || semverMajor(marker.appVersion) !== systemEpoch) {
    throw new Error(`Historical workspace host ${systemEpoch} marker has inconsistent versions`);
  }
  return {
    systemEpoch,
    appVersion: marker.appVersion,
    executable: resolveInside(root, marker.executable, "executable"),
    serverEntry: resolveInside(root, marker.serverEntry, "server entry"),
    appRoot: resolveInside(root, marker.appRoot, "app root"),
    historical: true,
  };
}
