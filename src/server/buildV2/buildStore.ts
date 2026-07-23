/**
 * Content-Addressed Build Store — immutable artifact storage.
 *
 * {userData}/builds/{build_key}/
 *   ├── bundle.js
 *   ├── bundle.css  (if any)
 *   ├── index.html  (panels/about only)
 *   ├── assets/     (chunks, images, fonts)
 *   ├── artifacts.json
 *   └── metadata.json
 *
 * Same key = same content. Forever. GC prunes unreferenced entries.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getCentralDataPath, getUserDataPath } from "@vibestudio/env-paths";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  canonicalArtifactPath,
  domainHash,
  parseSha256,
  type Sha256,
} from "@vibestudio/shared/execution/identity";
import { assertPresent } from "../../lintHelpers";
import {
  blobCasPath,
  centralBlobCasDir,
  linkBlobFileSync,
  putBlobBytesSync,
} from "../storage/blobCas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildArtifacts {
  entries: BuildArtifactInput[];
}

export type BuildArtifactRole = "primary" | "asset" | "html" | "css" | "map" | "wasm";
export type BuildArtifactEncoding = "utf8" | "base64";

export interface BuildArtifactInput {
  path: string;
  role: BuildArtifactRole;
  contentType: string;
  encoding?: BuildArtifactEncoding;
  platform?: string;
  integrity?: string;
  content: string;
}

export interface BuildArtifactManifestEntry {
  path: string;
  role: BuildArtifactRole;
  contentType: string;
  encoding: BuildArtifactEncoding;
  platform?: string;
  integrity?: string;
}

export type BuildArtifactWithContent = BuildArtifactManifestEntry & { content: string };

/**
 * Immutable executable identity sealed at the build-store boundary.
 *
 * `buildInputDigest` is the full BuildV2 input hash used as the cache key. It
 * identifies source closure + recipe inputs, while `artifactDigest` identifies
 * the exact emitted manifest and bytes. `executionDigest` combines both under
 * a separate domain and is the only member suitable for code principals.
 */
export interface BuildExecutionIdentity {
  version: 1;
  source: {
    repoPath: string;
    effectiveVersion: Sha256;
  };
  buildInputDigest: Sha256;
  artifactDigest: Sha256;
  executionDigest: Sha256;
}

export type BuildMetadataDetails =
  | {
      kind: "extension";
      runtimeDepsKey: string | null;
      runtimeAbi: string | null;
      providerContracts: Record<string, { methods: string[] }>;
      dependencyMode?: "auto" | "bundle" | "external";
      externalDeps?: Record<string, string>;
      dependencyOverrides?: Record<string, string>;
      classifiedDeps?: Array<{
        name: string;
        version: string;
        external: boolean;
        format: "cjs" | "esm" | "unknown";
        reasons: string[];
        explanation: string;
      }>;
      smokeTest?: {
        mode: "child-process";
        passed: boolean;
      };
    }
  | {
      kind: "app";
      target: "electron" | "react-native" | "terminal";
      platform?: "electron" | "ios" | "android" | "terminal";
      integrity?: string | null;
      rnHostAbi?: string | null;
      provider?: {
        name: string;
        activeEv: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      } | null;
    }
  | { kind: "library"; format: "cjs" | "async-cjs" }
  | { kind: "generic" };

export interface BuildMetadata {
  kind: "panel" | "package" | "worker" | "extension" | "app" | "template";
  name: string;
  /** Canonical identity of this exact immutable executable artifact. */
  buildKey: string;
  /** Workspace-relative repository path; null for external library builds. */
  sourcePath: string | null;
  ev: string;
  /** Workspace state this artifact was materialized from; null for non-workspace builds. */
  sourceStateHash: string | null;
  sourcemap: boolean;
  framework?: string;
  /** Authority sealed from the exact materialized source manifest. */
  authority?: UnitAuthorityManifest;
  /**
   * Caller-facing direct-RPC documentation extracted from this exact worker
   * source state. Discovery only: grants and receiver enforcement never consume it.
   */
  workspaceRpcCatalog?: import("./workspaceRpcCatalog.js").WorkspaceRpcMethodDoc[];
  /** Derived by the store from immutable inputs; callers may not supply it. */
  execution?: BuildExecutionIdentity;
  details: BuildMetadataDetails;
  builtAt: string;
}

