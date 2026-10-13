import { logVerbose } from "@vibestudio/dev-log";
import { formatRpcFailure } from "@vibestudio/rpc";
import { ByteBudgetCache } from "@vibestudio/shared/byteBudgetCache";
/**
 * Content-Addressed Build Store — immutable artifact storage.
 *
 * {userData}/builds/{build_key}/
 *   ├── bundle.js
 *   ├── bundle.css  (if any)
 *   ├── index.html  (panels/about only)
 *   ├── assets/     (chunks, images, fonts)
 *   ├── artifacts.json
 *   ├── executable-modules.json.gz (optional sealed source inventory)
 *   └── metadata.json
 *
 * Same key = same content. Online deletion is owned exclusively by the
 * publication-interlocked mark/quarantine/sweep collector below.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { gunzip, gzip, constants as zlibConstants } from "zlib";
import { promisify } from "util";
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
import { collectArtifactPool, writePooledArtifact } from "./buildArtifactPool.js";
import { stateLayout } from "../stateLayout.js";
import {
  derivedCacheCoordinator,
  scheduleDerivedCachePrune,
} from "@vibestudio/shared/derivedCache";
import {
  buildArtifactManifestSchema,
  buildMetadataSchema,
  executableModulesSchema,
  type BuildArtifactManifestEntryWire,
  type BuildArtifactWire,
  type BuildMetadataWire,
  type BuildResultWire,
  type BuildMetadataDetailsWire,
  type ExecutableModuleWire,
  type StoredBuildResult,
} from "@vibestudio/service-schemas/build";
export { contentTypeForPath } from "@vibestudio/shared/contentType";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildArtifacts {
  entries: BuildArtifactInput[];
}

export type BuildArtifactRole = BuildArtifactWire["role"];
export type BuildArtifactEncoding = BuildArtifactWire["encoding"];

/** Producer input may omit encoding; persisted/wire artifacts always include it. */
export type BuildArtifactInput = Omit<BuildArtifactWire, "encoding" | "byteLength"> & {
  encoding?: BuildArtifactEncoding;
};

export type BuildArtifactManifestEntry = BuildArtifactManifestEntryWire;

export type BuildArtifactWithContent = BuildArtifactWire;

/** Stored artifacts stay as immutable file descriptors until a consumer asks for bytes. */
export type StoredBuildArtifact = StoredBuildResult["artifacts"][number];
export type { StoredBuildResult } from "@vibestudio/service-schemas/build";

/**
 * Immutable executable identity sealed at the build-store boundary.
 *
 * The shared ref commits semantic provenance, traversable source roots,
 * BuildV2's recipe/cache identity, and the exact emitted artifact manifest.
 * `executionDigest` is the producer-neutral code principal commitment.
 */
export type BuildExecutionIdentity = ExecutionArtifactRefV1;

export type ExtensionMethodAuthority = Extract<
  BuildMetadataDetailsWire,
  { kind: "extension" }
>["methodAuthority"];

export type ExecutableModuleInput = ExecutableModuleWire;

export type BuildMetadataDetails = BuildMetadataDetailsWire;

class InvalidStoredBuildMetadataError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "InvalidStoredBuildMetadataError";
  }
}

function invalidStoredBuildMetadata(message: string, cause?: unknown): never {
  throw new InvalidStoredBuildMetadataError(message, cause);
}

function parseStoredBuildMetadata(content: string): BuildMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      invalidStoredBuildMetadata("Stored build metadata is not valid JSON", error);
    }
    throw error;
  }
  const result = buildMetadataSchema.safeParse(parsed);
  if (!result.success) {
    invalidStoredBuildMetadata(
      "Stored build metadata does not match its wire schema",
      result.error
    );
  }
  return result.data;
}

/** The wire schema is the authority for every persisted metadata field. */
export type BuildMetadata = BuildMetadataWire;

/** A build result is exactly the returned schema payload. */
export type BuildResult = BuildResultWire;

export interface BuildStoreRetentionScan {
  builds: Array<{ key: string; bytes: number }>;
  failures: Array<{ key: string; error: string }>;
}

export type BuildGcMode = "report" | "quarantine" | "sweep";

export interface BuildStoreGcResult {
  quarantined: number;
  deleted: number;
  retainedForGrace: number;
  notReconstructible: Array<{ buildKey: string; missing: string[] }>;
  cleanupFailures: Array<{ buildKey: string; error: string }>;
  /** Includes quarantine and just-deleted tombstones for content-GC ordering. */
  retainedSourceRoots: ExecutionSourceContentRoot[];
}

export interface BuildStoreConfig {
  readonly stateRoot: string;
  readonly sharedArtifactPoolRoot: string | null;
  readonly sharedBuildResultCacheRoot: string | null;
  readonly releaseBuildRoot: string | null;
  readonly executionIdentity: {
    readonly workspaceId: string;
    readonly executionStateForContent: (stateHash: string) => ExecutionSourceStateRef | null;
    readonly serviceAuthorityForSource: (
      metadata: Pick<BuildMetadata, "sourcePath" | "sourceStateHash" | "ev" | "authority">
    ) => Promise<string>;
  } | null;
}

export interface BuildStoreRootInputs {
  readonly stateRoot: string;
  readonly centralDataRoot: string;
  readonly sharedDerivedRoot: string | null;
  readonly artifactPoolOverride?: string;
  readonly buildResultCacheOverride?: string;
}

export interface BuildStoreRoots {
  readonly sharedArtifactPoolRoot: string | null;
  readonly sharedBuildResultCacheRoot: string | null;
}

