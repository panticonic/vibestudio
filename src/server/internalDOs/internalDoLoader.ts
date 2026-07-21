import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import { domainHash, parseSha256, sha256 } from "@vibestudio/shared/execution/identity";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import executionCatalog from "./internalDoExecutionCatalog.json";

export const INTERNAL_DO_SOURCE = "vibestudio/internal";

export const INTERNAL_DO_CLASSES = [
  "WebhookStoreDO",
  "WorkspaceDO",
  "BrowserDataDO",
  "EvalDO",
  "GadWorkspaceDO",
] as const;

export type InternalDOClassName = (typeof INTERNAL_DO_CLASSES)[number];

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
  authorityRequests: UnitAuthorityManifest["requests"];
  authorityDelegations: UnitAuthorityManifest["delegations"];
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
  const authority = parseUnitAuthorityManifest(
    rawManifest,
    `internal Durable Object ${className} authority`
  );
  const effectiveVersion = domainHash(
    "vibestudio/internal-do-source/v1",
    canonicalJson({ version: 1, source: INTERNAL_DO_SOURCE, artifactDigest })
  );
  const executionDigest = domainHash(
    "vibestudio/internal-do-execution/v1",
    canonicalJson({
      version: 1,
      source: INTERNAL_DO_SOURCE,
      className,
      effectiveVersion,
      artifactDigest,
      authority,
    })
  );
  return Object.freeze({
    source: INTERNAL_DO_SOURCE,
    unitName: `@vibestudio/internal-do/${className}`,
    stateHash: artifactDigest,
    buildKey: artifactDigest,
    effectiveVersion,
    executionDigest,
    authorityRequests: authority.requests,
    authorityDelegations: authority.delegations,
  });
}

function loadBundle(): InternalDOBundle {
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
