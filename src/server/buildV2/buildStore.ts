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
 * Same key = same content. Online deletion is owned exclusively by the
 * publication-interlocked mark/quarantine/sweep collector below.
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
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
  type ExecutionSourceStateRef,
  type ExecutionSourceContentRoot,
} from "@vibestudio/shared/execution/retention";
import { assertPresent } from "../../lintHelpers";
import { blobCasPath, centralBlobCasDir, putBlobBytesSync } from "../storage/blobCas.js";
import { stateLayout } from "../stateLayout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildArtifacts {
  entries: BuildArtifactInput[];
}

export type BuildArtifactRole =
  | "primary"
  | "asset"
  | "html"
  | "css"
  | "shared-style"
  | "map"
  | "wasm";
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
  /** Stored byte length, used to reject truncation without loading the payload. */
  byteLength?: number;
  platform?: string;
  integrity?: string;
}

export type BuildArtifactWithContent = BuildArtifactManifestEntry & { content: string };

/**
 * Immutable executable identity sealed at the build-store boundary.
 *
 * The shared ref commits semantic provenance, traversable source roots,
 * BuildV2's recipe/cache identity, and the exact emitted artifact manifest.
 * `executionDigest` is the producer-neutral code principal commitment.
 */
export type BuildExecutionIdentity = ExecutionArtifactRefV1;

export type ExtensionMethodAuthority = Record<
  string,
  | { effect: { kind: "open" } }
  | {
      effect: {
        kind: "userland-capability";
        capability: string;
        resource: { kind: "receiver" };
      };
      userlandCapability: {
        canonicalCapability: string;
        definitionDigest: string;
        resourceType: string;
        grantScopes: readonly import("@vibestudio/shared/authorityManifest").UserlandGrantScope[];
        title: string;
        action: string;
        description?: string;
      };
    }
>;

