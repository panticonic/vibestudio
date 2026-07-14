import * as fs from "node:fs";
import * as path from "node:path";
import {
  createExecutionArtifactRef,
  createSourceRevision,
  domainHash,
  sha256,
  verifyExecutionArtifactRef,
  type ArtifactBundleEntry,
  type BuildRecipe,
  type ExecutionArtifactRef,
  type Sha256,
} from "@vibestudio/shared/execution/identity";
import type { ResolvedExecutionBinding } from "../buildV2/index.js";
import {
  authorityRequestsAsBuildValue,
  authorityRequestsFromRecipe,
} from "@vibestudio/shared/authorityManifest";
import type { CapabilityScope } from "@vibestudio/rpc";
import { PRODUCT_AUTHORITY_GRANT_CATALOG } from "../services/productAuthorityGrantCatalog.generated.js";

/** The only Durable Object below exact artifact resolution and entity storage. */
export const WORKSPACE_DO_SOURCE = "product/bootstrap" as const;
export const WORKSPACE_DO_CLASS = "WorkspaceDO" as const;

/** Product functionality launched above the bootstrap root through normal R1 incarnations. */
export const EVAL_DO_SOURCE = "product/eval" as const;
export const BROWSER_DATA_DO_SOURCE = "product/browser-data" as const;
export const WEBHOOK_STORE_DO_SOURCE = "product/webhook-store" as const;

export const PRODUCT_SEED_DOS = [
  {
    id: "eval",
    source: EVAL_DO_SOURCE,
    className: "EvalDO",
    hostCapabilities: ["unsafe-eval"] as const,
  },
  {
    id: "browser-data",
    source: BROWSER_DATA_DO_SOURCE,
    className: "BrowserDataDO",
    hostCapabilities: [] as const,
  },
  {
    id: "webhook-store",
    source: WEBHOOK_STORE_DO_SOURCE,
    className: "WebhookStoreDO",
    hostCapabilities: [] as const,
  },
] as const;

export type ProductSeedDo = (typeof PRODUCT_SEED_DOS)[number];

export interface ProductExecutionArtifact {
  binding: ResolvedExecutionBinding;
  bundle: {
    ref: ExecutionArtifactRef;
    requested: readonly CapabilityScope[];
    entries: ArtifactBundleEntry[];
  };
}

export interface ProductBootManifest {
  version: 1;
  productBuildDigest: Sha256;
  hostPrincipal: `host:${string}`;
  bootstrap: {
    source: typeof WORKSPACE_DO_SOURCE;
    className: typeof WORKSPACE_DO_CLASS;
    artifact: ExecutionArtifactRef;
    bindings: readonly ["durable-sql", "host-rpc"];
    capabilities: readonly ["content.read", "entity.registry", "authority.grants", "context.bind"];
  };
  productSeeds: readonly {
    id: ProductSeedDo["id"];
    source: ProductSeedDo["source"];
    className: ProductSeedDo["className"];
    artifact: ExecutionArtifactRef;
    adoption: "exact-product-seed";
    hostCapabilities: readonly "unsafe-eval"[];
  }[];
}

declare const globalThis: { __VIBESTUDIO_PRODUCT_DO_BUNDLE__?: string };

let cached:
  | {
      bundleText: string;
      manifest: ProductBootManifest;
      bootstrap: ProductExecutionArtifact;
      seedsBySource: ReadonlyMap<string, ProductExecutionArtifact>;
      artifactsByDigest: ReadonlyMap<string, ProductExecutionArtifact["bundle"]>;
    }
  | undefined;

export function getProductBootManifest(): ProductBootManifest {
  return structuredClone(productArtifacts().manifest);
}

export function getBootstrapBundle(): ProductExecutionArtifact {
  return cloneProductArtifact(productArtifacts().bootstrap);
}

export function resolveProductSeedArtifact(source: string): ResolvedExecutionBinding | null {
  const artifact = productArtifacts().seedsBySource.get(source);
  return artifact ? cloneBinding(artifact.binding) : null;
}

