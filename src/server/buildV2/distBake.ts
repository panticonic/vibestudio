import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeUnitRepoPath } from "@vibestudio/unit-host";
import type { BuildArtifactManifestEntry, BuildMetadata, BuildResult } from "./buildStore.js";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { CapabilityScope } from "@vibestudio/rpc";
import type {
  ArtifactBundleEntry,
  ExecutionArtifactRef,
} from "@vibestudio/shared/execution/identity";

export const APP_DIST_BAKE_VERSION = 2;

export interface ApprovedAppDistEntry {
  name: string;
  target: "electron" | "react-native" | "terminal";
  capabilities: readonly AppCapability[];
  source: { repo: string; ref: string };
  activeSourceDigest: string | null;
  activeExecutionDigest: string | null;
  activeSourceHash: string | null;
  activeBundleKey: string | null;
  status: string;
}

export interface AppDistBakeManifest {
  version: typeof APP_DIST_BAKE_VERSION;
  generatedAt: string;
  app: {
    name: string;
    source: string;
    ref: string;
    target: "electron" | "react-native" | "terminal";
    capabilities: AppCapability[];
  };
  build: {
    key: string;
    compilationCacheKey: string;
    executionDigest: string;
    authorityRequests: readonly CapabilityScope[];
    sourceStateHash: string | null;
    target: "electron" | "react-native" | "terminal";
    integrity: string | null;
    rnHostAbi: string | null;
    provider: Extract<BuildMetadata["details"], { kind: "app" }>["provider"];
  };
  artifacts: BuildArtifactManifestEntry[];
}

type AppBuildDetails = Extract<BuildMetadata["details"], { kind: "app" }>;

export function createAppDistBakeManifest(opts: {
  entry: ApprovedAppDistEntry;
  build: Pick<BuildResult, "metadata" | "artifacts">;
  execution: {
    ref: ExecutionArtifactRef;
    requested: readonly CapabilityScope[];
    entries: readonly ArtifactBundleEntry[];
  };
  buildKey?: string;
  generatedAt?: string;
}): AppDistBakeManifest {
  const buildKey = opts.buildKey ?? opts.entry.activeBundleKey;
  if (opts.entry.status !== "running") {
    throw new Error(`App ${opts.entry.name} is not running and cannot be baked into dist`);
  }
  if (!buildKey || buildKey !== opts.entry.activeBundleKey) {
    throw new Error(`App ${opts.entry.name} has no matching active app build to bake`);
  }
  if (
    !opts.entry.activeExecutionDigest ||
    opts.execution.ref.executionDigest !== opts.entry.activeExecutionDigest
  ) {
    throw new Error(`App ${opts.entry.name} has no matching active execution artifact to bake`);
  }
  const details = appBuildDetails(opts.build.metadata);
  if (details.target !== opts.entry.target) {
    throw new Error(
      `App ${opts.entry.name} active build target ${details.target} does not match registry target ${opts.entry.target}`
    );
  }
  if (opts.build.metadata.sourceDigest !== opts.entry.activeSourceDigest) {
    throw new Error(
      `App ${opts.entry.name} active build source digest does not match the registry`
    );
  }
  if (opts.execution.ref.source.sourceEv !== opts.entry.activeSourceDigest) {
    throw new Error(`App ${opts.entry.name} execution source does not match the registry`);
  }
  const artifacts = opts.build.artifacts.map(({ content: _content, ...artifact }) => artifact);
  validateDistArtifacts(opts.entry.name, details, artifacts);
  validateExecutionArtifacts(opts.entry.name, artifacts, opts.execution.entries);

  return {
    version: APP_DIST_BAKE_VERSION,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    app: {
      name: opts.entry.name,
      source: normalizeUnitRepoPath(opts.entry.source.repo),
      ref: opts.entry.source.ref,
      target: opts.entry.target,
      capabilities: [...opts.entry.capabilities],
    },
    build: {
      key: opts.execution.ref.buildKey,
      compilationCacheKey: buildKey,
      executionDigest: opts.execution.ref.executionDigest,
      authorityRequests: opts.execution.requested,
      sourceStateHash: opts.entry.activeSourceHash,
      target: details.target,
      integrity: details.integrity ?? null,
      rnHostAbi: details.rnHostAbi ?? null,
      provider: details.provider ?? null,
    },
    artifacts,
  };
}