export type BuildMetadataDetails =
  | {
      kind: "extension";
      runtimeDepsKey: string | null;
      runtimeAbi: string | null;
      providerContracts: Record<string, { methods: string[] }>;
      methodAuthority: ExtensionMethodAuthority;
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
  /** Exact immutable source provenance paired with sourceStateHash. */
  sourceState?: ExecutionSourceStateRef | null;
  sourcemap: boolean;
  framework?: string;
  /** Deterministic report-only panel payload baseline derived from esbuild. */
  bundleReport?: import("./panelBundleReport.js").PanelBundleReport;
  /** Content-addressed base styles loaded before panel-specific CSS. */
  sharedStyles?: Array<{
    digest: string;
    contentType: string;
    url: string;
  }>;
  /** Authority sealed from the exact materialized source manifest. */
  authority?: UnitAuthorityManifest;
  /** Panel state-argument schema sealed from the exact materialized manifest. */
  stateArgsSchema?: import("@vibestudio/shared/stateArgs").StateArgsSchema;
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
  /**
   * Target-agnostic artifact manifest. Persisted payloads are loaded and
   * integrity-checked on first access to `content`, then retained in memory.
   */
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

function artifactByteLength(entry: Pick<BuildArtifactInput, "content" | "encoding">): number {
  return (entry.encoding ?? "utf8") === "base64"
    ? Buffer.from(entry.content, "base64").byteLength
    : Buffer.byteLength(entry.content, "utf8");
}

function manifestForEntry(entry: BuildArtifactInput): BuildArtifactManifestEntry {
  return {
    path: entry.path,
    role: entry.role,
    contentType: entry.contentType,
    encoding: entry.encoding ?? "utf8",
    byteLength: artifactByteLength(entry),
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

function lazyArtifactContent(
  dir: string,
  entry: BuildArtifactManifestEntry
): BuildArtifactWithContent {
  let loaded = false;
  let content = "";
  const artifact = { ...entry } as BuildArtifactWithContent;
  Object.defineProperty(artifact, "content", {
    enumerable: true,
    configurable: false,
    get() {
      if (!loaded) {
        const next = readArtifactContent(dir, entry);
        if (entry.integrity !== artifactIntegrity({ ...entry, content: next })) {
          throw new Error(`Build artifact integrity mismatch: ${entry.path}`);
        }
        content = next;
        loaded = true;
      }
      return content;
    },
  });
  return artifact;
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
  if (!metadata.sourceState) {
    throw new Error(`Workspace build ${metadata.buildKey} is missing exact source state`);
  }
  if (!activeExecutionIdentityContext) {
    throw new Error(`Workspace build ${metadata.buildKey} has no execution identity context`);
  }
  const contentRoots = [
    {
      repoPath: canonicalSourcePath(metadata.sourcePath),
      stateHash: metadata.sourceStateHash,
    },
  ] as const;
  const sourceState = {
    kind: "workspace" as const,
    workspaceId: activeExecutionIdentityContext.workspaceId,
    effectiveVersion: parseSha256(metadata.ev, "build effective version"),
    state: metadata.sourceState,
    contentRoots,
    sourceClosureDigest: executionSourceClosureDigest(contentRoots),
  };
  // BuildV2's cache key currently commits both its recipe inputs and source.
  // The shared verifier does not impose this equality on other producers.
  const recipeDigest = parseSha256(metadata.buildKey, "BuildV2 recipe digest");
  const buildKey = parseSha256(metadata.buildKey, "BuildV2 build key");
  const artifactDigest = computeArtifactDigest(entries);
  const unsigned = {
    version: 1,
    sourceState,
    recipeDigest,
    buildKey,
    artifactDigest,
  } as const;
  return verifyExecutionArtifactRef({
    ...unsigned,
    executionDigest: executionArtifactDigest(unsigned),
  });
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
  // Cache presence means a complete, identity-verified manifest whose files
  // exist at their sealed lengths. Payload hashes are verified when consumed.
  // This keeps lazy artifacts off startup while rejecting partial cache trees.
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
      const artifactPath = path.join(dir, entry.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(artifactPath);
      } catch {
        throw new Error(`Build artifact is missing: ${entry.path}`);
      }
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(entry.byteLength) ||
        (entry.byteLength ?? -1) < 0 ||
        stat.size !== entry.byteLength
      ) {
        throw new Error(`Build artifact size mismatch: ${entry.path}`);
      }
      return lazyArtifactContent(dir, entry);
    });
    verifiedExecutionIdentity(metadata, storedManifest);
    return {
      dir,
      buildKey: expectedBuildKey,
      sourceStateHash: metadata.sourceStateHash,
      metadata: metadataForEntries(metadata, storedManifest),
      artifacts,
    };
  } catch {
    return null;
  }
}

const reportedSharedBuildHits = new Set<string>();

/**
 * Verify one workspace-owned build without publishing it to, or materializing
 * it from, the shared reconstruction cache. Diagnostics and retention root
 * snapshots must not turn a read into new local ownership.
 */
export function peekLocal(key: string): BuildResult | null {
  return readBuildDir(getBuildDir(key), key);
}

