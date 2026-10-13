import type { StoredBuildResult } from "./buildStore.js";

/** The build provider that produced a native (React Native) app artifact. */
export interface AppBuildProviderDetails {
  name: string;
  activeEv: string | null;
  activeBuildKey: string | null;
  contractVersion: string;
}

export type AppBuildTarget = "electron" | "react-native" | "terminal";

export function isBuildProviderDetailsLike(value: unknown): value is AppBuildProviderDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppBuildProviderDetails>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    (typeof candidate.activeEv === "string" || candidate.activeEv === null) &&
    (typeof candidate.activeBuildKey === "string" || candidate.activeBuildKey === null) &&
    typeof candidate.contractVersion === "string" &&
    candidate.contractVersion.length > 0
  );
}

const TARGET_LABEL: Record<AppBuildTarget, string> = {
  electron: "Electron",
  "react-native": "React Native",
  terminal: "Terminal",
};

/**
 * The artifact contract of an app target. It is the single definition of a
 * runnable app build: the builder enforces it on every build it produces, so a
 * violating candidate is refused by the protected-main build gate, and the app
 * host enforces the same function on builds it did not produce itself
 * (installed releases, history), so nothing can be activated that the gate
 * would have refused. Each failure names the app, the target and the defect.
 */
export function validateAppBuildContract(
  appName: string,
  target: AppBuildTarget,
  build: Pick<StoredBuildResult, "metadata" | "artifacts">
): void {
  const label = `${TARGET_LABEL[target]} app ${appName}`;
  const digest = build.metadata.execution?.executionDigest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${label} build is missing a sealed execution identity`);
  }
  const details = build.metadata.details;
  if (details.kind !== "app" || details.target !== target) {
    throw new Error(`${label} build is missing ${target} app metadata`);
  }
  const primaries = (build.artifacts ?? []).filter((artifact) => artifact.role === "primary");
  if (target === "terminal") {
    if (primaries.length !== 1) {
      throw new Error(`${label} build must include exactly one primary entry artifact`);
    }
    if (!primaries[0]?.path.endsWith(".mjs")) {
      throw new Error(`${label} primary artifact must be an ESM .mjs entry`);
    }
    return;
  }
  if (target !== "react-native") return;
  if (
    typeof details.rnHostAbi !== "string" ||
    details.rnHostAbi.length === 0 ||
    typeof details.integrity !== "string" ||
    details.integrity.length === 0 ||
    !isBuildProviderDetailsLike(details.provider)
  ) {
    throw new Error(
      `${label} build is missing signed RN metadata or provider identity: the build provider must report rnHostAbi and identify itself`
    );
  }
  if (primaries.length === 0) {
    throw new Error(`${label} build has no primary mobile artifact`);
  }
  const seenPlatforms = new Set<"android" | "ios">();
  for (const artifact of primaries) {
    if (artifact.platform !== "android" && artifact.platform !== "ios") {
      throw new Error(`${label} primary artifact ${artifact.path} is missing a mobile platform`);
    }
    if (seenPlatforms.has(artifact.platform)) {
      throw new Error(`${label} has multiple primary artifacts for ${artifact.platform}`);
    }
    if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0) {
      throw new Error(`${label} primary artifact ${artifact.path} is missing integrity`);
    }
    seenPlatforms.add(artifact.platform);
  }
}
