import type { Ownership } from "@vibestudio/shared/ownership";
import type { inspectDeploymentIdentity } from "../cli/remote-deployment-workflow.mjs";

export function requireInstalledDeploymentPackage(appRoot: string, options?: {nativeReference?: boolean}): Promise<void>;
export function openOwnedDeploymentTarget(options: {
  appRoot: string;
  nativeReference?: boolean;
  ownership: Ownership;
  scratchRoot: string;
  signal: AbortSignal;
}): Promise<{
  observe(): ReturnType<typeof inspectDeploymentIdentity>;
  start(label: string): Promise<void>;
  close(): Promise<void>;
}>;
