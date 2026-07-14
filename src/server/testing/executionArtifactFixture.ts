import {
  createExecutionArtifactRef,
  createSourceRevision,
  parseSha256,
  sha256,
  type ArtifactBundleEntry,
  type BuildRecipe,
  type ExecutionArtifactRef,
  type ExecutionSelector,
  type Sha256,
} from "@vibestudio/shared/execution/identity";
import type { ResolvedExecutionBinding } from "../buildV2/index.js";
import type { BuildResult } from "../buildV2/buildStore.js";
import type { CapabilityScope } from "@vibestudio/rpc";
import {
  authorityRequestsAsBuildValue,
  authorityRequestsFromRecipe,
} from "@vibestudio/shared/authorityManifest";

/** Exact in-memory execution artifact for host/runtime tests. */
export function executionArtifactFixture(
  source: string,
  build: BuildResult,
  ref?: string,
  compilationCacheKey?: string
): {
  binding: ResolvedExecutionBinding;
  bundle: {
    ref: ExecutionArtifactRef;
    requested: readonly CapabilityScope[];
    entries: ArtifactBundleEntry[];
    entryPath(artifactPath: string): string;
  };
} {
  const digest = sha256("test-toolchain");
  const stateHash = sha256(`${ref ?? "main"}\0${build.metadata.sourceDigest}`);
  const recipe: BuildRecipe = {
    target: build.metadata.kind,
    platform: process.platform,
    architecture: process.arch,
    abi: process.versions.modules ?? null,
    options: {
      testFixture: true,
      authorityRequests: authorityRequestsAsBuildValue([
        { capability: "panel-hosting", resource: { kind: "prefix", prefix: "" } },
        { capability: "window-management", resource: { kind: "prefix", prefix: "" } },
        { capability: "open-external", resource: { kind: "prefix", prefix: "" } },
        { capability: "native-menus", resource: { kind: "prefix", prefix: "" } },
        { capability: "notifications", resource: { kind: "prefix", prefix: "" } },
        { capability: "clipboard", resource: { kind: "prefix", prefix: "" } },
      ]),
    },
    toolchain: { digest, components: { test: digest } },
    dependencyGraph: { digest },
    builderDigest: digest,
    declaredEnvironment: {},
  };
  const entries = build.artifacts.map((entry) => ({
    path: entry.path,
    role: entry.role,
    mode: 0o644 as const,
    contentType: entry.contentType,
    bytes:
      entry.encoding === "base64"
        ? Buffer.from(entry.content, "base64")
        : Buffer.from(entry.content, "utf8"),
  }));
  const declaredSourceDigest = /^[0-9a-f]{64}$/.test(build.metadata.sourceDigest)
    ? (build.metadata.sourceDigest as Sha256)
    : undefined;
  const artifact = createExecutionArtifactRef({
    source: createSourceRevision({
      repoPath: source,
      stateHash,
      ...(declaredSourceDigest ? { sourceEv: declaredSourceDigest } : {}),
    }),
    recipe,
    entries,
  }).ref;
  const selectorPolicy: ExecutionSelector = ref?.startsWith("ctx:")
    ? { kind: "head", repoPath: source, head: { contextId: ref.slice(4) } }
    : ref?.startsWith("state:")
      ? { kind: "state", repoPath: source, stateHash: parseSha256(ref) }
      : { kind: "head", repoPath: source, head: "main" };
  return {
    binding: {
      unitName: build.metadata.name,
      selectorPolicy,
      artifact,
      requested: authorityRequestsFromRecipe(recipe),
      compilationCacheKey:
        compilationCacheKey ?? sha256(`cache\0${source}\0${build.metadata.sourceDigest}`),
    },
    bundle: {
      ref: artifact,
      requested: authorityRequestsFromRecipe(recipe),
      entries,
      entryPath: (artifactPath: string) => `${build.dir}/${artifactPath}`,
    },
  };
}
