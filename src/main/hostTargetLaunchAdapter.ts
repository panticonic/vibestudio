import { HostTargetLaunchResultSchema } from "@vibestudio/service-schemas/workspace";
import type { AppAvailableEvent } from "./appOrchestrator.js";

export interface ReadyElectronLaunchAdapterOptions {
  resolveArtifactRoute(route: string): string | null;
  warn(message: string): void;
}

/**
 * Convert the validated ready-launch wire contract into the event consumed by
 * the Electron app host. Execution authority is part of the selected artifact,
 * so this projection must carry it losslessly with the artifact identity.
 */
export function readyElectronLaunchEvent(
  result: unknown,
  options: ReadyElectronLaunchAdapterOptions
): AppAvailableEvent | null {
  const parsed = HostTargetLaunchResultSchema.safeParse(result);
  if (!parsed.success) {
    const status =
      typeof result === "object" && result !== null
        ? (result as Record<string, unknown>)["status"]
        : undefined;
    if (status === "ready") {
      options.warn("Electron host target returned an invalid ready-launch contract");
    }
    return null;
  }

  const launch = parsed.data;
  if (launch.status !== "ready" || launch.target !== "electron") return null;
  if (!launch.artifactRoute) {
    options.warn("Electron host target is ready but did not include an app artifact route");
    return null;
  }
  const url = options.resolveArtifactRoute(launch.artifactRoute);
  if (!url) return null;

  return {
    appId: launch.appId,
    source: launch.source,
    target: "electron",
    url,
    artifactRoute: launch.artifactRoute,
    capabilities: launch.capabilities ?? [],
    buildKey: launch.buildKey,
    effectiveVersion: launch.effectiveVersion ?? null,
    executionDigest: launch.executionDigest,
    authorityRequests: launch.authorityRequests,
    authorityEvalCeilings: launch.authorityEvalCeilings,
    adoptionPolicy: launch.adoptionPolicy ?? "immediate",
    selectedForHost: true,
  };
}
