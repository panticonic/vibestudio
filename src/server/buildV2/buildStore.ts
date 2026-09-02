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
import { canonicalJson } from "@vibestudio/content-addressing";
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
import { blobCasPath, centralBlobCasDir, putBlobBytes } from "../storage/blobCas.js";
import { stateLayout } from "../stateLayout.js";
import {
  derivedCacheCoordinator,
  scheduleDerivedCachePrune,
} from "@vibestudio/shared/derivedCache";
export { contentTypeForPath } from "@vibestudio/shared/contentType";

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

export interface ExecutableModuleInput {
  moduleId: string;
  contentDigest: string;
  package:
    | { kind: "first-party" }
    | { kind: "workspace"; name: string; effectiveVersion: string }
    | { kind: "external"; name: string; version: string; packageDigest: string };
  format: "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
  source: string;
}

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
      dependencyPatches?: Array<{
        selector: string;
        packageName: string;
        version: string;
        owner: string;
        roots: string[];
        content: string;
        digest: string;
      }>;
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
  | {
      kind: "test";
      suite: string;
      runtime: "browser" | "workerd";
      selectedFiles: string[];
    }
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
  /** Exact implementation modules selected by the successful executable build. */
  executableModules?: ExecutableModuleInput[];
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

function executionMetadataPath(dir: string, executionDigest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(executionDigest)) {
    throw new Error(`Invalid build execution digest: ${executionDigest}`);
  }
  return path.join(dir, "executions", `${executionDigest}.json`);
}

interface StoredExecutionVariant {
  version: 1;
  sourceStateHash: string;
  sourceState: ExecutionSourceStateRef;
  execution: BuildExecutionIdentity;
}

function executionVariant(metadata: BuildMetadata): StoredExecutionVariant | null {
  if (!metadata.execution || !metadata.sourceStateHash || !metadata.sourceState) return null;
  return {
    version: 1,
    sourceStateHash: metadata.sourceStateHash,
    sourceState: metadata.sourceState,
    execution: metadata.execution,
  };
}

async function writeExecutionMetadata(dir: string, metadata: BuildMetadata): Promise<void> {
  const digest = metadata.execution?.executionDigest;
  if (!digest) return;
  const variant = executionVariant(metadata);
  if (!variant) throw new Error(`Build ${metadata.buildKey} has incomplete execution metadata`);
  const target = executionMetadataPath(dir, digest);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${crypto.randomBytes(12).toString("hex")}`;
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(variant, null, 2)}\n`);
    await fs.promises.rename(tmp, target);
  } catch (error) {
    try {
      await fs.promises.rm(tmp, { force: true });
    } catch (cleanupError) {
      warnCleanupFailure(tmp, cleanupError);
    }
    throw error;
  }
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

