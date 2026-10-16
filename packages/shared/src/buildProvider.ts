import type { ClientManifestBlock } from "@vibestudio/workspace-contracts/clients";

/**
 * Build providers are extensions that compile a client runtime the host build
 * cannot. Only React Native has one (Metro). The host ABI a bundle targets is
 * the client manifest's `hostAbi`, checked against `CURRENT_HOST_ABI`; the
 * provider never reports it.
 */
export type BuildProviderTarget = "react-native";
export type BuildProviderArtifactRole = "primary" | "asset" | "html" | "css" | "map";
export type BuildProviderArtifactEncoding = "utf8" | "base64";

export interface BuildProviderArtifact {
  path: string;
  role: BuildProviderArtifactRole;
  contentType: string;
  encoding?: BuildProviderArtifactEncoding;
  platform?: "ios" | "android" | string;
  content?: string;
  stream?: {
    method: string;
    args?: unknown[];
    /** SHA-256 of the producer's source bytes, before crossing the stream transport. */
    integrity: string;
  };
}

export interface BuildProviderDependencyProjection {
  /** Build V2's content-addressed external dependency tree. */
  nodeModulesPath: string | null;
  /** Exact source roots for workspace and platform modules in this build closure. */
  modules: Readonly<Record<string, string>>;
}

export interface BuildProviderInput {
  target: BuildProviderTarget;
  unitName: string;
  sourcePath: string;
  dependencyProjection: BuildProviderDependencyProjection;
  effectiveVersion: string;
  /** The unit's validated `vibestudio.client` manifest block. */
  client: ClientManifestBlock;
}

export interface BuildProviderOutput {
  artifacts: BuildProviderArtifact[];
}

export interface BuildProvider {
  name: string;
  target: BuildProviderTarget;
  contractVersion: string;
  activeEv: string | null;
  activeBuildKey: string | null;
  build(input: BuildProviderInput): Promise<BuildProviderOutput>;
  streamArtifact?(artifact: BuildProviderArtifact, input: BuildProviderInput): Promise<Response>;
}
