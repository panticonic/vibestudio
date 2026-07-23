import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeUnitRepoPath } from "@vibestudio/unit-host";
import type { BuildArtifactManifestEntry, BuildMetadata, BuildResult } from "./buildStore.js";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { parseSha256 } from "@vibestudio/shared/execution/identity";

export const APP_DIST_BAKE_VERSION = 2;

export interface ApprovedAppDistEntry {
  name: string;
  target: "electron" | "react-native" | "terminal";
  capabilities: readonly AppCapability[];
  source: { repo: string; ref: string };
  activeEv: string | null;
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
    effectiveVersion: string;
    sourceStateHash: string | null;
    target: "electron" | "react-native" | "terminal";
    integrity: string | null;
    rnHostAbi: string | null;
    provider: Extract<BuildMetadata["details"], { kind: "app" }>["provider"];
    executionDigest: string;
    execution: NonNullable<BuildMetadata["execution"]>;
    authorityRequests: NonNullable<BuildMetadata["authority"]>["requests"];
    authorityEvalCeilings: NonNullable<BuildMetadata["authority"]>["evalCeilings"];
  };
  artifacts: BuildArtifactManifestEntry[];
}

type AppBuildDetails = Extract<BuildMetadata["details"], { kind: "app" }>;

export function createAppDistBakeManifest(opts: {
  entry: ApprovedAppDistEntry;
  build: Pick<BuildResult, "metadata" | "artifacts">;
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
  const details = appBuildDetails(opts.build.metadata);
  if (details.target !== opts.entry.target) {
    throw new Error(
      `App ${opts.entry.name} active build target ${details.target} does not match registry target ${opts.entry.target}`
    );
  }
  if (opts.build.metadata.ev !== opts.entry.activeEv) {
    throw new Error(`App ${opts.entry.name} active build EV does not match the registry`);
  }
  const execution = opts.build.metadata.execution;
  const executionDigest = parseSha256(
    execution?.executionDigest ?? "",
    `App ${opts.entry.name} execution digest`
  );
  const source = normalizeUnitRepoPath(opts.entry.source.repo);
  if (execution?.source.repoPath !== source) {
    throw new Error(`App ${opts.entry.name} execution identity does not match its source`);
  }
  const authority = parseUnitAuthorityManifest(
    opts.build.metadata.authority,
    `App ${opts.entry.name} sealed build authority`
  );
  const artifacts = opts.build.artifacts.map(({ content: _content, ...artifact }) => artifact);
  validateDistArtifacts(opts.entry.name, details, artifacts);

  return {
    version: APP_DIST_BAKE_VERSION,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    app: {
      name: opts.entry.name,
      source,
      ref: opts.entry.source.ref,
      target: opts.entry.target,
      capabilities: [...opts.entry.capabilities],
    },
    build: {
      key: buildKey,
      effectiveVersion: opts.build.metadata.ev,
      sourceStateHash: opts.entry.activeSourceHash,
      target: details.target,
      integrity: details.integrity ?? null,
      rnHostAbi: details.rnHostAbi ?? null,
      provider: details.provider ?? null,
      executionDigest,
      execution,
      authorityRequests: authority.requests,
      authorityEvalCeilings: authority.evalCeilings,
    },
    artifacts,
  };
}

export function writeAppDistBake(opts: {
  entry: ApprovedAppDistEntry;
  build: Pick<BuildResult, "metadata" | "artifacts">;
  outDir: string;
  buildKey?: string;
  generatedAt?: string;
}): AppDistBakeManifest {
  const manifest = createAppDistBakeManifest(opts);
  const tmpDir = `${opts.outDir}.tmp.${process.pid}.${Date.now()}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const artifact of opts.build.artifacts) {
    if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid app dist artifact path: ${artifact.path}`);
    }
    const targetPath = path.join(tmpDir, "artifacts", artifact.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      artifact.content,
      artifact.encoding === "base64" ? "base64" : "utf8"
    );
  }

  fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.rmSync(opts.outDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, opts.outDir);
  return manifest;
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
  for (const artifact of artifacts) {
    if (!/^sha256-[0-9a-f]{64}$/.test(artifact.integrity ?? "")) {
      throw new Error(
        `App ${appName} artifact ${artifact.path} is missing canonical content integrity`
      );
    }
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
