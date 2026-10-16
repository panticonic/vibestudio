import type { ClientRuntime } from "@vibestudio/workspace-contracts/clients";
import type { StoredBuildResult } from "../buildV2/buildStore.js";

/** The build provider that produced a client artifact (React Native's Metro provider). */
export interface ClientBuildProviderDetails {
  name: string;
  activeEv: string | null;
  activeBuildKey: string | null;
  contractVersion: string;
}

const RUNTIME_LABEL: Record<ClientRuntime, string> = {
  web: "Web",
  "react-native": "React Native",
  terminal: "Terminal",
};

const INTEGRITY = /^sha256-[0-9a-f]{64}$/u;
const MOBILE_PLATFORMS = ["android", "ios"] as const;

/**
 * The artifact contract of a client build, one rule set for every runtime
 * (docs/client-hosts-and-clients-plan.md §4.5). It is the single definition of
 * a runnable client build: the builder enforces it on every build it
 * produces, so a violating candidate is refused by the protected-main build
 * gate, and ClientHost enforces the same function on builds it did not
 * produce itself (retained history), so nothing reaches a host that the gate
 * would have refused. Each failure names the client, the runtime and the defect.
 *
 * - The build carries a sealed execution identity.
 * - Every artifact has an integrity value; hosts verify it before activation.
 * - Exactly one primary per platform: the page (web), the program (terminal),
 *   one bundle per mobile platform (React Native).
 */
export function validateClientBuildContract(
  clientName: string,
  expected: { runtime: ClientRuntime; hostAbi: string },
  build: Pick<StoredBuildResult, "metadata" | "artifacts">
): void {
  const label = `${RUNTIME_LABEL[expected.runtime]} client ${clientName}`;
  const digest = build.metadata.execution?.executionDigest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${label} build is missing a sealed execution identity`);
  }
  const details = build.metadata.details;
  if (details.kind !== "client" || details.runtime !== expected.runtime) {
    throw new Error(`${label} build is missing ${expected.runtime} client metadata`);
  }
  if (details.hostAbi !== expected.hostAbi) {
    throw new Error(
      `${label} build was produced for ${details.hostAbi}, but its manifest declares ${expected.hostAbi}`
    );
  }
  const artifacts = build.artifacts ?? [];
  for (const artifact of artifacts) {
    if (typeof artifact.integrity !== "string" || !INTEGRITY.test(artifact.integrity)) {
      throw new Error(`${label} artifact ${artifact.path} is missing integrity`);
    }
  }
  const primaries = artifacts.filter((artifact) => artifact.role === "primary");
  switch (expected.runtime) {
    case "web": {
      if (primaries.length !== 1 || !primaries[0]!.path.endsWith(".html")) {
        throw new Error(`${label} build must include exactly one primary HTML page`);
      }
      return;
    }
    case "terminal": {
      if (primaries.length !== 1 || !primaries[0]!.path.endsWith(".mjs")) {
        throw new Error(`${label} build must include exactly one primary ESM .mjs program`);
      }
      return;
    }
    case "react-native": {
      if (!isBuildProviderDetails(details.provider)) {
        throw new Error(`${label} build does not identify the build provider that produced it`);
      }
      const seen = new Set<string>();
      for (const artifact of artifacts) {
        if (artifact.role !== "primary" && artifact.role !== "asset") continue;
        if (!(MOBILE_PLATFORMS as readonly (string | undefined)[]).includes(artifact.platform)) {
          throw new Error(
            `${label} ${artifact.role} artifact ${artifact.path} has no mobile platform`
          );
        }
        if (artifact.role !== "primary") continue;
        if (seen.has(artifact.platform!)) {
          throw new Error(`${label} has more than one primary bundle for ${artifact.platform}`);
        }
        seen.add(artifact.platform!);
      }
      if (seen.size === 0) throw new Error(`${label} build has no primary bundle`);
      return;
    }
  }
}

function isBuildProviderDetails(value: unknown): value is ClientBuildProviderDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ClientBuildProviderDetails>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    (typeof candidate.activeEv === "string" || candidate.activeEv === null) &&
    (typeof candidate.activeBuildKey === "string" || candidate.activeBuildKey === null) &&
    typeof candidate.contractVersion === "string" &&
    candidate.contractVersion.length > 0
  );
}