export interface BuildResult {
  /** Absolute path to the build directory */
  dir: string;
  /** Full BuildV2 input digest used only as the immutable cache locator. */
  buildKey: string;
  /** Workspace state resolved for this build request; null for non-workspace builds. */
  sourceStateHash: string | null;
  /** Build metadata */
  metadata: BuildMetadata;
  /** Target-agnostic artifact manifest with content loaded. */
  artifacts: BuildArtifactWithContent[];
}

// ---------------------------------------------------------------------------
// Build Store
// ---------------------------------------------------------------------------

function getBuildsDir(): string {
  return path.join(getUserDataPath(), "builds");
}

function getBuildDir(key: string): string {
  return path.join(getBuildsDir(), key);
}

/**
 * Shared, content-addressed artifact bytes for managed workspaces.
 *
 * Build metadata remains in each workspace because sourceStateHash and builtAt
 * are workspace-specific. Only immutable artifact payloads are hardlinked.
 */
export function getCentralBuildArtifactPoolDir(): string {
  return centralBlobCasDir(getCentralDataPath());
}

export function getCentralBuildResultCacheDir(): string {
  return path.join(getCentralDataPath(), "build-cache");
}

function getSharedArtifactPoolDir(): string | null {
  const override = process.env["VIBESTUDIO_BUILD_ARTIFACT_POOL_DIR"];
  if (override) return path.resolve(override);

  const userDataPath = path.resolve(getUserDataPath());
  const workspaceDir = path.dirname(userDataPath);
  const workspacesDir = path.resolve(getCentralDataPath(), "workspaces");
  if (path.basename(userDataPath) !== "state" || path.dirname(workspaceDir) !== workspacesDir) {
    return null;
  }
  return getCentralBuildArtifactPoolDir();
}

function getSharedBuildResultCacheDir(): string | null {
  const override = process.env["VIBESTUDIO_SHARED_BUILD_CACHE_DIR"];
  if (override) return path.resolve(override);

  const userDataPath = path.resolve(getUserDataPath());
  const workspaceDir = path.dirname(userDataPath);
  const workspacesDir = path.resolve(getCentralDataPath(), "workspaces");
  if (path.basename(userDataPath) !== "state" || path.dirname(workspaceDir) !== workspacesDir) {
    return null;
  }
  return getCentralBuildResultCacheDir();
}

function getSharedBuildDir(key: string): string | null {
  const cacheDir = getSharedBuildResultCacheDir();
  return cacheDir ? path.join(cacheDir, key) : null;
}

function isFileSystemErrorCode(error: unknown, codes: readonly string[]): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && codes.includes(code);
}