export function getProductExecutionArtifact(
  executionDigest: string
): ProductExecutionArtifact["bundle"] | null {
  const bundle = productArtifacts().artifactsByDigest.get(executionDigest);
  return bundle ? cloneBundle(bundle) : null;
}

export function productSeedExecutionDigest(source: string): Sha256 {
  const artifact = productArtifacts().seedsBySource.get(source);
  if (!artifact) throw new Error(`Unknown product seed source: ${source}`);
  return artifact.binding.artifact.executionDigest;
}

export function productSeedHostCapabilities(
  source: string,
  className: string
): readonly "unsafe-eval"[] {
  return (
    PRODUCT_SEED_DOS.find((entry) => entry.source === source && entry.className === className)
      ?.hostCapabilities ?? []
  );
}

export function isBootstrapDoSource(source: string): boolean {
  return source === WORKSPACE_DO_SOURCE;
}

/**
 * Static workerd namespaces are reserved for the substrate root and exact
 * product seeds that require non-serializable host bindings. Every other DO is
 * hosted dynamically by UniversalDO.
 */
export function requiresStaticDoHost(source: string, className: string): boolean {
  return (
    (source === WORKSPACE_DO_SOURCE && className === WORKSPACE_DO_CLASS) ||
    productSeedHostCapabilities(source, className).length > 0
  );
}

export function isProductSeedSource(source: string): boolean {
  return productArtifacts().seedsBySource.has(source);
}

export function isReservedProductDo(source: string, className: string): boolean {
  if (source === WORKSPACE_DO_SOURCE) return className === WORKSPACE_DO_CLASS;
  return PRODUCT_SEED_DOS.some((entry) => entry.source === source && entry.className === className);
}

function productArtifacts(): NonNullable<typeof cached> {
  if (cached) return cached;
  const bundleText = loadProductBundle();
  const bundleDigest = sha256(Buffer.from(bundleText));
  const bootstrap = createProductArtifact(WORKSPACE_DO_SOURCE, bundleText, bundleDigest);
  const seeds = PRODUCT_SEED_DOS.map((seed) => ({
    seed,
    artifact: createProductArtifact(seed.source, bundleText, bundleDigest),
  }));
  const productBuildDigest = domainHash(
    "vibestudio/product-build/v1",
    bootstrap.binding.artifact.executionDigest,
    ...seeds.map(({ artifact }) => artifact.binding.artifact.executionDigest)
  );
  const manifest: ProductBootManifest = Object.freeze({
    version: 1,
    productBuildDigest,
    hostPrincipal: `host:${productBuildDigest}`,
    bootstrap: Object.freeze({
      source: WORKSPACE_DO_SOURCE,
      className: WORKSPACE_DO_CLASS,
      artifact: bootstrap.binding.artifact,
      bindings: Object.freeze(["durable-sql", "host-rpc"] as const),
      capabilities: Object.freeze([
        "content.read",
        "entity.registry",
        "authority.grants",
        "context.bind",
      ] as const),
    }),
    productSeeds: Object.freeze(
      seeds.map(({ seed, artifact }) =>
        Object.freeze({
          ...seed,
          artifact: artifact.binding.artifact,
          adoption: "exact-product-seed" as const,
        })
      )
    ),
  });
  verifyManifest(manifest);
  cached = {
    bundleText,
    manifest,
    bootstrap,
    seedsBySource: new Map(seeds.map(({ seed, artifact }) => [seed.source, artifact])),
    artifactsByDigest: new Map(
      [bootstrap, ...seeds.map(({ artifact }) => artifact)].map((artifact) => [
        artifact.binding.artifact.executionDigest,
        artifact.bundle,
      ])
    ),
  };
  return cached;
}