/** Resolve shared roots before role admission, without ambient env/path reads. */
export function resolveBuildStoreRoots(inputs: BuildStoreRootInputs): BuildStoreRoots {
  const stateRoot = path.resolve(inputs.stateRoot);
  const centralDataRoot = path.resolve(inputs.centralDataRoot);
  const eligibleManagedWorkspace =
    path.basename(stateRoot) === "state" &&
    path.dirname(path.dirname(stateRoot)) === path.join(centralDataRoot, "workspaces");
  const sharedDerivedRoot = inputs.sharedDerivedRoot
    ? path.resolve(inputs.sharedDerivedRoot)
    : null;
  return {
    sharedArtifactPoolRoot: inputs.artifactPoolOverride
      ? path.resolve(inputs.artifactPoolOverride)
      : eligibleManagedWorkspace && sharedDerivedRoot
        ? path.join(sharedDerivedRoot, "build-artifacts")
        : null,
    sharedBuildResultCacheRoot: inputs.buildResultCacheOverride
      ? path.resolve(inputs.buildResultCacheOverride)
      : eligibleManagedWorkspace && sharedDerivedRoot
        ? path.join(sharedDerivedRoot, "build-results")
        : null,
  };
}

/** Process lifetime owner for work shared by role-specific BuildStore instances. */
export class BuildStoreProcessOwner {
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly artifactPoolCollections = new Map<string, Promise<void>>();
  private drainFlight: Promise<void> | undefined;
  private admissionClosed = false;

  admit(key: string, work: () => Promise<void>): Promise<void> {
    const current = this.tasks.get(key);
    if (current) return current;
    if (this.admissionClosed) throw new Error("BuildStore process owner is draining");
    const task = Promise.resolve().then(work);
    this.tasks.set(key, task);
    void task.then(
      () => {
        if (this.tasks.get(key) === task) this.tasks.delete(key);
      },
      () => {
        if (this.tasks.get(key) === task) this.tasks.delete(key);
      }
    );
    return task;
  }

  async wait(key: string): Promise<void> {
    await this.tasks.get(key);
  }

  collectArtifactPool(root: string): Promise<void> {
    const canonicalRoot = path.resolve(root);
    const current = this.artifactPoolCollections.get(canonicalRoot);
    if (current) return current;
    const task = this.admit(`artifact-pool:${canonicalRoot}`, async () => {
      await collectArtifactPool(canonicalRoot);
    });
    this.artifactPoolCollections.set(canonicalRoot, task);
    void task.then(
      () => this.artifactPoolCollections.delete(canonicalRoot),
      () => this.artifactPoolCollections.delete(canonicalRoot)
    );
    return task;
  }

  async drain(): Promise<void> {
    if (this.drainFlight) return this.drainFlight;
    this.drainFlight = (async () => {
      const failures: unknown[] = [];
      while (true) {
        const entries = [...this.tasks.entries()];
        if (entries.length === 0) {
          this.admissionClosed = true;
          break;
        }
        const outcomes = await Promise.allSettled(entries.map(([, task]) => task));
        for (const [index, [key, task]] of entries.entries()) {
          if (this.tasks.get(key) === task) this.tasks.delete(key);
          const outcome = outcomes[index];
          if (outcome?.status === "rejected") failures.push(outcome.reason);
        }
      }
      const failure = joinedStoreFailures(failures, "BuildStore process operations failed");
      if (failure !== undefined || failures.length > 0) throw failure;
    })();
    return this.drainFlight;
  }
}

function joinedStoreFailures(failures: unknown[], message: string): unknown | undefined {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message, { cause: failures[0] });
}

export function createBuildStoreProcessOwner(): BuildStoreProcessOwner {
  return new BuildStoreProcessOwner();
}

export type BuildStore = ReturnType<typeof createBuildStore>;