function warnCleanupFailure(pathName: string, error: unknown): void {
  console.warn(
    `[buildStore] Failed to remove ${pathName}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function linkBuildTreeSync(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      linkBuildTreeSync(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported build cache entry: ${sourcePath}`);
    }
    try {
      fs.linkSync(sourcePath, targetPath);
    } catch (error) {
      if (!isFileSystemErrorCode(error, ["EXDEV", "EPERM", "EACCES", "EMLINK"])) throw error;
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

function publishSharedBuild(key: string, sourceDir: string): void {
  const sharedDir = getSharedBuildDir(key);
  if (!sharedDir || fs.existsSync(path.join(sharedDir, "metadata.json"))) return;

  const tmpDir = `${sharedDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
  try {
    fs.mkdirSync(path.dirname(sharedDir), { recursive: true });
    linkBuildTreeSync(sourceDir, tmpDir);
    try {
      fs.renameSync(tmpDir, sharedDir);
    } catch (error) {
      if (!isFileSystemErrorCode(error, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) throw error;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (error) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      warnCleanupFailure(tmpDir, cleanupError);
    }
    console.warn(
      `[buildStore] Failed to publish shared build ${key}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function readArtifactContent(dir: string, entry: BuildArtifactManifestEntry): string {
  const filePath = path.join(dir, entry.path);
  return entry.encoding === "base64"
    ? fs.readFileSync(filePath, "base64")
    : fs.readFileSync(filePath, "utf-8");
}

function manifestForEntry(entry: BuildArtifactInput): BuildArtifactManifestEntry {
  return {
    path: entry.path,
    role: entry.role,
    contentType: entry.contentType,
    encoding: entry.encoding ?? "utf8",
    ...(entry.platform ? { platform: entry.platform } : {}),
    ...(entry.integrity ? { integrity: entry.integrity } : {}),
  };
}

function artifactIntegrity(entry: BuildArtifactInput): string {
  const bytes =
    (entry.encoding ?? "utf8") === "base64"
      ? Buffer.from(entry.content, "base64")
      : Buffer.from(entry.content, "utf-8");
  return `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function assertCanonicalArtifactManifestPaths(
  entries: readonly Pick<BuildArtifactManifestEntry, "path">[]
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const canonical = canonicalArtifactPath(entry.path);
    if (canonical !== entry.path) {
      throw new Error(`Build artifact path is not canonical: ${JSON.stringify(entry.path)}`);
    }
    if (seen.has(canonical)) {
      throw new Error(`Duplicate build artifact path: ${canonical}`);
    }
    seen.add(canonical);
  }
}

function integrityHex(integrity: string): string | null {
  const match = /^sha256-([a-f0-9]{64})$/.exec(integrity);
  return match?.[1] ?? null;
}

function artifactBlobPath(poolDir: string, integrity: string): string | null {
  const hex = integrityHex(integrity);
  return hex ? blobCasPath(poolDir, hex) : null;
}

function entryBytes(entry: BuildArtifactInput & { encoding: BuildArtifactEncoding }): Buffer {
  return entry.encoding === "base64"
    ? Buffer.from(entry.content, "base64")
    : Buffer.from(entry.content, "utf-8");
}

function writeArtifactFile(
  targetPath: string,
  entry: BuildArtifactInput & { encoding: BuildArtifactEncoding; integrity: string },
  poolDir: string | null
): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const bytes = entryBytes(entry);
  const blobPath = poolDir ? artifactBlobPath(poolDir, entry.integrity) : null;
  if (poolDir && blobPath) {
    const stored = putBlobBytesSync(poolDir, bytes);
    if (stored.filePath !== blobPath) {
      throw new Error(`Artifact integrity mismatch for ${entry.path}`);
    }
    try {
      fs.linkSync(blobPath, targetPath);
      return;
    } catch (error) {
      // Custom workspace paths can place state and the central pool on
      // different filesystems. Preserve correctness there, just without
      // physical deduplication.
      if (!isFileSystemErrorCode(error, ["EXDEV", "EPERM", "EACCES", "EMLINK"])) throw error;
    }
  }
  fs.writeFileSync(targetPath, bytes);
}

function buildArtifactSetIntegrity(entries: BuildArtifactManifestEntry[]): string {
  const canonical = entries
    .map((entry) => ({
      path: entry.path,
      role: entry.role,
      contentType: entry.contentType,
      encoding: entry.encoding,
      platform: entry.platform ?? null,
      integrity: entry.integrity ?? null,
    }))
    .sort((a, b) =>
      `${a.path}\0${a.platform ?? ""}`.localeCompare(`${b.path}\0${b.platform ?? ""}`)
    );
  return `sha256-${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function metadataForEntries(
  metadata: BuildMetadata,
  entries: BuildArtifactManifestEntry[]
): BuildMetadata {
  if (metadata.details.kind !== "app") return metadata;
  return {
    ...metadata,
    details: {
      ...metadata.details,
      integrity: buildArtifactSetIntegrity(entries),
    },
  };
}

function canonicalSourcePath(input: string): string {
  const value = input.replace(/\\/g, "/").normalize("NFC");
  if (!value || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`Invalid build source path: ${JSON.stringify(input)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid build source path: ${JSON.stringify(input)}`);
  }
  return value;
}

function computeArtifactDigest(entries: readonly BuildArtifactManifestEntry[]): Sha256 {
  const exactManifest = entries
    .map((entry) => ({
      path: entry.path.replace(/\\/g, "/").normalize("NFC"),
      role: entry.role,
      contentType: entry.contentType,
      encoding: entry.encoding,
      platform: entry.platform ?? null,
      integrity: entry.integrity ?? null,
    }))
    .sort((a, b) =>
      `${a.path}\0${a.platform ?? ""}`.localeCompare(`${b.path}\0${b.platform ?? ""}`)
    );
  return domainHash("vibestudio/build-v2-artifacts/v1", canonicalJson(exactManifest));
}

function createBuildExecutionIdentity(
  metadata: BuildMetadata,
  entries: readonly BuildArtifactManifestEntry[]
): BuildExecutionIdentity | undefined {
  if (metadata.sourceStateHash === null) return undefined;
  if (!metadata.sourcePath) {
    throw new Error(`Workspace build ${metadata.buildKey} is missing its source path`);
  }
  const source = {
    repoPath: canonicalSourcePath(metadata.sourcePath),
    effectiveVersion: parseSha256(metadata.ev, "build effective version"),
  };
  const buildInputDigest = parseSha256(metadata.buildKey, "BuildV2 build input digest");
  const artifactDigest = computeArtifactDigest(entries);
  const executionDigest = domainHash(
    "vibestudio/build-v2-execution/v1",
    canonicalJson({
      version: 1,
      source,
      buildInputDigest,
      artifactDigest,
    })
  );
  return {
    version: 1,
    source,
    buildInputDigest,
    artifactDigest,
    executionDigest,
  };
}

function verifiedExecutionIdentity(
  metadata: BuildMetadata,
  entries: readonly BuildArtifactManifestEntry[]
): BuildExecutionIdentity | undefined {
  const expected = createBuildExecutionIdentity(metadata, entries);
  if (!expected) {
    if (metadata.execution !== undefined) {
      throw new Error("External build metadata unexpectedly carries an execution identity");
    }
    return undefined;
  }
  if (canonicalJson(metadata.execution) !== canonicalJson(expected)) {
    throw new Error(`Build ${metadata.buildKey} execution identity does not match its artifacts`);
  }
  return expected;
}

export function has(key: string): boolean {
  // Cache presence means a fully verified immutable build, not merely a
  // metadata sentinel. This is especially important during cache-schema
  // migrations: state triggers must not announce legacy entries as complete.
  return get(key) !== null;
}

function readBuildDir(dir: string, expectedBuildKey: string): BuildResult | null {
  const metadataPath = path.join(dir, "metadata.json");

  if (!fs.existsSync(metadataPath)) return null;

  try {
    const rawMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as BuildMetadata;
    if (
      !("sourceStateHash" in rawMetadata) ||
      (rawMetadata.sourceStateHash !== null && typeof rawMetadata.sourceStateHash !== "string") ||
      rawMetadata.buildKey !== expectedBuildKey
    ) {
      return null;
    }
    const authority =
      rawMetadata.authority === undefined
        ? undefined
        : parseUnitAuthorityManifest(
            rawMetadata.authority,
            `build ${expectedBuildKey} metadata.authority`
          );
    // Every workspace-derived build must carry authority from the exact source
    // state. Only library builds with no workspace source coordinate may omit it.
    if (rawMetadata.sourceStateHash !== null && authority === undefined) return null;
    const metadata: BuildMetadata = { ...rawMetadata, ...(authority ? { authority } : {}) };
    const manifestPath = path.join(dir, "artifacts.json");
    if (!fs.existsSync(manifestPath)) return null;
    const storedManifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf-8")
    ) as BuildArtifactManifestEntry[];
    assertCanonicalArtifactManifestPaths(storedManifest);
    const artifacts = storedManifest.map((entry) => {
      if (!fs.existsSync(path.join(dir, entry.path))) {
        throw new Error(`Build artifact is missing: ${entry.path}`);
      }
      const artifact = { ...entry, content: readArtifactContent(dir, entry) };
      if (entry.integrity !== artifactIntegrity(artifact)) {
        throw new Error(`Build artifact integrity mismatch: ${entry.path}`);
      }
      return artifact;
    });
    const artifactManifest = artifacts.map(({ content: _content, ...entry }) => entry);
    verifiedExecutionIdentity(metadata, artifactManifest);
    return {
      dir,
      buildKey: expectedBuildKey,
      sourceStateHash: metadata.sourceStateHash,
      metadata: metadataForEntries(metadata, artifactManifest),
      artifacts,
    };
  } catch {
    return null;
  }
}

const reportedSharedBuildHits = new Set<string>();

export function get(key: string): BuildResult | null {
  const localDir = getBuildDir(key);
  const local = readBuildDir(localDir, key);
  if (local) {
    publishSharedBuild(key, localDir);
    return local;
  }

  const sharedDir = getSharedBuildDir(key);
  if (!sharedDir) return null;
  const shared = readBuildDir(sharedDir, key);
  if (shared && !reportedSharedBuildHits.has(key)) {
    reportedSharedBuildHits.add(key);
    console.info(`[BuildCache] Reused shared build ${shared.metadata.name} (${key.slice(0, 12)})`);
  }
  return shared;
}

export function primaryArtifact(
  build: Pick<BuildResult, "artifacts">,
  opts: { platform?: string } = {}
): BuildArtifactWithContent | null {
  return (
    build.artifacts.find(
      (entry) =>
        entry.role === "primary" &&
        (opts.platform === undefined || entry.platform === opts.platform)
    ) ?? null
  );
}

export function primaryTextArtifactContent(
  build: Pick<BuildResult, "artifacts" | "metadata">,
  opts: { platform?: string } = {}
): string {
  const artifact = primaryArtifact(build, opts);
  if (!artifact) {
    throw new Error(
      `Build ${build.metadata.name} has no primary artifact${opts.platform ? ` for ${opts.platform}` : ""}`
    );
  }
  if (artifact.encoding !== "utf8") {
    throw new Error(
      `Build ${build.metadata.name} primary artifact ${artifact.path} is not UTF-8 text`
    );
  }
  return artifact.content;
}

export function artifactFilePath(
  build: Pick<BuildResult, "dir">,
  artifact: Pick<BuildArtifactManifestEntry, "path">
): string {
  if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid build artifact path: ${artifact.path}`);
  }
  return path.join(build.dir, artifact.path);
}

export function primaryArtifactFilePath(
  build: Pick<BuildResult, "dir" | "artifacts" | "metadata">,
  opts: { platform?: string } = {}
): string {
  const artifact = primaryArtifact(build, opts);
  if (!artifact) {
    throw new Error(
      `Build ${build.metadata.name} has no primary artifact${opts.platform ? ` for ${opts.platform}` : ""}`
    );
  }
  return artifactFilePath(build, artifact);
}

export function put(key: string, artifacts: BuildArtifacts, metadata: BuildMetadata): BuildResult {
  if (metadata.execution !== undefined) {
    throw new Error("Build execution identity is derived by the store and cannot be supplied");
  }
  if (metadata.buildKey !== key) {
    throw new Error(
      `Build metadata key ${metadata.buildKey} does not match content-addressed store key ${key}`
    );
  }
  if (metadata.sourceStateHash !== null && metadata.authority === undefined) {
    throw new Error(`Workspace build ${key} is missing sealed authority metadata`);
  }
  const sealedMetadata: BuildMetadata =
    metadata.authority === undefined
      ? metadata
      : {
          ...metadata,
          authority: parseUnitAuthorityManifest(metadata.authority, `build ${key} authority`),
        };
  const dir = getBuildDir(key);
  const metadataPath = path.join(dir, "metadata.json");
  const artifactPoolDir = getSharedArtifactPoolDir();

  // Write to temp first, then rename atomically. Use crypto.randomBytes for
  // an unpredictable name — `${Date.now()}.${process.pid}` is guessable and
  // invites local symlink races (a co-tenant pre-creates the tmp path as a
  // symlink before our mkdirSync, redirecting our writes).
  const tmpDir = `${dir}.tmp.${crypto.randomBytes(16).toString("hex")}`;

  const entries = artifacts.entries.map((entry) => ({
    ...entry,
    encoding: entry.encoding ?? "utf8",
    integrity: artifactIntegrity(entry),
  }));
  if (entries.length === 0) {
    throw new Error(`Build ${key} has no artifact entries`);
  }
  assertCanonicalArtifactManifestPaths(entries);
  const artifactManifest = entries.map(manifestForEntry);
  const metadataWithEntries = metadataForEntries(sealedMetadata, artifactManifest);
  const execution = createBuildExecutionIdentity(metadataWithEntries, artifactManifest);
  const storedMetadata: BuildMetadata = {
    ...metadataWithEntries,
    ...(execution ? { execution } : {}),
  };

  fs.mkdirSync(tmpDir, { recursive: true });
  for (const entry of entries) {
    const targetPath = path.join(tmpDir, entry.path);
    writeArtifactFile(targetPath, entry, artifactPoolDir);
  }

  // Ensure Node.js treats bundle.js as ESM.
  if (storedMetadata.kind === "worker" || storedMetadata.kind === "extension") {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');
  }

  fs.writeFileSync(path.join(tmpDir, "artifacts.json"), JSON.stringify(artifactManifest, null, 2));

  // Write metadata (sentinel) inside tmpDir BEFORE rename so winner is always complete
  fs.writeFileSync(path.join(tmpDir, "metadata.json"), JSON.stringify(storedMetadata, null, 2));

  // Race-safe promotion: try rename, handle concurrent winner
  try {
    fs.renameSync(tmpDir, dir);
  } catch (err: unknown) {
    if (isFileSystemErrorCode(err, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) {
      // Another build may have won the race. Accept it only after the same
      // integrity + execution-identity verification used by normal reads.
      // Legacy or corrupt cache directories also have a metadata sentinel, so
      // sentinel presence alone must never prevent the current build replacing
      // them during an identity-schema migration.
      if (fs.existsSync(metadataPath)) {
        const winner = get(key);
        if (winner) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          return winner;
        }
      }
      // Winner incomplete, corrupt, or from an obsolete identity schema —
      // remove the disposable cache entry and promote the verified build.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmpDir, dir);
      } catch {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          warnCleanupFailure(tmpDir, cleanupError);
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (cleanupError) {
          warnCleanupFailure(dir, cleanupError);
        }
        throw new Error(`Build store race: failed to store build for key ${key}`);
      }
    } else {
      // Clean up tmpDir on unexpected errors
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        warnCleanupFailure(tmpDir, cleanupError);
      }
      throw err;
    }
  }

  const stored = assertPresent(readBuildDir(dir, key));
  publishSharedBuild(key, dir);
  return stored;
}

export function gc(activeKeys: Set<string>): { freed: number } {
  const buildsDir = getBuildsDir();
  if (!fs.existsSync(buildsDir)) return { freed: 0 };

  let freed = 0;
  for (const entry of fs.readdirSync(buildsDir)) {
    if (!activeKeys.has(entry)) {
      const entryPath = path.join(buildsDir, entry);
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        freed++;
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return { freed };
}

export interface BuildArtifactDedupeResult {
  scanned: number;
  linked: number;
  alreadyShared: number;
  skipped: number;
  estimatedBytesFreed: number;
  errors: string[];
}

function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  // ino is documented as zero on some Windows filesystems. Treat zero as
  // unknown instead of incorrectly declaring every file shared.
  return a.dev === b.dev && a.ino !== 0 && a.ino === b.ino;
}

function ensureArtifactBlobFromFile(
  poolDir: string,
  integrity: string,
  sourcePath: string
): string {
  const digest = integrityHex(integrity);
  if (!digest) throw new Error("Invalid artifact integrity");
  return linkBlobFileSync(poolDir, digest, sourcePath);
}

function replaceWithHardlink(filePath: string, blobPath: string): void {
  const tmpPath = `${filePath}.dedupe.${crypto.randomBytes(16).toString("hex")}`;
  fs.linkSync(blobPath, tmpPath);
  try {
    // Atomic on the managed-workspace filesystems we support: readers see
    // either the old complete file or the shared complete inode.
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupError) {
      if (!isFileSystemErrorCode(cleanupError, ["ENOENT"])) {
        warnCleanupFailure(tmpPath, cleanupError);
      }
    }
    throw error;
  }
}

/**
 * Relink existing build payloads into the shared artifact CAS.
 *
 * This intentionally leaves metadata.json, artifacts.json and package.json in
 * the workspace build directory. They are tiny and metadata is workspace-local.
 */
export function dedupeBuildArtifacts(
  buildsDir = getBuildsDir(),
  poolDir = getCentralBuildArtifactPoolDir()
): BuildArtifactDedupeResult {
  const result: BuildArtifactDedupeResult = {
    scanned: 0,
    linked: 0,
    alreadyShared: 0,
    skipped: 0,
    estimatedBytesFreed: 0,
    errors: [],
  };
  if (!fs.existsSync(buildsDir)) return result;

  for (const buildEntry of fs.readdirSync(buildsDir, { withFileTypes: true })) {
    if (!buildEntry.isDirectory()) continue;
    const buildDir = path.join(buildsDir, buildEntry.name);
    const manifestPath = path.join(buildDir, "artifacts.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: BuildArtifactManifestEntry[];
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as BuildArtifactManifestEntry[];
    } catch (error) {
      result.errors.push(
        `${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    for (const entry of manifest) {
      result.scanned++;
      if (
        !entry.integrity ||
        path.isAbsolute(entry.path) ||
        entry.path.split(/[\\/]/).includes("..")
      ) {
        result.skipped++;
        continue;
      }
      const blobPath = artifactBlobPath(poolDir, entry.integrity);
      const filePath = path.join(buildDir, entry.path);
      if (!blobPath || !fs.existsSync(filePath)) {
        result.skipped++;
        continue;
      }

      try {
        ensureArtifactBlobFromFile(poolDir, entry.integrity, filePath);
        const fileStat = fs.statSync(filePath);
        const blobStat = fs.statSync(blobPath);
        if (sameInode(fileStat, blobStat)) {
          result.alreadyShared++;
          continue;
        }
        if (fileStat.size !== blobStat.size) {
          throw new Error(
            `integrity collision or corrupt artifact (${fileStat.size} != ${blobStat.size})`
          );
        }
        replaceWithHardlink(filePath, blobPath);
        result.linked++;
        if (fileStat.nlink === 1) result.estimatedBytesFreed += fileStat.blocks * 512;
      } catch (error) {
        result.errors.push(
          `${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return result;
}