function createProductArtifact(
  source: string,
  bundleText: string,
  bundleDigest: Sha256
): ProductExecutionArtifact {
  const toolchainDigest = domainHash("vibestudio/product-toolchain/v1", bundleDigest);
  const capabilities =
    PRODUCT_AUTHORITY_GRANT_CATALOG.codeCapabilitiesBySource[
      source as keyof typeof PRODUCT_AUTHORITY_GRANT_CATALOG.codeCapabilitiesBySource
    ];
  if (!capabilities)
    throw new Error(`Product source has no reviewed authority manifest: ${source}`);
  const recipe: BuildRecipe = {
    target: "workerd-durable-object",
    platform: process.platform,
    architecture: process.arch,
    abi: null,
    options: {
      format: "esm",
      productSeed: true,
      authorityRequests: authorityRequestsAsBuildValue(
        capabilities.map((capability) => ({
          capability,
          resource: { kind: "prefix" as const, prefix: "" },
        }))
      ),
    },
    toolchain: {
      digest: toolchainDigest,
      components: { bundledRuntime: toolchainDigest },
    },
    dependencyGraph: {
      digest: domainHash("vibestudio/product-dependency-graph/v1", bundleDigest),
    },
    builderDigest: domainHash("vibestudio/product-builder/v1", "esbuild-product-do"),
    declaredEnvironment: {},
  };
  const stateHash = domainHash("vibestudio/product-source-state/v1", source, bundleDigest);
  const entries: ArtifactBundleEntry[] = [
    {
      path: "worker.js",
      role: "primary",
      mode: 0o644,
      contentType: "text/javascript; charset=utf-8",
      bytes: Buffer.from(bundleText),
    },
  ];
  const { ref } = createExecutionArtifactRef({
    source: createSourceRevision({ repoPath: source, stateHash }),
    recipe,
    entries,
  });
  return {
    binding: {
      unitName: source,
      selectorPolicy: { kind: "artifact", executionDigest: ref.executionDigest },
      artifact: ref,
      requested: authorityRequestsFromRecipe(recipe),
      compilationCacheKey: domainHash(
        "vibestudio/product-compilation-cache/v1",
        source,
        ref.buildKey
      ),
    },
    bundle: { ref, requested: authorityRequestsFromRecipe(recipe), entries },
  };
}

function verifyManifest(manifest: ProductBootManifest): void {
  verifyExecutionArtifactRef(manifest.bootstrap.artifact);
  for (const seed of manifest.productSeeds) verifyExecutionArtifactRef(seed.artifact);
  const expected = domainHash(
    "vibestudio/product-build/v1",
    manifest.bootstrap.artifact.executionDigest,
    ...manifest.productSeeds.map((seed) => seed.artifact.executionDigest)
  );
  if (manifest.productBuildDigest !== expected || manifest.hostPrincipal !== `host:${expected}`) {
    throw new Error("Product boot manifest digest mismatch");
  }
}

function cloneBinding(binding: ResolvedExecutionBinding): ResolvedExecutionBinding {
  return structuredClone(binding);
}

function cloneBundle(
  bundle: ProductExecutionArtifact["bundle"]
): ProductExecutionArtifact["bundle"] {
  return {
    ref: structuredClone(bundle.ref),
    requested: structuredClone(bundle.requested),
    entries: bundle.entries.map((entry) => ({
      ...entry,
      bytes: Uint8Array.from(entry.bytes),
    })),
  };
}

function cloneProductArtifact(artifact: ProductExecutionArtifact): ProductExecutionArtifact {
  return { binding: cloneBinding(artifact.binding), bundle: cloneBundle(artifact.bundle) };
}

function loadProductBundle(): string {
  const inlined =
    typeof globalThis.__VIBESTUDIO_PRODUCT_DO_BUNDLE__ === "string"
      ? globalThis.__VIBESTUDIO_PRODUCT_DO_BUNDLE__
      : undefined;
  if (inlined) return inlined;
  const runtimeDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const appRoot = process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
  const candidates = [
    path.join(runtimeDir, "product-do.bundle.mjs"),
    path.resolve(appRoot, "dist/product-do.bundle.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
  }
  throw new Error(`Product Durable Object bundle is unavailable; build ${candidates.join(" or ")}`);
}
