import * as path from "node:path";
import { getWorkspaceDir } from "@vibestudio/env-paths";

/** Hub-owned durable Iroh identity for one advertised workspace child. */
export function workspaceIrohReachPaths(workspaceName: string) {
  const root = path.join(getWorkspaceDir(workspaceName), "reach", "iroh");
  return { root, identityFile: path.join(root, "endpoint.key") } as const;
}
