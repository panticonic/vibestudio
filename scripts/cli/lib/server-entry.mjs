import path from "node:path";
import { readCurrentHostBuildGeneration } from "../../host-build-generations.mjs";

export function serverEntryArg(repoRoot = process.cwd()) {
  const root =
    process.env.VIBESTUDIO_SERVER_ENTRY === "live"
      ? readCurrentHostBuildGeneration(repoRoot, "source")
      : path.join(repoRoot, "dist");
  return path.join(root, "server.mjs");
}

export function createServerInvocation(serverArgs) {
  return { command: process.execPath, args: serverArgs };
}
