import { readFileSync } from "node:fs";
import {
  domainHash,
  parseSha256,
  sha256,
  type BuildRecipe,
  type CanonicalBuildOptions,
  type Sha256,
} from "@vibestudio/shared/execution/identity";
import { getSealedBuildEnvironment } from "./sourceClosure.js";
import type { GraphNode } from "./packageGraph.js";
import type { BuildUnitOptions } from "./builder.js";
import {
  authorityRequestsAsBuildValue,
  authorityRequestsFromManifest,
} from "@vibestudio/shared/authorityManifest";
import {
  BUILDER_IMPLEMENTATION_CONTRACT,
  computeBuilderImplementationDigest,
} from "../../../scripts/builder-implementation-digest.mjs";

let nodeExecutableDigest: Sha256 | null = null;
let builderImplementationDigest: Sha256 | null = null;

function getNodeExecutableDigest(): Sha256 {
  if (!nodeExecutableDigest) nodeExecutableDigest = sha256(readFileSync(process.execPath));
  return nodeExecutableDigest;
}

function getBuilderImplementationDigest(): Sha256 {
  if (!builderImplementationDigest) {
    const injected = (globalThis as { __VIBESTUDIO_BUILDER_IMPLEMENTATION_DIGEST__?: unknown })
      .__VIBESTUDIO_BUILDER_IMPLEMENTATION_DIGEST__;
    builderImplementationDigest =
      typeof injected === "string"
        ? parseSha256(injected, "injected builder implementation digest")
        : parseSha256(
            computeBuilderImplementationDigest(process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd()),
            `${BUILDER_IMPLEMENTATION_CONTRACT} source digest`
          );
  }
  return builderImplementationDigest;
}

function targetFor(node: GraphNode, options: BuildUnitOptions | undefined): string {
  if (options?.library) return `library:${options.libraryTarget ?? "neutral"}`;
  return node.kind;
}

/**
 * Construct the complete, serializable recipe used for authoritative execution
 * identity. All ambient inputs were captured before the first build; callers
 * cannot add undeclared environment variables or consult a moving filesystem.
 */
export function createExecutionRecipe(
  node: GraphNode,
  options: BuildUnitOptions | undefined
): BuildRecipe {
  const environment = getSealedBuildEnvironment();
  const dependencyDigest = parseSha256(environment.digest, "sealed dependency graph");
  const nodeDigest = getNodeExecutableDigest();
  const toolchainDigest = domainHash(
    "vibestudio/toolchain-manifest/v1",
    nodeDigest,
    dependencyDigest
  );
  const builderDigest = getBuilderImplementationDigest();
  const recipeOptions: CanonicalBuildOptions = {
    unitName: node.name,
    unitKind: node.kind,
    relativePath: node.relativePath,
    sourcemap: options?.library ? false : node.manifest.sourcemap !== false,
    library: options?.library ?? false,
    libraryEntrySubpath: options?.libraryEntrySubpath ?? null,
    libraryTarget: options?.libraryTarget ?? null,
    externals: [...(options?.externals ?? [])].sort(),
    authorityRequests:
      node.kind === "panel" ||
      node.kind === "worker" ||
      node.kind === "extension" ||
      node.kind === "app"
        ? authorityRequestsAsBuildValue(
            authorityRequestsFromManifest(node.manifest, `Executable unit ${node.relativePath}`)
          )
        : [],
  };
  return {
    target: targetFor(node, options),
    platform: process.platform,
    architecture: process.arch,
    abi: process.versions.modules ?? null,
    options: recipeOptions,
    toolchain: {
      digest: toolchainDigest,
      components: {
        node: nodeDigest,
        dependencyManifest: dependencyDigest,
      },
    },
    dependencyGraph: { digest: dependencyDigest },
    builderDigest,
    declaredEnvironment: {},
  };
}
