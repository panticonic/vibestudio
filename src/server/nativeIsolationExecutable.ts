import { getPhysicalAppPath } from "@vibestudio/shared/runtimePaths";
import targets from "../../native/isolation/targets.json";

export function nativeIsolationExecutable(
  appRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): string {
  const target = targets.find((entry) => entry.platform === platform && entry.arch === arch);
  if (!target) throw new Error(`Unsupported native isolation target: ${platform}-${arch}`);
  return getPhysicalAppPath(appRoot, target.artifact);
}