export function writeAppDistBake(opts: {
  entry: ApprovedAppDistEntry;
  build: Pick<BuildResult, "metadata" | "artifacts">;
  execution: {
    ref: ExecutionArtifactRef;
    requested: readonly CapabilityScope[];
    entries: readonly ArtifactBundleEntry[];
  };
  outDir: string;
  buildKey?: string;
  generatedAt?: string;
}): AppDistBakeManifest {
  const manifest = createAppDistBakeManifest(opts);
  const tmpDir = `${opts.outDir}.tmp.${process.pid}.${Date.now()}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const artifact of opts.execution.entries) {
    if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid app dist artifact path: ${artifact.path}`);
    }
    const targetPath = path.join(tmpDir, "artifacts", artifact.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const content: Uint8Array =
      manifest.app.target === "electron" && artifact.role === "html"
        ? Buffer.from(standaloneElectronHtml(Buffer.from(artifact.bytes).toString("utf8")), "utf8")
        : artifact.bytes;
    fs.writeFileSync(targetPath, content, { mode: artifact.mode });
    fs.chmodSync(targetPath, artifact.mode);
  }

  fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.rmSync(opts.outDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, opts.outDir);
  return manifest;
}

function validateExecutionArtifacts(
  appName: string,
  buildArtifacts: readonly BuildArtifactManifestEntry[],
  executionArtifacts: readonly ArtifactBundleEntry[]
): void {
  const expected = new Map(buildArtifacts.map((artifact) => [artifact.path, artifact]));
  if (expected.size !== executionArtifacts.length) {
    throw new Error(`App ${appName} execution artifact set does not match its compilation record`);
  }
  for (const artifact of executionArtifacts) {
    const compiled = expected.get(artifact.path);
    if (
      !compiled ||
      compiled.role !== artifact.role ||
      compiled.contentType !== artifact.contentType
    ) {
      throw new Error(
        `App ${appName} execution artifact ${artifact.path} does not match its compilation record`
      );
    }
  }
}

function appBuildDetails(metadata: BuildMetadata): AppBuildDetails {
  if (metadata.kind !== "app" || metadata.details.kind !== "app") {
    throw new Error(`Build ${metadata.name} is not an app build and cannot be baked into dist`);
  }
  return metadata.details;
}

function validateDistArtifacts(
  appName: string,
  details: AppBuildDetails,
  artifacts: BuildArtifactManifestEntry[]
): void {
  if (artifacts.length === 0) {
    throw new Error(`App ${appName} build has no artifacts to bake`);
  }
  if (details.target === "electron") {
    if (!artifacts.some((artifact) => artifact.role === "html")) {
      throw new Error(`Electron app ${appName} build has no HTML artifact to bake`);
    }
    return;
  }

  if (!details.integrity || !details.rnHostAbi) {
    throw new Error(
      `React Native app ${appName} build must include integrity and rnHostAbi to bake`
    );
  }
  const primary = artifacts.filter((artifact) => artifact.role === "primary");
  if (primary.length === 0) {
    throw new Error(`React Native app ${appName} build has no primary bundle artifact to bake`);
  }
  for (const artifact of primary) {
    if (artifact.platform !== "android" && artifact.platform !== "ios") {
      throw new Error(
        `React Native app ${appName} primary artifact ${artifact.path} is missing a mobile platform`
      );
    }
    if (!artifact.integrity) {
      throw new Error(
        `React Native app ${appName} primary artifact ${artifact.path} is missing integrity`
      );
    }
  }
}

function standaloneElectronHtml(html: string): string {
  return html
    .replace(/<base\b[^>]*>\s*/i, "")
    .replace(
      /<script\b[^>]*\bsrc\s*=\s*["']\/__loader\.js["'][^>]*><\/script>/i,
      '<script type="module" src="./bundle.js"></script>'
    );
}