export function createBuildStore(config: BuildStoreConfig, processOwner: BuildStoreProcessOwner) {
  if (!path.isAbsolute(config.stateRoot)) throw new Error("BuildStore stateRoot must be absolute");
  const stateRoot = path.resolve(config.stateRoot);
  const sharedArtifactPoolRoot = config.sharedArtifactPoolRoot
    ? path.resolve(config.sharedArtifactPoolRoot)
    : null;
  const sharedBuildResultCacheRoot = config.sharedBuildResultCacheRoot
    ? path.resolve(config.sharedBuildResultCacheRoot)
    : null;
  const releaseBuildRoot = config.releaseBuildRoot ? path.resolve(config.releaseBuildRoot) : null;
  if (config.executionIdentity && !config.executionIdentity.workspaceId) {
    throw new Error("Build execution workspaceId is required");
  }
  const activeExecutionIdentityContext = config.executionIdentity
    ? Object.freeze({ ...config.executionIdentity })
    : null;
  const ownPublicationTasks = new Set<Promise<void>>();

  // ---------------------------------------------------------------------------
  // Build Store
  // ---------------------------------------------------------------------------

  function getBuildsDir(): string {
    return path.join(stateRoot, "builds");
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
    version: 2;
    serviceAuthorityDigest: string;
    sourceStateHash: string;
    sourceState: ExecutionSourceStateRef;
    execution: BuildExecutionIdentity;
  }

  const EXECUTABLE_MODULES_FILE = "executable-modules.json.gz";
  const gunzipAsync = promisify(gunzip);

  function gzipJson(value: unknown): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      gzip(JSON.stringify(value), { level: zlibConstants.Z_BEST_SPEED }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }

  /** Hot metadata never owns executable source payloads. */
  async function readBuildMetadata(dir: string): Promise<BuildMetadata> {
    const content = await fs.promises.readFile(path.join(dir, "metadata.json"), "utf-8");
    const metadata = parseStoredBuildMetadata(content);
    const { executableModules: _modules, ...compact } = metadata;
    return compact;
  }

  /** Read source evidence only at the compiler/diagnostic consumer that needs it. */
  async function readExecutableModules(dir: string): Promise<ExecutableModuleInput[] | undefined> {
    const content = await fs.promises.readFile(path.join(dir, "metadata.json"), "utf8");
    const metadata = parseStoredBuildMetadata(content);
    if (metadata.executableModules !== undefined) return metadata.executableModules;
    const modulesPath = path.join(dir, EXECUTABLE_MODULES_FILE);
    try {
      await fs.promises.access(modulesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let modulesJson: string;
    try {
      modulesJson = (await gunzipAsync(await fs.promises.readFile(modulesPath))).toString("utf-8");
    } catch (error) {
      if (["Z_DATA_ERROR", "Z_BUF_ERROR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        invalidStoredBuildMetadata("Stored executable module inventory is corrupt", error);
      }
      throw error;
    }
    let parsedModules: unknown;
    try {
      parsedModules = JSON.parse(modulesJson);
    } catch (error) {
      if (error instanceof SyntaxError) {
        invalidStoredBuildMetadata("Stored executable module inventory is not valid JSON", error);
      }
      throw error;
    }
    const result = executableModulesSchema.safeParse(parsedModules);
    if (!result.success) {
      invalidStoredBuildMetadata("Stored executable module inventory is invalid", result.error);
    }
    return result.data;
  }

  /** Keep the verbose source inventory compressed and separate from hot metadata. */
  async function writeBuildMetadata(dir: string, metadata: BuildMetadata): Promise<void> {
    const wireMetadata: BuildMetadata = buildMetadataSchema.parse(metadata);
    const { executableModules: suppliedModules, ...compactMetadata } = wireMetadata;
    const modulesPath = path.join(dir, EXECUTABLE_MODULES_FILE);
    const metadataPath = path.join(dir, "metadata.json");
    let executableModules = suppliedModules;
    if (executableModules === undefined) {
      try {
        await fs.promises.access(modulesPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await fs.promises.access(metadataPath);
          executableModules = await readExecutableModules(dir);
        } catch (metadataError) {
          if ((metadataError as NodeJS.ErrnoException).code !== "ENOENT") throw metadataError;
        }
      }
    }
    if (executableModules !== undefined) {
      const modulesTmp = `${modulesPath}.tmp.${crypto.randomBytes(12).toString("hex")}`;
      try {
        const payload = await gzipJson(executableModules);
        await writePooledArtifact(getSharedArtifactPoolDir(), modulesTmp, payload);
        await fs.promises.rename(modulesTmp, modulesPath);
      } catch (error) {
        try {
          await fs.promises.rm(modulesTmp, { force: true });
        } catch (cleanupError) {
          warnCleanupFailure(modulesTmp, cleanupError);
        }
        throw error;
      }
    }
    // Compact metadata updates do not own or retire the source evidence file.

    const metadataTmp = `${metadataPath}.tmp.${crypto.randomBytes(12).toString("hex")}`;
    try {
      await fs.promises.writeFile(metadataTmp, JSON.stringify(compactMetadata));
      await fs.promises.rename(metadataTmp, metadataPath);
    } catch (error) {
      try {
        await fs.promises.rm(metadataTmp, { force: true });
      } catch (cleanupError) {
        warnCleanupFailure(metadataTmp, cleanupError);
      }
      throw error;
    }
  }

  function executionVariant(metadata: BuildMetadata): StoredExecutionVariant | null {
    if (!metadata.execution || !metadata.sourceStateHash || !metadata.sourceState) return null;
    if (!metadata.serviceAuthorityDigest)
      throw new Error("Workspace execution has no sealed service authority");
    return {
      version: 2,
      serviceAuthorityDigest: parseSha256(
        metadata.serviceAuthorityDigest,
        "execution service authority digest"
      ),
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

  async function collectSharedArtifactPool(): Promise<void> {
    if (sharedArtifactPoolRoot) await processOwner.collectArtifactPool(sharedArtifactPoolRoot);
  }

  function getSharedArtifactPoolDir(): string | null {
    return sharedArtifactPoolRoot;
  }

  function getSharedBuildDir(key: string): string | null {
    return sharedBuildResultCacheRoot ? path.join(sharedBuildResultCacheRoot, key) : null;
  }

  function isFileSystemErrorCode(error: unknown, codes: readonly string[]): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" && codes.includes(code);
  }

  function warnCleanupFailure(pathName: string, error: unknown): void {
    console.warn(`[buildStore] Failed to remove ${pathName}: ${formatRpcFailure(error)}`);
  }

  /** Project only the sealed artifacts, never mutable metadata or writer scratch files. */
  async function materializeBuildTree(
    source: StoredBuildResult,
    targetDir: string,
    metadata: BuildMetadata = source.metadata
  ): Promise<void> {
    // Capture immutable compressed evidence without inflating its source strings.
    let modules: Buffer | undefined;
    try {
      modules = await fs.promises.readFile(path.join(source.dir, EXECUTABLE_MODULES_FILE));
    } catch (error) {
      if (!isFileSystemErrorCode(error, ["ENOENT"])) throw error;
      const inline = await readExecutableModules(source.dir);
      if (inline !== undefined) modules = await gzipJson(inline);
    }
    await fs.promises.mkdir(targetDir, { recursive: true });
    const manifest = source.artifacts;
    await runBounded(manifest, 8, async (entry) => {
      const sourcePath = path.join(source.dir, entry.path);
      const targetPath = path.join(targetDir, entry.path);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      if (process.platform === "win32") {
        await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        return;
      }
      try {
        await fs.promises.link(sourcePath, targetPath);
      } catch (error) {
        if (!isFileSystemErrorCode(error, ["EXDEV", "EPERM", "EACCES", "EMLINK"])) throw error;
        await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      }
    });
    const { executableModules: _modules, ...compactMetadata } = metadata;
    await writeBuildRecords(targetDir, compactMetadata, manifest);
    if (modules)
      await writePooledArtifact(
        getSharedArtifactPoolDir(),
        path.join(targetDir, EXECUTABLE_MODULES_FILE),
        modules
      );
  }

  async function writeBuildRecords(
    dir: string,
    metadata: BuildMetadata,
    manifest: BuildArtifactManifestEntry[]
  ): Promise<void> {
    if (
      metadata.kind === "worker" ||
      metadata.kind === "extension" ||
      metadata.details.kind === "terminal"
    ) {
      await fs.promises.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    }
    await fs.promises.writeFile(
      path.join(dir, "artifacts.json"),
      JSON.stringify(manifest, null, 2)
    );
    await writeBuildMetadata(dir, metadata);
    await writeExecutionMetadata(dir, metadata);
  }

  async function pruneSharedBuildCache(cacheRoot: string): Promise<void> {
    await processOwner.admit(`prune:${path.resolve(cacheRoot)}`, async () => {
      const result = await scheduleDerivedCachePrune(cacheRoot);
      if (result) await collectSharedArtifactPool();
    });
  }

  async function publishSharedBuild(key: string, sourceDir: string): Promise<void> {
    const sharedDir = getSharedBuildDir(key);
    if (!sharedDir) return;
    const cacheRoot = path.dirname(sharedDir);
    if (await sharedBuildDirectoryExists(sharedDir)) {
      await assertCompleteSharedBuild(sharedDir, key);
      return;
    }

    const tmpDir = `${sharedDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
    let publicationFailure: unknown;
    let publicationFailed = false;
    try {
      await fs.promises.mkdir(path.dirname(sharedDir), { recursive: true });
      const source = await readBuildDir(sourceDir, key, { verifyExecution: false });
      if (!source) throw new Error(`Cannot publish incomplete build ${key}`);
      await materializeBuildTree(source, tmpDir);
      try {
        await fs.promises.rename(tmpDir, sharedDir);
      } catch (renameError) {
        let incumbentExists: boolean;
        try {
          incumbentExists = await sharedBuildDirectoryExists(sharedDir);
        } catch (inspectionError) {
          throw new AggregateError(
            [renameError, inspectionError],
            `Could not inspect shared build publication collision for ${key}`,
            { cause: renameError }
          );
        }
        if (!incumbentExists) throw renameError;
        try {
          await assertCompleteSharedBuild(sharedDir, key);
        } catch (verificationError) {
          throw new AggregateError(
            [renameError, verificationError],
            `Shared build publication collided with an invalid incumbent for ${key}`,
            { cause: renameError }
          );
        }
        try {
          await fs.promises.rm(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [renameError, cleanupError],
            `Shared build publication winner was verified, but temporary cleanup failed for ${key}`,
            { cause: renameError }
          );
        }
      }
    } catch (error) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        publicationFailure = new AggregateError(
          [error, cleanupError],
          `Shared build publication failed and temporary cleanup also failed for ${key}`,
          { cause: error }
        );
        publicationFailed = true;
      }
      if (!publicationFailed) {
        publicationFailure = error;
        publicationFailed = true;
      }
    }

    let pruningFailure: unknown;
    let pruningFailed = false;
    try {
      await pruneSharedBuildCache(cacheRoot);
    } catch (error) {
      pruningFailure = error;
      pruningFailed = true;
    }

    if (publicationFailed && pruningFailed) {
      throw new AggregateError(
        [publicationFailure, pruningFailure],
        `Shared build publication and cache pruning failed for ${key}`,
        { cause: publicationFailure }
      );
    }
    if (publicationFailed) throw publicationFailure;
    if (pruningFailed) throw pruningFailure;
  }

  async function sharedBuildDirectoryExists(sharedDir: string): Promise<boolean> {
    try {
      const stat = await fs.promises.lstat(sharedDir);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Shared build publication destination is not a real directory");
      return true;
    } catch (error) {
      if (isFileSystemErrorCode(error, ["ENOENT"])) return false;
      throw error;
    }
  }

  async function assertCompleteSharedBuild(sharedDir: string, key: string): Promise<void> {
    const build = await readBuildDir(sharedDir, key, { verifyExecution: false });
    if (!build) throw new Error(`Shared build ${key} is incomplete or has a different build key`);
    // Verify every payload before an existing directory wins publication.
    await mapJoined(build.artifacts, (artifact) => readStoredArtifactBytes(build, artifact));
  }

  async function mapJoined<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const results = await Promise.allSettled(items.map(work));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple stored build artifact reads failed", {
        cause: failures[0],
      });
    }
    return results.map((result) => {
      if (result.status !== "fulfilled") throw new Error("Unsettled stored artifact read");
      return result.value;
    });
  }

  // Shared builds are a reconstruction cache, not part of the workspace-local
  // durability commit. The caller still joins this exact immutable publication
  // before completing so its original failure remains observable and the source
  // tree stays owned through publication. Temporary-tree + atomic-rename keeps
  // publication safe against concurrent publishers and collection without a
  // writer lease: temporary trees are excluded from collection and a published
  // tree may be collected immediately without affecting its workspace owner.
  function scheduleSharedBuildPublication(key: string, sourceDir: string): Promise<void> {
    const sharedDir = getSharedBuildDir(key);
    if (!sharedDir) return Promise.resolve();
    const publicationId = path.resolve(sharedDir);
    const task = processOwner.admit(`publication:${publicationId}`, () =>
      publishSharedBuild(key, sourceDir)
    );
    ownPublicationTasks.add(task);
    void task.then(
      () => ownPublicationTasks.delete(task),
      () => ownPublicationTasks.delete(task)
    );
    return task.catch((error) => {
      console.warn(
        `[buildStore] Shared build publication failed for ${key}: ${formatRpcFailure(error)}`
      );
      throw error;
    });
  }

  /** Read and verify one stored artifact without blocking the workspace-server thread. */
  async function readStoredArtifactBytes(
    build: Pick<{ dir: string }, "dir">,
    entry: BuildArtifactManifestEntry
  ): Promise<Buffer> {
    const bytes = await fs.promises.readFile(artifactFilePath(build, entry));
    if (bytes.byteLength !== entry.byteLength) {
      throw new Error(`Build artifact length mismatch: ${entry.path}`);
    }
    const digest = Buffer.from(await crypto.webcrypto.subtle.digest("SHA-256", bytes)).toString(
      "hex"
    );
    if (entry.integrity !== `sha256-${digest}`) {
      throw new Error(`Build artifact integrity mismatch: ${entry.path}`);
    }
    return bytes;
  }

  async function readStoredArtifactContent(
    build: Pick<StoredBuildResult, "dir">,
    entry: BuildArtifactManifestEntry
  ): Promise<string> {
    const bytes = await readStoredArtifactBytes(build, entry);
    return entry.encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8");
  }

  /** Materialize only at an existing wire boundary whose schema requires strings. */
  async function materializeStoredBuild(build: StoredBuildResult): Promise<BuildResult> {
    const artifacts = await mapJoined(build.artifacts, async (entry) => ({
      ...entry,
      content: await readStoredArtifactContent(build, entry),
    }));
    return { ...build, artifacts };
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

  function integrityHex(integrity: string): string | null {
    const match = /^sha256-([a-f0-9]{64})$/.exec(integrity);
    return match?.[1] ?? null;
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
    const bytes = entryBytes(entry);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== integrityHex(entry.integrity)) {
      throw new Error(`Artifact integrity mismatch for ${entry.path}`);
    }
    await writePooledArtifact(poolDir, targetPath, bytes);
  }

  async function runBounded<T>(
    values: readonly T[],
    concurrency: number,
    work: (value: T) => Promise<void>
  ): Promise<void> {
    let cursor = 0;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length) {
          const value = values[cursor++];
          if (value !== undefined) await work(value);
        }
      })
    );
    // The owner may remove its temporary tree after rejection. Settle every
    // writer first so no sibling operation can recreate files during cleanup.
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple build artifact writes failed", {
        cause: failures[0],
      });
    }
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

  async function has(key: string): Promise<boolean> {
    // Cache presence means a complete, identity-verified manifest whose files
    // exist at their sealed lengths. Payload hashes are verified when consumed.
    // This keeps lazy artifacts off startup while rejecting partial cache trees.
    return (await get(key)) !== null;
  }

  async function readBuildDir(
    dir: string,
    expectedBuildKey: string,
    options: { verifyExecution?: boolean } = {}
  ): Promise<StoredBuildResult | null> {
    const metadataPath = path.join(dir, "metadata.json");

    try {
      await fs.promises.access(metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    try {
      const rawMetadata = parseStoredBuildMetadata(
        await fs.promises.readFile(metadataPath, "utf8")
      );
      if (
        !("sourceStateHash" in rawMetadata) ||
        (rawMetadata.sourceStateHash !== null && typeof rawMetadata.sourceStateHash !== "string") ||
        rawMetadata.buildKey !== expectedBuildKey
      ) {
        return null;
      }
      let authority: UnitAuthorityManifest | undefined;
      if (rawMetadata.authority !== undefined) {
        try {
          authority = parseUnitAuthorityManifest(
            rawMetadata.authority,
            `build ${expectedBuildKey} metadata.authority`
          );
        } catch (error) {
          invalidStoredBuildMetadata("Stored build authority is invalid", error);
        }
      }
      // Every workspace-derived build must carry authority from the exact source
      // state. Only library builds with no workspace source coordinate may omit it.
      if (
        rawMetadata.sourceStateHash !== null &&
        (authority === undefined ||
          typeof rawMetadata.serviceAuthorityDigest !== "string" ||
          !/^[0-9a-f]{64}$/u.test(rawMetadata.serviceAuthorityDigest))
      )
        return null;
      const { executableModules: _modules, ...compactRawMetadata } = rawMetadata;
      const metadata: BuildMetadata = {
        ...compactRawMetadata,
        ...(authority ? { authority } : {}),
      };
      const manifestPath = path.join(dir, "artifacts.json");
      try {
        await fs.promises.access(manifestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
      } catch (error) {
        if (error instanceof SyntaxError) {
          invalidStoredBuildMetadata("Stored build artifact manifest is not valid JSON", error);
        }
        throw error;
      }
      const manifestResult = buildArtifactManifestSchema.safeParse(manifestJson);
      if (!manifestResult.success) {
        invalidStoredBuildMetadata(
          "Stored build artifact manifest is invalid",
          manifestResult.error
        );
      }
      const storedManifest: BuildArtifactManifestEntry[] = manifestResult.data;
      try {
        assertCanonicalArtifactManifestPaths(storedManifest);
      } catch (error) {
        invalidStoredBuildMetadata("Stored build artifact paths are invalid", error);
      }
      const artifacts = await Promise.all(
        storedManifest.map(async (entry) => {
          const artifactPath = path.join(dir, entry.path);
          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(artifactPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              invalidStoredBuildMetadata(`Build artifact is missing: ${entry.path}`, error);
            }
            throw error;
          }
          if (
            !stat.isFile() ||
            !Number.isSafeInteger(entry.byteLength) ||
            (entry.byteLength ?? -1) < 0 ||
            stat.size !== entry.byteLength
          ) {
            invalidStoredBuildMetadata(`Build artifact size mismatch: ${entry.path}`);
          }
          return entry;
        })
      );
      if (options.verifyExecution !== false) {
        try {
          verifiedExecutionIdentity(metadata, storedManifest);
        } catch (error) {
          invalidStoredBuildMetadata("Stored build execution identity is invalid", error);
        }
      }
      return {
        dir,
        buildKey: expectedBuildKey,
        sourceStateHash: metadata.sourceStateHash,
        metadata: metadataForEntries(metadata, storedManifest),
        artifacts,
      };
    } catch (error) {
      if (
        error instanceof InvalidStoredBuildMetadataError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  const reportedSharedBuildHits = new ByteBudgetCache<string, true>(
    1024 * 1024,
    (_, key) => key.length * 2 + 128
  );
  function buildDescriptorBytes(build: {
    dir: string;
    metadata: BuildMetadata;
    artifacts: readonly Pick<BuildArtifactManifestEntry, "path" | "contentType" | "integrity">[];
  }): number {
    return (
      build.dir.length * 2 +
      JSON.stringify(build.metadata).length * 2 +
      build.artifacts.reduce(
        (bytes, artifact) =>
          bytes +
          256 +
          2 *
            (artifact.path.length +
              artifact.contentType.length +
              (artifact.integrity?.length ?? 0)),
        0
      )
    );
  }

  const verifiedLocalBuilds = new ByteBudgetCache<string, StoredBuildResult>(
    32 * 1024 * 1024,
    buildDescriptorBytes
  );

  function localBuildCacheId(dir: string): string {
    return path.resolve(dir);
  }

  function rememberVerifiedLocalBuild(build: StoredBuildResult): StoredBuildResult {
    verifiedLocalBuilds.set(localBuildCacheId(build.dir), build);
    for (const style of build.metadata.sharedStyles ?? [])
      sharedStyleOwners.set(style.digest, build.buildKey);
    return build;
  }

  function forgetVerifiedLocalBuild(dir: string): void {
    verifiedLocalBuilds.delete(localBuildCacheId(dir));
  }

  async function readVerifiedLocalBuild(key: string): Promise<StoredBuildResult | null> {
    const dir = getBuildDir(key);
    const cacheId = localBuildCacheId(dir);
    const cached = verifiedLocalBuilds.get(cacheId);
    if (cached) {
      try {
        await fs.promises.access(path.join(dir, "metadata.json"));
        return cached;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (cached) forgetVerifiedLocalBuild(dir);
    const build = await readBuildDir(dir, key);
    return build ? rememberVerifiedLocalBuild(build) : null;
  }

  const sharedStyleOwners = new ByteBudgetCache<string, string>(
    1024 * 1024,
    (key, digest) => 2 * (key.length + digest.length) + 128
  );

  async function findSharedStyleBuild(digest: string): Promise<StoredBuildResult | null> {
    if (!/^[0-9a-f]{64}$/u.test(digest)) return null;
    const known = sharedStyleOwners.get(digest);
    if (known) {
      const build = await readVerifiedLocalBuild(known);
      if (build?.metadata.sharedStyles?.some((style) => style.digest === digest)) return build;
      sharedStyleOwners.delete(digest);
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(getBuildsDir(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) continue;
      let metadata: BuildMetadata;
      try {
        metadata = parseStoredBuildMetadata(
          await fs.promises.readFile(path.join(getBuildDir(entry.name), "metadata.json"), "utf8")
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          error instanceof InvalidStoredBuildMetadataError
        )
          continue;
        throw error;
      }
      if (!metadata.sharedStyles?.some((style) => style.digest === digest)) continue;
      const build = await readVerifiedLocalBuild(entry.name);
      if (build) {
        sharedStyleOwners.set(digest, entry.name);
        return build;
      }
    }
    return null;
  }

  /**
   * Resolve only a descriptor whose metadata was already verified by this
   * process. The publication journal uses this metadata-only lookup while its
   * SQLite write transaction is held; it must never perform filesystem I/O.
   */
  function peekLocal(key: string): StoredBuildResult | null {
    return verifiedLocalBuilds.get(localBuildCacheId(getBuildDir(key))) ?? null;
  }

  /** Read and verify a workspace-owned build without claiming shared-cache ownership. */
  async function readLocal(key: string): Promise<StoredBuildResult | null> {
    return readVerifiedLocalBuild(key);
  }

  async function get(key: string): Promise<StoredBuildResult | null> {
    const localDir = getBuildDir(key);
    const local = await readVerifiedLocalBuild(key);
    if (local) {
      await scheduleSharedBuildPublication(key, localDir);
      return local;
    }
    return null;
  }

  /** Installed release artifacts are immutable reconstruction inputs, never workspace records. */
  /** Compiler facts belong to immutable artifacts, before workspace execution
   * provenance is sealed. Reading them must not hydrate a build or recursively
   * resolve the service contracts needed to seal that same build. */
  async function compilationMetadata(key: string): Promise<BuildMetadata | null> {
    const directories = [
      getBuildDir(key),
      ...(releaseBuildRoot ? [path.join(releaseBuildRoot, key)] : []),
      ...(sharedBuildResultCacheRoot ? [path.join(sharedBuildResultCacheRoot, key)] : []),
    ];
    for (const directory of directories) {
      const build = await readBuildDir(directory, key, { verifyExecution: false });
      if (build) return build.metadata;
    }
    return null;
  }

  async function hydrateSharedBuild(
    key: string,
    sourceStateHash: string | undefined,
    sharedDir: string,
    localDir: string
  ): Promise<StoredBuildResult | null> {
    if (isRetiredBuildKey(key)) return null;
    // The shared record's execution identity belongs to its source workspace;
    // it is deliberately verified only after its provenance is rebound below.
    const shared = await readBuildDir(sharedDir, key, { verifyExecution: false });
    if (!shared) return null;
    // Artifact bytes are globally shareable, but workspace build metadata is
    // not. In particular, sourceState and execution commit to the workspace
    // that materialized the build. Rebind that provenance to this workspace
    // only when the exact source content is present here; otherwise this is a
    // safe cache miss and the caller must rebuild from its own source.
    let sharedMetadata = shared.metadata;
    if (sharedMetadata.sourceStateHash !== null) {
      const reboundStateHash = sourceStateHash ?? sharedMetadata.sourceStateHash;
      const sourceState =
        activeExecutionIdentityContext?.executionStateForContent(reboundStateHash);
      if (!sourceState) return null;
      const reboundMetadata: BuildMetadata = {
        ...sharedMetadata,
        sourceStateHash: reboundStateHash,
        sourceState,
      };
      reboundMetadata.serviceAuthorityDigest = await sealServiceAuthority(reboundMetadata);
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
      await materializeBuildTree(shared, tmpDir, sharedMetadata);
      let promoted = true;
      try {
        await fs.promises.rename(tmpDir, localDir);
      } catch (error) {
        try {
          await fs.promises.access(localDir);
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") throw error;
          throw new AggregateError(
            [error, inspectionError],
            `Could not inspect local build ${key}`,
            { cause: error }
          );
        }
        promoted = false;
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
      if (promoted) {
        const materialized: StoredBuildResult = {
          dir: localDir,
          buildKey: key,
          sourceStateHash: sharedMetadata.sourceStateHash,
          metadata: sharedMetadata,
          artifacts: shared.artifacts,
        };
        rememberVerifiedLocalBuild(materialized);
      }
    } catch (error) {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Build ${key} hydration failed and temporary cleanup also failed`,
          { cause: error }
        );
      }
      throw error;
    }
    const materialized = await readVerifiedLocalBuild(key);
    if (materialized && !reportedSharedBuildHits.has(key)) {
      reportedSharedBuildHits.set(key, true);
      logVerbose(
        "BuildCache",
        `Reused shared build ${materialized.metadata.name} (${key.slice(0, 12)})`
      );
    }
    return materialized;
  }

  /** Hydrate immutable build artifacts through one provenance-binding boundary. */
  async function getOrHydrate(
    key: string,
    sourceStateHash?: string
  ): Promise<StoredBuildResult | null> {
    const localDir = getBuildDir(key);
    const local = await get(key);
    if (local) return local;

    if (isRetiredBuildKey(key)) return null;
    const sources = [
      ...(releaseBuildRoot ? [{ root: releaseBuildRoot, immutable: true }] : []),
      ...(sharedBuildResultCacheRoot
        ? [{ root: sharedBuildResultCacheRoot, immutable: false }]
        : []),
    ];
    for (const source of sources) {
      const sharedDir = path.join(source.root, key);
      const cacheRoot = source.root;
      await processOwner.wait(`publication:${path.resolve(sharedDir)}`);
      const lease = source.immutable
        ? null
        : derivedCacheCoordinator(cacheRoot).acquire(cacheRoot, key);
      let result: StoredBuildResult | null = null;
      const failures: unknown[] = [];
      try {
        result = await hydrateSharedBuild(key, sourceStateHash, sharedDir, localDir);
      } catch (error) {
        failures.push(error);
      }
      try {
        lease?.release();
      } catch (error) {
        failures.push(error);
      }
      if (!source.immutable) {
        try {
          await pruneSharedBuildCache(cacheRoot);
        } catch (error) {
          failures.push(error);
        }
      }
      const failure = joinedStoreFailures(
        failures,
        `Build ${key} hydration and shared-cache cleanup failed`
      );
      if (failure !== undefined || failures.length > 0) throw failure;
      if (result) return result;
      if (isRetiredBuildKey(key)) return null;
    }
    return null;
  }

  /** Resolve one retained execution of reusable artifact bytes without rebinding
   * or silently upgrading it to the build key's latest semantic source state. */
  async function getByExecution(
    key: string,
    executionDigest: string
  ): Promise<StoredBuildResult | null> {
    const current = await get(key);
    if (!current) return null;
    if (current.metadata.execution?.executionDigest === executionDigest) return current;
    try {
      const stored = JSON.parse(
        await fs.promises.readFile(executionMetadataPath(current.dir, executionDigest), "utf8")
      ) as StoredExecutionVariant;
      const variant = retainedExecutionVariant(stored, key, executionDigest);
      if (!variant) return null;
      const metadata: BuildMetadata = {
        ...current.metadata,
        serviceAuthorityDigest: variant.serviceAuthorityDigest,
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
    stored: StoredExecutionVariant,
    buildKey: string,
    executionDigest: string
  ): StoredExecutionVariant | null {
    if (
      stored.version !== 2 ||
      stored.execution?.buildKey !== buildKey ||
      stored.execution.executionDigest !== executionDigest ||
      !/^[0-9a-f]{64}$/u.test(stored.serviceAuthorityDigest)
    )
      return null;
    return stored;
  }

  /**
   * Rebind an immutable artifact set to the exact source state that requested it.
   * BuildV2 keys locate reusable artifact bytes; execution identity additionally
   * commits the source state, so reusing bytes across semantic states must update
   * the workspace-owned metadata before the result can be retained or executed.
   */
  async function rebindSourceState(
    build: StoredBuildResult,
    sourceStateHash: string
  ): Promise<StoredBuildResult> {
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
    metadataWithoutExecution.serviceAuthorityDigest =
      await sealServiceAuthority(metadataWithoutExecution);
    const execution = createBuildExecutionIdentity(metadataWithoutExecution, build.artifacts);
    if (!execution) {
      throw new Error(
        `Build ${build.buildKey} cannot be rebound without a workspace execution identity`
      );
    }
    const metadata: BuildMetadata = { ...metadataWithoutExecution, execution };
    const localDir = getBuildDir(build.buildKey);
    if (path.resolve(build.dir) === path.resolve(localDir)) {
      await writeExecutionMetadata(localDir, metadata);
      await writeBuildMetadata(localDir, metadata);
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

  function primaryArtifact(
    build: Pick<BuildResult | StoredBuildResult, "artifacts">,
    opts: { platform?: string } = {}
  ): BuildArtifactWithContent | StoredBuildArtifact | null {
    return (
      build.artifacts.find(
        (entry) =>
          entry.role === "primary" &&
          (opts.platform === undefined || entry.platform === opts.platform)
      ) ?? null
    );
  }

  async function primaryTextArtifactContent(
    build: Pick<BuildResult | StoredBuildResult, "artifacts" | "metadata" | "dir">,
    opts: { platform?: string } = {}
  ): Promise<string> {
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
    if (typeof artifact.content === "string") return artifact.content;
    return readStoredArtifactContent(build, artifact);
  }

  function artifactFilePath(
    build: Pick<{ dir: string }, "dir">,
    artifact: Pick<BuildArtifactManifestEntry, "path">
  ): string {
    if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid build artifact path: ${artifact.path}`);
    }
    return path.join(build.dir, artifact.path);
  }

  function primaryArtifactFilePath(
    build: Pick<BuildResult | StoredBuildResult, "dir" | "artifacts" | "metadata">,
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

  async function putStored(
    key: string,
    artifacts: BuildArtifacts,
    metadata: BuildMetadata
  ): Promise<StoredBuildResult> {
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
    sealedMetadata.serviceAuthorityDigest = await sealServiceAuthority(sealedMetadata);
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

    // Write the complete records, including the metadata sentinel, before promotion.
    await writeBuildRecords(tmpDir, storedMetadata, artifactManifest);

    // Race-safe promotion: try rename, handle concurrent winner
    try {
      await fs.promises.rename(tmpDir, dir);
    } catch (err: unknown) {
      if (fs.existsSync(dir)) {
        // Another build may have won the race. Accept it only after the same
        // manifest + execution-identity verification used by normal reads.
        if (fs.existsSync(metadataPath)) {
          const winner = await get(key);
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

    const stored = await readBuildDir(dir, key);
    if (!stored) throw new Error(`Published build ${key} failed verification`);
    clearRetiredBuildKey(key);
    const storedBuild = rememberVerifiedLocalBuild(stored);
    await scheduleSharedBuildPublication(key, dir);
    // Build publication can immediately feed a synchronous execution-owner
    // transaction. Admit the descriptor only after the promoted tree has passed
    // the same verification used by ordinary local reads.
    return storedBuild;
  }

  /** Materialize a stored build only for callers whose wire contract includes payload strings. */
  async function put(
    key: string,
    artifacts: BuildArtifacts,
    metadata: BuildMetadata
  ): Promise<BuildResult> {
    return materializeStoredBuild(await putStored(key, artifacts, metadata));
  }

  async function sealServiceAuthority(metadata: BuildMetadata): Promise<string | undefined> {
    if (metadata.sourceStateHash === null) return undefined;
    if (!activeExecutionIdentityContext)
      throw new Error("Workspace source authority has no sealing context");
    return parseSha256(
      await activeExecutionIdentityContext.serviceAuthorityForSource(metadata),
      "build service authority digest"
    );
  }

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

  function buildGcStatePath(): string {
    return stateLayout(stateRoot).executionRetention.buildGcFile;
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

  async function sourceRootsForStoredBuild(
    key: string
  ): Promise<ExecutionSourceContentRoot[] | null> {
    const build = await readBuildDir(getBuildDir(key), key);
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
  async function collectRetention(input: {
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
    const protectedKeys = new Set([
      ...input.rootedBuildKeys,
      ...input.publicationProtectedBuildKeys,
    ]);
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
    const trashRoot = stateLayout(stateRoot).executionRetention.buildTrashDir;
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
          missing:
            matches.length === 0 ? ["artifact bytes"] : ["unambiguous owned deletion record"],
        });
      }
    }
    for (const key of stored) {
      if (protectedKeys.has(key) || byKey.has(key)) continue;
      const sourceRoots = await sourceRootsForStoredBuild(key);
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
            error: formatRpcFailure(error),
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
          error: formatRpcFailure(error),
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
        stateLayout(stateRoot).executionRetention.buildTrashDir,
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
            error: formatRpcFailure(error),
          });
        }
      } catch (error) {
        result.cleanupFailures.push({
          buildKey: key,
          error: formatRpcFailure(error),
        });
      }
    }

    // A deleted artifact's source is retained for its deletion epoch. Only a
    // later complete epoch may remove the tombstone and withdraw those roots.
    saveBuildGcState({ version: 1, quarantined: [...byKey.values()] });

    if (result.deleted > 0) {
      try {
        await collectSharedArtifactPool();
      } catch (error) {
        result.cleanupFailures.push({
          buildKey: "shared-artifact-pool",
          error: formatRpcFailure(error),
        });
      }
    }

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
  async function scanRetention(): Promise<BuildStoreRetentionScan> {
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
          error: formatRpcFailure(error),
        });
      }
    }

    return { builds, failures };
  }

  async function drainPublications(): Promise<void> {
    const failures: unknown[] = [];
    while (ownPublicationTasks.size > 0) {
      const tasks = [...ownPublicationTasks];
      const outcomes = await Promise.allSettled(tasks);
      failures.push(
        ...outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
      );
    }
    const failure = joinedStoreFailures(failures, "BuildStore publication retirement failed");
    if (failure !== undefined || failures.length > 0) throw failure;
  }

  return {
    stateRoot,
    getBuildsDir,
    getBuildDir,
    readBuildMetadata,
    readExecutableModules,
    writeBuildMetadata,
    collectSharedArtifactPool,
    readStoredArtifactBytes,
    readStoredArtifactContent,
    materializeStoredBuild,
    buildDescriptorBytes,
    has,
    findSharedStyleBuild,
    peekLocal,
    readLocal,
    get,
    compilationMetadata,
    getOrHydrate,
    getByExecution,
    rebindSourceState,
    primaryArtifact,
    primaryTextArtifactContent,
    artifactFilePath,
    primaryArtifactFilePath,
    putStored,
    put,
    collectRetention,
    scanRetention,
    drainPublications,
  };
}