export function get(key: string): BuildResult | null {
  const localDir = getBuildDir(key);
  const local = readBuildDir(localDir, key);
  if (local) {
    publishSharedBuild(key, localDir);
    return local;
  }

  const sharedDir = getSharedBuildDir(key);
  if (!sharedDir) return null;
  // A workspace GC tombstone is authoritative over the shared reconstruction
  // cache. Without this check a successful sweep would immediately resurrect
  // the same local record on the next lookup.
  if (isRetiredBuildKey(key)) return null;
  const shared = readBuildDir(sharedDir, key);
  if (shared) {
    // A shared result is only a reconstruction cache, never an authoritative
    // workspace record. Materialize a local immutable link tree before it can
    // be returned to an owner/publication path so workspace retention has one
    // complete census and a different workspace's collector cannot break it.
    const tmpDir = `${localDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
    try {
      fs.mkdirSync(path.dirname(localDir), { recursive: true });
      linkBuildTreeSync(sharedDir, tmpDir);
      try {
        fs.renameSync(tmpDir, localDir);
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
      throw error;
    }
  }
  const materialized = readBuildDir(localDir, key);
  if (materialized && !reportedSharedBuildHits.has(key)) {
    reportedSharedBuildHits.add(key);
    console.info(
      `[BuildCache] Reused shared build ${materialized.metadata.name} (${key.slice(0, 12)})`
    );
  }
  return materialized;
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
  const metadataWithSourceState: BuildMetadata =
    metadata.sourceStateHash === null
      ? { ...metadata, sourceState: null }
      : {
          ...metadata,
          sourceState:
            metadata.sourceState ??
            activeExecutionIdentityContext?.executionStateForContent(metadata.sourceStateHash) ??
            null,
        };
  const sealedMetadata: BuildMetadata =
    metadata.authority === undefined
      ? metadataWithSourceState
      : {
          ...metadataWithSourceState,
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
      // manifest + execution-identity verification used by normal reads.
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

      // An existing immutable build directory is never removed online. A
      // corrupt/obsolete entry needs deliberate offline repair; replacing it
      // here would be an uncoordinated artifact deletion indistinguishable from
      // retention GC to live registries.
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        warnCleanupFailure(tmpDir, cleanupError);
      }
      throw new Error(
        `Immutable build directory ${key} already exists but is invalid; stop the server and remove it before rebuilding`
      );
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
  clearRetiredBuildKey(key);
  publishSharedBuild(key, dir);
  return stored;
}

let activeExecutionIdentityContext: {
  workspaceId: string;
  executionStateForContent: (stateHash: string) => ExecutionSourceStateRef | null;
} | null = null;

export function setBuildExecutionIdentityContext(
  context: typeof activeExecutionIdentityContext
): void {
  if (context && !context.workspaceId) throw new Error("Build execution workspaceId is required");
  activeExecutionIdentityContext = context;
}

export interface BuildStoreRetentionScan {
  builds: Array<{ key: string; bytes: number }>;
  failures: Array<{ key: string; error: string }>;
}

export type BuildGcMode = "report" | "quarantine" | "sweep";

interface QuarantinedBuild {
  key: string;
  firstUnmarkedEpoch: number;
  quarantinedAt: number;
  sourceRoots: ExecutionSourceContentRoot[];
  deletedAtEpoch?: number;
}

interface BuildGcState {
  version: 1;
  quarantined: QuarantinedBuild[];
}

export interface BuildStoreGcResult {
  quarantined: number;
  deleted: number;
  retainedForGrace: number;
  notReconstructible: Array<{ buildKey: string; missing: string[] }>;
  cleanupFailures: Array<{ buildKey: string; error: string }>;
  /** Includes quarantine and just-deleted tombstones for content-GC ordering. */
  retainedSourceRoots: ExecutionSourceContentRoot[];
}

function buildGcStatePath(): string {
  return stateLayout(getUserDataPath()).executionRetention.buildGcFile;
}

function loadBuildGcState(): BuildGcState {
  const filePath = buildGcStatePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BuildGcState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.quarantined)) {
      throw new Error("Build GC state has an unsupported schema");
    }
    const quarantined = parsed.quarantined.map((record, index): QuarantinedBuild => {
      if (
        !record ||
        typeof record.key !== "string" ||
        !Number.isSafeInteger(record.firstUnmarkedEpoch) ||
        record.firstUnmarkedEpoch < 0 ||
        typeof record.quarantinedAt !== "number" ||
        !Array.isArray(record.sourceRoots) ||
        record.sourceRoots.some(
          (root) =>
            !root ||
            (root.repoPath !== null && typeof root.repoPath !== "string") ||
            !/^state:[0-9a-f]{64}$/u.test(root.stateHash)
        ) ||
        (record.deletedAtEpoch !== undefined &&
          (!Number.isSafeInteger(record.deletedAtEpoch) || record.deletedAtEpoch < 0))
      ) {
        throw new Error(`Build GC state record ${index} is invalid`);
      }
      return record;
    });
    return { version: 1, quarantined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, quarantined: [] };
    }
    throw error;
  }
}

function saveBuildGcState(state: BuildGcState): void {
  const filePath = buildGcStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp.${crypto.randomBytes(12).toString("hex")}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function isRetiredBuildKey(key: string): boolean {
  return loadBuildGcState().quarantined.some(
    (record) => record.key === key && record.deletedAtEpoch !== undefined
  );
}

function clearRetiredBuildKey(key: string): void {
  const state = loadBuildGcState();
  const quarantined = state.quarantined.filter((record) => record.key !== key);
  if (quarantined.length !== state.quarantined.length) {
    saveBuildGcState({ version: 1, quarantined });
  }
}

function sourceRootsForStoredBuild(key: string): ExecutionSourceContentRoot[] | null {
  const build = readBuildDir(getBuildDir(key), key);
  if (
    !build?.metadata.execution ||
    build.metadata.execution.sourceState.kind !== "workspace" ||
    !build.metadata.sourceState
  ) {
    return null;
  }
  return [...build.metadata.execution.sourceState.contentRoots];
}

function retainedSourceRootsForEpoch(
  records: Iterable<QuarantinedBuild>,
  epoch: number
): ExecutionSourceContentRoot[] {
  const rootSet = new Map<string, ExecutionSourceContentRoot>();
  for (const record of records) {
    if (record.deletedAtEpoch !== undefined && epoch > record.deletedAtEpoch) continue;
    for (const root of record.sourceRoots) {
      rootSet.set(`${root.repoPath ?? ""}\0${root.stateHash}`, root);
    }
  }
  return [...rootSet.values()].sort(
    (left, right) =>
      (left.repoPath ?? "").localeCompare(right.repoPath ?? "") ||
      left.stateHash.localeCompare(right.stateHash)
  );
}

/**
 * Mark/quarantine/sweep over workspace-owned immutable build records.
 *
 * Quarantine is metadata-only so an old last-good remains instantly launchable.
 * Deletion commits with an atomic rename; source roots remain in a tombstone
 * through that whole epoch and can only be withdrawn by a later epoch.
 */
export async function collectRetention(input: {
  epoch: number;
  mode: BuildGcMode;
  rootedBuildKeys: ReadonlySet<string>;
  publicationProtectedBuildKeys: ReadonlySet<string>;
  graceMs: number;
  commitArtifactDeletion?: (buildKey: string, commit: () => void) => boolean;
  now?: number;
}): Promise<BuildStoreGcResult> {
  const now = input.now ?? Date.now();
  const state = loadBuildGcState();
  const scan = await scanRetention();
  const stored = new Set(scan.builds.map((build) => build.key));
  const protectedKeys = new Set([...input.rootedBuildKeys, ...input.publicationProtectedBuildKeys]);
  const byKey = new Map(state.quarantined.map((record) => [record.key, record]));
  const result: BuildStoreGcResult = {
    quarantined: 0,
    deleted: 0,
    retainedForGrace: 0,
    notReconstructible: [],
    cleanupFailures: [
      ...scan.failures.map((failure) => ({ buildKey: failure.key, error: failure.error })),
    ],
    retainedSourceRoots: [],
  };

  // Recover the atomic-rename/persist crash window. The owned trash name is
  // durable evidence that deletion committed; without it, a vanished artifact
  // is external corruption and must remain an alarm rather than being inferred
  // from age or epoch.
  const trashRoot = stateLayout(getUserDataPath()).executionRetention.buildTrashDir;
  const trashEntries = fs.existsSync(trashRoot) ? await fs.promises.readdir(trashRoot) : [];
  const newSourceRoots = new Map<string, ExecutionSourceContentRoot[]>();

  // Diagnose every deletion prerequisite before mutating anything. A corrupt
  // artifact makes the whole pass fail closed; otherwise iteration order could
  // delete a healthy sibling before discovering the alarm.
  for (const [key, record] of byKey) {
    if (record.deletedAtEpoch !== undefined || stored.has(key)) continue;
    const matches = trashEntries.filter((entry) => entry.startsWith(`${key}.`));
    if (matches.length !== 1) {
      result.notReconstructible.push({
        buildKey: key,
        missing: matches.length === 0 ? ["artifact bytes"] : ["unambiguous owned deletion record"],
      });
    }
  }
  for (const key of stored) {
    if (protectedKeys.has(key) || byKey.has(key)) continue;
    const sourceRoots = sourceRootsForStoredBuild(key);
    if (sourceRoots) {
      newSourceRoots.set(key, sourceRoots);
    } else {
      result.notReconstructible.push({
        buildKey: key,
        missing: ["verified execution metadata or source content roots"],
      });
    }
  }
  if (input.mode === "report" || result.notReconstructible.length > 0) {
    const retained = new Map<string, ExecutionSourceContentRoot>();
    for (const root of retainedSourceRootsForEpoch(byKey.values(), input.epoch)) {
      retained.set(`${root.repoPath ?? ""}\0${root.stateHash}`, root);
    }
    // A report is also the preparation snapshot for the coordinated
    // collector. Every currently unreferenced artifact remains alive until a
    // later commit, so its source must be preflighted and retained too.
    for (const roots of newSourceRoots.values()) {
      for (const root of roots) {
        retained.set(`${root.repoPath ?? ""}\0${root.stateHash}`, root);
      }
    }
    result.retainedSourceRoots = [...retained.values()].sort(
      (left, right) =>
        (left.repoPath ?? "").localeCompare(right.repoPath ?? "") ||
        left.stateHash.localeCompare(right.stateHash)
    );
    return result;
  }

  for (const [key, record] of byKey) {
    if (record.deletedAtEpoch !== undefined || stored.has(key)) continue;
    const matches = trashEntries.filter((entry) => entry.startsWith(`${key}.`));
    // Preflight above proved exactly one owned atomic-rename record exists.
    const trashDir = path.join(trashRoot, matches[0]!);
    if (protectedKeys.has(key)) {
      try {
        fs.renameSync(trashDir, getBuildDir(key));
        stored.add(key);
        byKey.delete(key);
      } catch (error) {
        result.cleanupFailures.push({
          buildKey: key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    record.deletedAtEpoch = input.epoch;
    saveBuildGcState({ version: 1, quarantined: [...byKey.values()] });
    try {
      await fs.promises.rm(trashDir, { recursive: true, force: true });
    } catch (error) {
      result.cleanupFailures.push({
        buildKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A root reappearing during grace rescues the artifact and clears quarantine.
  for (const key of protectedKeys) {
    const record = byKey.get(key);
    if (record && record.deletedAtEpoch === undefined) byKey.delete(key);
  }

  for (const key of stored) {
    if (protectedKeys.has(key)) continue;
    let record = byKey.get(key);
    if (!record) {
      const sourceRoots = newSourceRoots.get(key)!;
      record = {
        key,
        firstUnmarkedEpoch: input.epoch,
        quarantinedAt: now,
        sourceRoots,
      };
      byKey.set(key, record);
      result.quarantined += 1;
      continue;
    }
    if (record.deletedAtEpoch !== undefined) continue;
    const eligible =
      input.mode === "sweep" &&
      input.epoch > record.firstUnmarkedEpoch &&
      now - record.quarantinedAt >= input.graceMs &&
      !input.publicationProtectedBuildKeys.has(key);
    if (!eligible) {
      result.retainedForGrace += 1;
      continue;
    }

    const sourceDir = getBuildDir(key);
    const sourceBuild = readBuildDir(sourceDir, key);
    const artifactIntegrities = (sourceBuild?.artifacts ?? [])
      .map((artifact) => artifact.integrity)
      .filter((integrity): integrity is string => typeof integrity === "string");
    const trashDir = path.join(
      stateLayout(getUserDataPath()).executionRetention.buildTrashDir,
      `${key}.${input.epoch}.${crypto.randomBytes(8).toString("hex")}`
    );
    try {
      fs.mkdirSync(path.dirname(trashDir), { recursive: true, mode: 0o700 });
      // Synchronous rename is the deletion commit point. A publication
      // reservation cannot interleave inside this critical section.
      const committed =
        input.commitArtifactDeletion?.(key, () => fs.renameSync(sourceDir, trashDir)) ?? false;
      if (!committed) {
        result.retainedForGrace += 1;
        continue;
      }
      record.deletedAtEpoch = input.epoch;
      saveBuildGcState({ version: 1, quarantined: [...byKey.values()] });
      result.deleted += 1;
      let sharedTrashDir: string | null = null;
      const sharedDir = getSharedBuildDir(key);
      if (sharedDir) {
        try {
          const metadataStat = fs.statSync(path.join(sharedDir, "metadata.json"));
          // One link belongs to the shared cache and one to the local record
          // just moved to trash. More links prove another workspace has
          // materialized the artifact and still owns its local lifecycle.
          if (metadataStat.nlink <= 2) {
            sharedTrashDir = `${sharedDir}.gc.${crypto.randomBytes(8).toString("hex")}`;
            fs.renameSync(sharedDir, sharedTrashDir);
          }
        } catch (error) {
          if (!isFileSystemErrorCode(error, ["ENOENT"])) {
            result.cleanupFailures.push({
              buildKey: key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      try {
        await fs.promises.rm(trashDir, { recursive: true, force: true });
        if (sharedTrashDir) {
          await fs.promises.rm(sharedTrashDir, { recursive: true, force: true });
        }
        const poolDir = getSharedArtifactPoolDir();
        if (!poolDir) continue;
        for (const integrity of artifactIntegrities) {
          const blobPath = artifactBlobPath(poolDir, integrity);
          if (!blobPath) continue;
          try {
            const stat = await fs.promises.stat(blobPath);
            if (stat.nlink === 1) await fs.promises.unlink(blobPath);
          } catch (error) {
            if (!isFileSystemErrorCode(error, ["ENOENT"])) throw error;
          }
        }
      } catch (error) {
        result.cleanupFailures.push({
          buildKey: key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      result.cleanupFailures.push({
        buildKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A deleted artifact's source is retained for its deletion epoch. Only a
  // later complete epoch may remove the tombstone and withdraw those roots.
  saveBuildGcState({ version: 1, quarantined: [...byKey.values()] });

  result.retainedSourceRoots = retainedSourceRootsForEpoch(byKey.values(), input.epoch);
  return result;
}

async function storedPathBytes(storedPath: string): Promise<number> {
  const stat = await fs.promises.lstat(storedPath);
  if (!stat.isDirectory()) return stat.size;

  let bytes = 0;
  for (const entry of await fs.promises.readdir(storedPath)) {
    bytes += await storedPathBytes(path.join(storedPath, entry));
  }
  return bytes;
}

/**
 * Inspect immutable build storage without mutating it. Mutation is a separate
 * explicit collector phase so report mode cannot accidentally reclaim bytes.
 */
export async function scanRetention(): Promise<BuildStoreRetentionScan> {
  const buildsDir = getBuildsDir();
  if (!fs.existsSync(buildsDir)) return { builds: [], failures: [] };

  const builds: BuildStoreRetentionScan["builds"] = [];
  const failures: BuildStoreRetentionScan["failures"] = [];
  for (const entry of await fs.promises.readdir(buildsDir)) {
    try {
      builds.push({
        key: entry,
        bytes: await storedPathBytes(path.join(buildsDir, entry)),
      });
    } catch (error) {
      failures.push({
        key: entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { builds, failures };
}