async function linkBuildTree(sourceDir: string, targetDir: string): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await linkBuildTree(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported build cache entry: ${sourcePath}`);
    }
    try {
      await fs.promises.link(sourcePath, targetPath);
    } catch (error) {
      if (!isFileSystemErrorCode(error, ["EXDEV", "EPERM", "EACCES", "EMLINK"])) throw error;
      await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

async function publishSharedBuild(key: string, sourceDir: string): Promise<void> {
  const sharedDir = getSharedBuildDir(key);
  if (!sharedDir) return;
  const cacheRoot = path.dirname(sharedDir);
  if (fs.existsSync(path.join(sharedDir, "metadata.json"))) {
    return;
  }

  const tmpDir = `${sharedDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
  try {
    await fs.promises.mkdir(path.dirname(sharedDir), { recursive: true });
    await linkBuildTree(sourceDir, tmpDir);
    try {
      await fs.promises.rename(tmpDir, sharedDir);
    } catch (error) {
      if (!isFileSystemErrorCode(error, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) throw error;
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  } catch (error) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      warnCleanupFailure(tmpDir, cleanupError);
    }
    throw error;
  } finally {
    void scheduleDerivedCachePrune(cacheRoot).catch((error) => {
      console.warn(
        `[buildStore] Shared cache prune failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

// Shared builds are a reconstruction cache, not part of the durability commit
// for a workspace-owned build. Publish each exact immutable tree once in the
// background. The temporary-tree + atomic-rename protocol makes publication
// safe against both concurrent publishers and the cache collector without a
// writer lease: temporary trees are excluded from collection and a published
// tree may be collected immediately without affecting its workspace owner.
const sharedBuildPublicationTasks = new Map<string, Promise<void>>();

function scheduleSharedBuildPublication(key: string, sourceDir: string): void {
  const sharedDir = getSharedBuildDir(key);
  if (!sharedDir) return;
  const publicationId = path.resolve(sharedDir);
  if (
    fs.existsSync(path.join(sharedDir, "metadata.json")) ||
    sharedBuildPublicationTasks.has(publicationId)
  ) {
    return;
  }
  const task = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => publishSharedBuild(key, sourceDir))
    .finally(() => {
      sharedBuildPublicationTasks.delete(publicationId);
    });
  sharedBuildPublicationTasks.set(publicationId, task);
  void task.catch((error) => {
    console.warn(
      `[buildStore] Shared build publication failed for ${key}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

function readArtifactContent(dir: string, entry: BuildArtifactManifestEntry): string {
  const filePath = path.join(dir, entry.path);
  return entry.encoding === "base64"
    ? fs.readFileSync(filePath, "base64")
    : fs.readFileSync(filePath, "utf-8");
}

/** Read and verify one artifact without blocking the workspace-server thread. */
export async function readArtifactBytesAsync(
  build: Pick<BuildResult, "dir">,
  entry: BuildArtifactManifestEntry
): Promise<Buffer> {
  const bytes = await fs.promises.readFile(artifactFilePath(build, entry));
  const digest = Buffer.from(await crypto.webcrypto.subtle.digest("SHA-256", bytes)).toString(
    "hex"
  );
  if (entry.integrity !== `sha256-${digest}`) {
    throw new Error(`Build artifact integrity mismatch: ${entry.path}`);
  }
  return bytes;
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

async function writeArtifactFile(
  targetPath: string,
  entry: BuildArtifactInput & { encoding: BuildArtifactEncoding; integrity: string },
  poolDir: string | null
): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const bytes = entryBytes(entry);
  const blobPath = poolDir ? artifactBlobPath(poolDir, entry.integrity) : null;
  if (poolDir && blobPath) {
    const stored = await putBlobBytes(poolDir, bytes);
    if (stored.digest !== integrityHex(entry.integrity)) {
      throw new Error(`Artifact integrity mismatch for ${entry.path}`);
    }
    try {
      await fs.promises.link(blobPath, targetPath);
      return;
    } catch (error) {
      // Custom workspace paths can place state and the central pool on
      // different filesystems. Preserve correctness there, just without
      // physical deduplication.
      if (!isFileSystemErrorCode(error, ["EXDEV", "EPERM", "EACCES", "EMLINK"])) throw error;
    }
  }
  await fs.promises.writeFile(targetPath, bytes);
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const value = values[cursor++];
        if (value !== undefined) await work(value);
      }
    })
  );
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

function readBuildDir(
  dir: string,
  expectedBuildKey: string,
  options: { verifyExecution?: boolean } = {}
): BuildResult | null {
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
    if (options.verifyExecution !== false) {
      verifiedExecutionIdentity(metadata, storedManifest);
    }
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
const verifiedLocalBuilds = new Map<string, BuildResult>();

function localBuildCacheId(dir: string): string {
  return path.resolve(dir);
}

function rememberVerifiedLocalBuild(build: BuildResult): BuildResult {
  verifiedLocalBuilds.set(localBuildCacheId(build.dir), build);
  return build;
}

function forgetVerifiedLocalBuild(dir: string): void {
  verifiedLocalBuilds.delete(localBuildCacheId(dir));
}

function readVerifiedLocalBuild(key: string): BuildResult | null {
  const dir = getBuildDir(key);
  const cacheId = localBuildCacheId(dir);
  const cached = verifiedLocalBuilds.get(cacheId);
  if (cached) return cached;
  const build = readBuildDir(dir, key);
  return build ? rememberVerifiedLocalBuild(build) : null;
}

/**
 * Verify one workspace-owned build without publishing it to, or materializing
 * it from, the shared reconstruction cache. Diagnostics and retention root
 * snapshots must not turn a read into new local ownership.
 */
export function peekLocal(key: string): BuildResult | null {
  return readVerifiedLocalBuild(key);
}

export function get(key: string): BuildResult | null {
  const localDir = getBuildDir(key);
  const local = readVerifiedLocalBuild(key);
  if (local) {
    scheduleSharedBuildPublication(key, localDir);
    return local;
  }
  return null;
}

/** Hydrate a shared immutable build without blocking the server event loop. */
export async function getOrHydrate(key: string): Promise<BuildResult | null> {
  const localDir = getBuildDir(key);
  const local = get(key);
  if (local) return local;

  const sharedDir = getSharedBuildDir(key);
  if (!sharedDir) return null;
  // A build committed by this process may still be finishing its optional
  // shared publication. Hydration is the only consumer that needs to wait for
  // that work; ordinary build completion and local lookup remain independent.
  await sharedBuildPublicationTasks.get(path.resolve(sharedDir));
  const cacheRoot = path.dirname(sharedDir);
  const lease = derivedCacheCoordinator(cacheRoot).acquire(cacheRoot, key);
  try {
    // A workspace GC tombstone is authoritative over the shared reconstruction
    // cache. Without this check a successful sweep would immediately resurrect
    // the same local record on the next lookup.
    if (isRetiredBuildKey(key)) return null;
    // The shared record's execution identity belongs to its source workspace;
    // it is deliberately verified only after its provenance is rebound below.
    const shared = readBuildDir(sharedDir, key, { verifyExecution: false });
    if (shared) {
      // Artifact bytes are globally shareable, but workspace build metadata is
      // not. In particular, sourceState and execution commit to the workspace
      // that materialized the build. Rebind that provenance to this workspace
      // only when the exact source content is present here; otherwise this is a
      // safe cache miss and the caller must rebuild from its own source.
      let sharedMetadata = shared.metadata;
      if (sharedMetadata.sourceStateHash !== null) {
        const sourceState = activeExecutionIdentityContext?.executionStateForContent(
          sharedMetadata.sourceStateHash
        );
        if (!sourceState) return null;
        const reboundMetadata: BuildMetadata = { ...sharedMetadata, sourceState };
        const execution = createBuildExecutionIdentity(reboundMetadata, shared.artifacts);
        if (!execution) return null;
        sharedMetadata = { ...reboundMetadata, execution };
      }
      // A shared result is only a reconstruction cache, never an authoritative
      // workspace record. Materialize a local immutable link tree before it can
      // be returned to an owner/publication path so workspace retention has one
      // complete census and a different workspace's collector cannot break it.
      const tmpDir = `${localDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
      try {
        await fs.promises.mkdir(path.dirname(localDir), { recursive: true });
        await linkBuildTree(sharedDir, tmpDir);
        if (sharedMetadata !== shared.metadata) {
          await fs.promises.writeFile(
            path.join(tmpDir, "metadata.json"),
            `${JSON.stringify(sharedMetadata, null, 2)}\n`
          );
        }
        // Execution metadata is workspace-owned provenance. Shared caches supply
        // reusable bytes, never another workspace's semantic execution variants.
        await fs.promises.rm(path.join(tmpDir, "executions"), { recursive: true, force: true });
        const executionDigest = sharedMetadata.execution?.executionDigest;
        if (executionDigest) {
          const target = executionMetadataPath(tmpDir, executionDigest);
          const variant = executionVariant(sharedMetadata);
          if (!variant) throw new Error(`Build ${key} has incomplete execution metadata`);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.writeFile(target, `${JSON.stringify(variant, null, 2)}\n`);
        }
        try {
          await fs.promises.rename(tmpDir, localDir);
        } catch (error) {
          if (!isFileSystemErrorCode(error, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) throw error;
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
      } catch (error) {
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          warnCleanupFailure(tmpDir, cleanupError);
        }
        throw error;
      }
    }
    const materialized = readBuildDir(localDir, key);
    if (materialized) rememberVerifiedLocalBuild(materialized);
    if (materialized && !reportedSharedBuildHits.has(key)) {
      reportedSharedBuildHits.add(key);
      console.info(
        `[BuildCache] Reused shared build ${materialized.metadata.name} (${key.slice(0, 12)})`
      );
    }
    return materialized;
  } finally {
    lease.release();
    void scheduleDerivedCachePrune(cacheRoot).catch((error) => {
      console.warn(
        `[buildStore] Shared cache prune failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
}

/** Resolve one retained execution of reusable artifact bytes without rebinding
 * or silently upgrading it to the build key's latest semantic source state. */
export function getByExecution(key: string, executionDigest: string): BuildResult | null {
  const current = get(key);
  if (!current) return null;
  if (current.metadata.execution?.executionDigest === executionDigest) return current;
  try {
    const stored = JSON.parse(
      fs.readFileSync(executionMetadataPath(current.dir, executionDigest), "utf8")
    ) as StoredExecutionVariant | BuildMetadata;
    const variant = retainedExecutionVariant(stored, key, executionDigest);
    if (!variant) return null;
    const metadata: BuildMetadata = {
      ...current.metadata,
      sourceStateHash: variant.sourceStateHash,
      sourceState: variant.sourceState,
      execution: variant.execution,
    };
    if (
      metadata.buildKey !== key ||
      metadata.sourceStateHash === null ||
      metadata.execution?.executionDigest !== executionDigest
    ) {
      return null;
    }
    verifiedExecutionIdentity(metadata, current.artifacts);
    return {
      ...current,
      sourceStateHash: metadata.sourceStateHash,
      metadata: metadataForEntries(metadata, current.artifacts),
    };
  } catch {
    return null;
  }
}

function retainedExecutionVariant(
  stored: StoredExecutionVariant | BuildMetadata,
  buildKey: string,
  executionDigest: string
): StoredExecutionVariant | null {
  if ("version" in stored && stored.version === 1 && "execution" in stored) {
    return stored as StoredExecutionVariant;
  }
  // One-time migration of the previous full-metadata record. The build store
  // is authoritative for retained rollback executions, so upgrade it in place
  // instead of discarding a live execution or retaining duplicate source text.
  const legacy = stored as BuildMetadata;
  if (legacy.buildKey !== buildKey || legacy.execution?.executionDigest !== executionDigest) {
    return null;
  }
  const variant = executionVariant(legacy);
  if (!variant) return null;
  const target = executionMetadataPath(getBuildDir(buildKey), executionDigest);
  const tmp = `${target}.tmp.${crypto.randomBytes(12).toString("hex")}`;
  fs.writeFileSync(tmp, `${JSON.stringify(variant, null, 2)}\n`);
  fs.renameSync(tmp, target);
  return variant;
}

/**
 * Rebind an immutable artifact set to the exact source state that requested it.
 * BuildV2 keys locate reusable artifact bytes; execution identity additionally
 * commits the source state, so reusing bytes across semantic states must update
 * the workspace-owned metadata before the result can be retained or executed.
 */
export async function rebindSourceState(
  build: BuildResult,
  sourceStateHash: string
): Promise<BuildResult> {
  if (build.sourceStateHash === sourceStateHash) return build;
  const sourceState = activeExecutionIdentityContext?.executionStateForContent(sourceStateHash);
  if (!sourceState) {
    throw new Error(
      `Build ${build.buildKey} cannot be rebound to source state ${sourceStateHash}: state is not present in the active workspace`
    );
  }
  const metadataWithoutExecution: BuildMetadata = {
    ...build.metadata,
    sourceStateHash,
    sourceState,
  };
  const execution = createBuildExecutionIdentity(metadataWithoutExecution, build.artifacts);
  if (!execution) {
    throw new Error(
      `Build ${build.buildKey} cannot be rebound without a workspace execution identity`
    );
  }
  const metadata: BuildMetadata = { ...metadataWithoutExecution, execution };
  const localDir = getBuildDir(build.buildKey);
  if (path.resolve(build.dir) === path.resolve(localDir)) {
    const metadataPath = path.join(localDir, "metadata.json");
    const tmpPath = `${metadataPath}.tmp.${crypto.randomBytes(12).toString("hex")}`;
    try {
      await fs.promises.writeFile(tmpPath, `${JSON.stringify(metadata, null, 2)}\n`);
      await writeExecutionMetadata(localDir, metadata);
      await fs.promises.rename(tmpPath, metadataPath);
    } catch (error) {
      try {
        await fs.promises.rm(tmpPath, { force: true });
      } catch (cleanupError) {
        warnCleanupFailure(tmpPath, cleanupError);
      }
      throw error;
    }
  }
  const rebound = {
    ...build,
    sourceStateHash,
    metadata,
  };
  if (path.resolve(build.dir) === path.resolve(localDir)) {
    rememberVerifiedLocalBuild(rebound);
  }
  return rebound;
}

/**
 * Bootstrap builds are compiled from the filesystem snapshot used only to
 * bring the semantic source provider online. Once semantic startup has
 * reconciled its active entities, those snapshot roots are no longer valid
 * execution sources for the steady-state store and must not enter content GC.
 * Remove only exact matching, non-active cache records; shared artifact bytes
 * remain available for normal workspace-local reconstruction.
 */
export async function discardBootstrapBuilds(
  sourceStateHash: string,
  protectedBuildKeys: ReadonlySet<string>
): Promise<number> {
  const buildsDir = getBuildsDir();
  const trashDir = stateLayout(getUserDataPath()).executionRetention.buildTrashDir;
  let discarded = 0;
  const entries = await fs.promises
    .readdir(buildsDir, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isDirectory() || protectedBuildKeys.has(entry.name)) continue;
    const buildDir = path.join(buildsDir, entry.name);
    let metadata: BuildMetadata;
    try {
      metadata = JSON.parse(
        await fs.promises.readFile(path.join(buildDir, "metadata.json"), "utf8")
      ) as BuildMetadata;
    } catch {
      continue;
    }
    if (metadata.buildKey !== entry.name || metadata.sourceStateHash !== sourceStateHash) continue;
    const trashPath = path.join(
      trashDir,
      `${entry.name}.bootstrap.${crypto.randomBytes(8).toString("hex")}`
    );
    await fs.promises.mkdir(trashDir, { recursive: true, mode: 0o700 });
    forgetVerifiedLocalBuild(buildDir);
    await fs.promises.rename(buildDir, trashPath);
    await fs.promises.rm(trashPath, { recursive: true, force: true });
    discarded += 1;
  }
  return discarded;
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

export async function put(
  key: string,
  artifacts: BuildArtifacts,
  metadata: BuildMetadata
): Promise<BuildResult> {
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

  await fs.promises.mkdir(tmpDir, { recursive: true });
  await runBounded(entries, 8, async (entry) => {
    const targetPath = path.join(tmpDir, entry.path);
    await writeArtifactFile(targetPath, entry, artifactPoolDir);
  });

  // Ensure Node.js treats bundle.js as ESM.
  if (storedMetadata.kind === "worker" || storedMetadata.kind === "extension") {
    await fs.promises.writeFile(path.join(tmpDir, "package.json"), '{"type":"module"}');
  }

  await fs.promises.writeFile(
    path.join(tmpDir, "artifacts.json"),
    JSON.stringify(artifactManifest, null, 2)
  );

  // Write metadata (sentinel) inside tmpDir BEFORE rename so winner is always complete
  await fs.promises.writeFile(
    path.join(tmpDir, "metadata.json"),
    JSON.stringify(storedMetadata, null, 2)
  );
  await writeExecutionMetadata(tmpDir, storedMetadata);

  // Race-safe promotion: try rename, handle concurrent winner
  try {
    await fs.promises.rename(tmpDir, dir);
  } catch (err: unknown) {
    if (isFileSystemErrorCode(err, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) {
      // Another build may have won the race. Accept it only after the same
      // manifest + execution-identity verification used by normal reads.
      if (fs.existsSync(metadataPath)) {
        const winner = get(key);
        if (winner) {
          try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
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
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        warnCleanupFailure(tmpDir, cleanupError);
      }
      throw new Error(
        `Immutable build directory ${key} already exists but is invalid; stop the server and remove it before rebuilding`
      );
    } else {
      // Clean up tmpDir on unexpected errors
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        warnCleanupFailure(tmpDir, cleanupError);
      }
      throw err;
    }
  }

  const stored: BuildResult = {
    dir,
    buildKey: key,
    sourceStateHash: storedMetadata.sourceStateHash,
    metadata: storedMetadata,
    artifacts: entries.map((entry) => ({ ...manifestForEntry(entry), content: entry.content })),
  };
  clearRetiredBuildKey(key);
  scheduleSharedBuildPublication(key, dir);
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
        forgetVerifiedLocalBuild(getBuildDir(key));
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
    const trashDir = path.join(
      stateLayout(getUserDataPath()).executionRetention.buildTrashDir,
      `${key}.${input.epoch}.${crypto.randomBytes(8).toString("hex")}`
    );
    try {
      fs.mkdirSync(path.dirname(trashDir), { recursive: true, mode: 0o700 });
      // Synchronous rename is the deletion commit point. A publication
      // reservation cannot interleave inside this critical section.
      const committed =
        input.commitArtifactDeletion?.(key, () => {
          forgetVerifiedLocalBuild(sourceDir);
          fs.renameSync(sourceDir, trashDir);
        }) ?? false;
      if (!committed) {
        result.retainedForGrace += 1;
        continue;
      }
      record.deletedAtEpoch = input.epoch;
      saveBuildGcState({ version: 1, quarantined: [...byKey.values()] });
      result.deleted += 1;
      try {
        await fs.promises.rm(trashDir, { recursive: true, force: true });
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
