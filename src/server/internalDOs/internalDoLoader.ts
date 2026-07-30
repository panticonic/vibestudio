import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { domainHash, parseSha256, sha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import executionCatalog from "./internalDoExecutionCatalog.json";
import {
  INTERNAL_DO_CLASSES,
  productBuiltinByIdentity,
  type InternalDOClassName,
} from "@vibestudio/shared/productBuiltinCatalog.generated";

export const INTERNAL_DO_SOURCE = "vibestudio/internal";
export { INTERNAL_DO_CLASSES };
export const INTERNAL_DO_PRODUCT_SEED_ID = "product:vibestudio-internal-do";

export interface InternalDOBundle {
  bundle: string;
  buildKey: string;
}

export interface InternalDOExecutionIdentity {
  source: typeof INTERNAL_DO_SOURCE;
  unitName: string;
  stateHash: string;
  buildKey: string;
  effectiveVersion: string;
  executionDigest: string;
  artifact: ExecutionArtifactRefV1;
  authority: UnitAuthorityManifest;
}

declare const globalThis: { __VIBESTUDIO_INTERNAL_DO_BUNDLE__?: string };

let cached: InternalDOBundle | null = null;

export function isInternalDOSource(source: string): boolean {
  return source === INTERNAL_DO_SOURCE;
}

export function getInternalDOBundle(): InternalDOBundle {
  if (cached) return cached;
  cached = loadBundle();
  return cached;
}

/**
 * Seal one product-baked internal DO entrypoint from the exact shipped bundle
 * and its reviewed authority manifest. The bundle hash identifies source
 * content; the execution digest additionally binds the selected class and its
 * request ceiling, so two exports from the same bundle cannot alias authority.
 */
export function internalDOExecutionIdentity(
  bundle: InternalDOBundle,
  className: string
): InternalDOExecutionIdentity {
  if (!(INTERNAL_DO_CLASSES as readonly string[]).includes(className)) {
    throw new Error(`Internal Durable Object class ${className} is not a reviewed product export`);
  }
  const reviewedClassName = className as InternalDOClassName;
  const artifactDigest = sha256(bundle.bundle);
  if (parseSha256(bundle.buildKey, "internal DO bundle build key") !== artifactDigest) {
    throw new Error("Internal Durable Object bundle build key does not match its exact bytes");
  }
  const rawManifest = executionCatalog.classes[reviewedClassName];
  const builtin = productBuiltinByIdentity(INTERNAL_DO_SOURCE, reviewedClassName);
  if (!builtin) throw new Error(`Internal Durable Object ${className} is not cataloged`);
  const authority = parseUnitAuthorityManifest(
    {
      requests: rawManifest.requests,
      provides: rawManifest.provides,
    },
    `internal Durable Object ${className} authority`
  );
  const effectiveVersion = domainHash(
    "vibestudio/internal-do-source/v1",
    canonicalJson({ version: 1, source: INTERNAL_DO_SOURCE, artifactDigest })
  );
  const recipeDigest = domainHash(
    "vibestudio/internal-do-recipe/v1",
    canonicalJson({
      version: 1,
      source: INTERNAL_DO_SOURCE,
      className,
      builtin,
      authority,
    })
  );
  const stateHash = `state:${artifactDigest}`;
  const contentRoots = [{ repoPath: null, stateHash }] as const;
  const unsignedArtifact: Omit<ExecutionArtifactRefV1, "executionDigest"> = {
    version: 1,
    sourceState: {
      kind: "product-seed",
      workspaceId: INTERNAL_DO_PRODUCT_SEED_ID,
      effectiveVersion,
      state: null,
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest,
    buildKey: artifactDigest,
    artifactDigest,
  };
  const artifact = verifyExecutionArtifactRef({
    ...unsignedArtifact,
    executionDigest: executionArtifactDigest(unsignedArtifact),
  });
  return Object.freeze({
    source: INTERNAL_DO_SOURCE,
    unitName: `@panticonic/builtin/${builtin.name}`,
    stateHash,
    buildKey: artifact.buildKey,
    effectiveVersion: artifact.sourceState.effectiveVersion,
    executionDigest: artifact.executionDigest,
    artifact,
    authority,
  });
}

export function internalDOExecutionArtifacts(
  bundle: InternalDOBundle
): readonly ExecutionArtifactRefV1[] {
  return INTERNAL_DO_CLASSES.map(
    (className) => internalDOExecutionIdentity(bundle, className).artifact
  );
}

function loadBundle(): InternalDOBundle {
  // A supervising hub snapshots the exact product runtime once per hub boot
  // and gives every workspace child (including crash replacements) this path.
  // Source-mode build artifacts are shared by developer instances and may be
  // rebuilt concurrently; rereading the mutable dist file on child recovery
  // would silently change the execution identity mid-boot.
  const snapshotPath = process.env["VIBESTUDIO_INTERNAL_DO_BUNDLE_PATH"];
  if (snapshotPath) {
    if (!path.isAbsolute(snapshotPath)) {
      throw new Error("VIBESTUDIO_INTERNAL_DO_BUNDLE_PATH must be absolute");
    }
    const bundle = fs.readFileSync(snapshotPath, "utf8");
    if (bundle.length === 0) {
      throw new Error(`Internal Durable Object bundle snapshot is empty: ${snapshotPath}`);
    }
    return {
      bundle,
      buildKey: createHash("sha256").update(bundle).digest("hex"),
    };
  }

  // Production path: the build inlines the internal-DO bundle as a string
  // constant via esbuild `define`, eliminating any runtime file lookup. See
  // `build.mjs` (the `internalDoBundleDefine` block).
  const inlined =
    typeof globalThis.__VIBESTUDIO_INTERNAL_DO_BUNDLE__ === "string"
      ? globalThis.__VIBESTUDIO_INTERNAL_DO_BUNDLE__
      : undefined;
  if (inlined && inlined.length > 0) {
    return {
      bundle: inlined,
      buildKey: createHash("sha256").update(inlined).digest("hex"),
    };
  }

  // Source/test path: fall back to reading the prebuilt bundle from disk.
  // Used by Vitest and any non-bundled execution. `pnpm build` produces the
  // bundle at `dist/internal-do.bundle.mjs`.
  const runtimeDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const appRoot = process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
  const candidates = [
    path.join(runtimeDir, "internal-do.bundle.mjs"),
    path.resolve(appRoot, "dist/internal-do.bundle.mjs"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const bundle = fs.readFileSync(candidate, "utf8");
    return {
      bundle,
      buildKey: createHash("sha256").update(bundle).digest("hex"),
    };
  }
  throw new Error(
    `Internal Durable Object bundle not available. The production build inlines this via esbuild define; for source/test runs, build first with \`pnpm build\` so ${candidates.join(" or ")} exists.`
  );
}
