import {
  matchesGlob,
  TextRangeAccumulator,
  normalizedReadTextOptions,
  byteRangeResult,
  normalizedReadBytesOptions,
  type ReadBytesResult,
  type ReadBytesOptions,
  type ReadTextResult,
  type ReadTextOptions,
  type GlobResult,
  type GrepResult,
  type GlobOptions,
  type GrepOptions,
  encodeBinary,
  isBinaryEnvelope,
  type BinaryEnvelope,
} from "./fsValues.js";
import type { FsDiskPort } from "./fsDisk.js";
/** Protected filesystem receiver. Semantic reads/edits retain verified caller
 * context here; raw disk operations run through the required native worker.
 * Source projections are read-only and scratch has a separate physical root. */

import * as path from "path";
import { createHash, randomBytes } from "node:crypto";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { ContextFolderManager } from "@vibestudio/shared/contextFolderManager";
import { createDevLogger } from "@vibestudio/dev-log";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  canonicalizeWorkspaceFilePath,
  CONTAINER_SECTIONS,
  splitRepoPath,
  taxonomyRepoForPath,
  type RepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { WORKSPACE_SOURCE_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";

/**
 * Narrow semantic-VCS port required by FsService. The service depends on this
 * structural capability, not on the host RPC schema package that happens to
 * implement it. This keeps the shared foundation below service-schemas.
 */
type VcsStateNodeRef =
  | { kind: "event"; eventId: string }
  | { kind: "application"; applicationId: string };
type VcsMutationEnvelope = {
  commandId: string;
  contextId: string;
  expectedWorkingHead: VcsStateNodeRef;
  intentSummary?: string;
};
type VcsEditChange =
  | {
      kind: "text-edit";
      repositoryId: string;
      fileId: string;
      edits: Array<{ start: number; end: number; text: string }>;
    }
  | { kind: "binary-replace"; repositoryId: string; fileId: string; base64: string; mode?: number }
  | {
      kind: "file-create";
      repositoryId: string;
      path: string;
      content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
      mode: number;
    }
  | { kind: "file-delete"; repositoryId: string; fileId: string }
  | { kind: "file-mode"; repositoryId: string; fileId: string; mode: number };
type VcsEditInput = VcsMutationEnvelope & { changes: VcsEditChange[] };
type VcsMoveInput = VcsMutationEnvelope & {
  moves: Array<{
    kind: "file";
    repositoryId: string;
    fileId: string;
    destinationRepositoryId: string;
    destinationPath: string;
  }>;
};
type VcsCopyInput = VcsMutationEnvelope & {
  copies: Array<{
    source: { state: VcsStateNodeRef; repositoryId: string; fileId: string };
    destination: { repositoryId: string; path: string };
  }>;
};
type VcsStatusInput = { contextId: string };
type VcsStatusResult = { workingHead: VcsStateNodeRef };
type VcsResolveRepositoryInput = { state: VcsStateNodeRef; repoPath: string };
type VcsResolveRepositoryResult = {
  state: VcsStateNodeRef;
  repositoryId: string;
  repoPath: string;
} | null;
type VcsReadFileInput = {
  state: VcsStateNodeRef;
  repositoryId: string;
  file: { kind: "id"; fileId: string } | { kind: "path"; path: string };
};
type VcsReadFileResult = {
  repositoryId: string;
  fileId: string;
  repoPath: string;
  path: string;
  contentHash: string;
  authoredChangeId: string;
  authoredByWorkUnitId: string;
  contentClass: "internal" | "external";
  externalKeys: string[];
  mode: number;
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
} | null;
type VcsListDirectoryInput = {
  state: VcsStateNodeRef;
  path: string;
  cursor?: string;
  limit: number;
};
type VcsVisibleDirectoryEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  identity: string;
  repositoryId: string | null;
  repositoryRoot: boolean;
  fileId: string | null;
  lineage: {
    authoredChangeId: string | null;
    authoredByWorkUnitId: string;
    contentClass: "internal" | "external";
    externalKeys: string[];
  };
};
type VcsListDirectoryResult = {
  state: VcsStateNodeRef;
  path: string;
  entries: VcsVisibleDirectoryEntry[];
  nextCursor: string | null;
} | null;
type VcsListFilesInput = {
  state: VcsStateNodeRef;
  repositoryId: string;
  prefix?: string;
  cursor?: string;
  limit: number;
};
type VcsFileListEntry = {
  fileId: string;
  path: string;
  contentHash: string;
  authoredChangeId: string;
  authoredByWorkUnitId: string;
  contentClass: "internal" | "external";
  externalKeys: string[];
  mode: number;
  contentKind: "text" | "bytes";
  byteLength: number;
  coordinateExtent: number;
};
type VcsListFilesResult = {
  state: VcsStateNodeRef;
  repositoryId: string;
  files: VcsFileListEntry[];
  nextCursor: string | null;
};

const log = createDevLogger("FsService");
const WORKSPACE_SOURCE_ROOTS = new Set<string>(WORKSPACE_SOURCE_DIRS);
const CANONICAL_SOURCE_ROOT_BY_LOWER = new Map(
  WORKSPACE_SOURCE_DIRS.map((sourceRoot) => [sourceRoot.toLowerCase(), sourceRoot])
);
const DISK_READ_PATH_METHODS = new Set([
  "readFile",
  "readText",
  "readBytes",
  "readdir",
  "stat",
  "lstat",
  "exists",
  "access",
  "open",
  "createReadStream",
  "copyFile",
]);
const AUTHORITY_PATH_METHODS = new Set([
  "readFile",
  "readText",
  "readBytes",
  "writeFile",
  "appendFile",
  "readdir",
  "mkdir",
  "rmdir",
  "rm",
  "stat",
  "lstat",
  "exists",
  "access",
  "unlink",
  "truncate",
  "readlink",
  "realpath",
  "chmod",
  "utimes",
  "open",
]);

/** Idle timeout for open file handles (5 minutes). */
const HANDLE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Tracked file handle with cleanup metadata. */
interface TrackedHandle {
  nativeId: number;
  panelId: string;
  timer: ReturnType<typeof setTimeout>;
  scope: FsCallScope;
}

interface ContextIngestionDescriptor {
  key: string;
  derivedClass: "internal" | "external";
}

function retainStrongestIngestionDescriptor(
  descriptors: Map<string, ContextIngestionDescriptor>,
  descriptor: ContextIngestionDescriptor
): void {
  const existing = descriptors.get(descriptor.key);
  if (!existing || descriptor.derivedClass === "external") {
    descriptors.set(descriptor.key, descriptor);
  }
}

type VcsFileLineage = Pick<
  NonNullable<VcsReadFileResult>,
  "repositoryId" | "fileId" | "authoredChangeId" | "contentClass" | "externalKeys"
>;

function ingestionDescriptorsForVcsRead(result: VcsFileLineage): ContextIngestionDescriptor[] {
  if (result.contentClass === "external") {
    const externalKeys = [...new Set(result.externalKeys)].sort(compareUtf16CodeUnits);
    if (externalKeys.length === 0) {
      throw codedError(
        "EINTEGRITY",
        `External file ${result.fileId} has no persisted outside-source lineage`
      );
    }
    return externalKeys.map((key) => ({ key, derivedClass: "external" }));
  }
  if (result.externalKeys.length > 0) {
    throw codedError("EINTEGRITY", `Internal file ${result.fileId} carries outside-source lineage`);
  }
  return [
    {
      key: `file:${encodeURIComponent(result.repositoryId)}/${encodeURIComponent(result.fileId)}@${result.authoredChangeId}`,
      derivedClass: "internal",
    },
  ];
}

function ingestionDescriptorsForVisibleEntries(
  entries: NonNullable<VcsListDirectoryResult>["entries"]
): ContextIngestionDescriptor[] {
  const descriptors = new Map<string, ContextIngestionDescriptor>();
  for (const entry of entries) {
    const lineage = entry.lineage;
    if (lineage.contentClass === "external") {
      if (lineage.externalKeys.length === 0) {
        throw codedError(
          "EINTEGRITY",
          `External visible entry ${entry.identity} has no persisted outside-source lineage`
        );
      }
      for (const key of lineage.externalKeys) {
        retainStrongestIngestionDescriptor(descriptors, {
          key,
          derivedClass: "external",
        });
      }
      continue;
    }
    if (lineage.externalKeys.length > 0) {
      throw codedError(
        "EINTEGRITY",
        `Internal visible entry ${entry.identity} carries outside-source lineage`
      );
    }
    retainStrongestIngestionDescriptor(descriptors, {
      key: `entry:${encodeURIComponent(entry.identity)}@${lineage.authoredChangeId ?? lineage.authoredByWorkUnitId}`,
      derivedClass: "internal",
    });
  }
  return [...descriptors.values()];
}

interface FsCallScope {
  root: string;
  sourceRoot: string;
  panelId: string;
  contextId?: string;
  exposeHostPaths: boolean;
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Sparse materialization scoping
// ---------------------------------------------------------------------------

/**
 * The minimal repo scope a workspace path needs materialized. A file/repo path →
 * its single owning repo; a section prefix (e.g. `panels`) → that prefix (the
 * VCS layer expands it to the repos under it); ONLY the workspace root → `"all"`.
 * We deliberately avoid `"all"` for anything narrower than a true root operation.
 */
function scopeForPath(wsRel: string): RepoPath[] | "all" | null {
  const norm = wsRel.replace(/^\/+/, "").replace(/\/+$/, "");
  if (norm === "" || norm === ".") return "all";
  const repo = taxonomyRepoForPath(norm);
  if (repo) return [repo];
  // Section prefix (e.g. "panels") — expanded to repos-under-it by the VCS layer.
  if (CONTAINER_SECTIONS.has(norm)) return [norm];
  return null;
}

/** The path a disk-reading fs method scopes to (its search/target path), or null
 *  for methods that don't read managed content. */
function readScopePath(method: string, args: unknown[]): string | null {
  if (method === "grep") return (args[1] as { path?: string } | undefined)?.path ?? "/";
  // glob(pattern, opts) — pattern is args[0] (a string); the search `path` lives on
  // the OPTIONS object at args[1], same as grep. Reading args[0].path always missed
  // (the pattern is a string), so every glob fell back to "/" and materialized the
  // whole workspace instead of just the scoped subtree.
  if (method === "glob") return (args[1] as { path?: string } | undefined)?.path ?? "/";
  // NB: `realpath`/`readlink` are path canonicalization (no content read) and are
  // intentionally excluded — path canonicalization alone must not provision a
  // context projection.
  if (DISK_READ_PATH_METHODS.has(method)) {
    const a = args[0];
    return typeof a === "string" ? a : null;
  }
  return null;
}

/** Paths whose data is owned by the semantic workspace authority for a call.
 * This is deliberately operation-shaped: scratch-only construction must reject
 * before a generic disk switch can observe or mutate a reserved source root. */
function authorityPathsForCall(method: string, args: unknown[]): string[] {
  if (method === "ensureMaterialized") {
    const value = args[0];
    return value === "all"
      ? ["/"]
      : (Array.isArray(value) ? value : [value]).filter(
          (item): item is string => typeof item === "string"
        );
  }
  if (method === "grep" || method === "glob") {
    return [String((args[1] as { path?: string } | undefined)?.path ?? "/")];
  }
  if (method === "copyFile" || method === "rename") {
    return [args[0], args[1]].filter((item): item is string => typeof item === "string");
  }
  if (method === "symlink") {
    return [args[0], args[1]].filter((item): item is string => typeof item === "string");
  }
  return AUTHORITY_PATH_METHODS.has(method) && typeof args[0] === "string" ? [args[0]] : [];
}

function requiresSemanticAuthority(userPath: string): boolean {
  const normalized = path.posix.normalize(
    userPath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "")
  );
  if (normalized === "" || normalized === ".") return true;
  const sourceRoot = normalized.split("/", 1)[0] ?? "";
  return CANONICAL_SOURCE_ROOT_BY_LOWER.has(sourceRoot.toLowerCase());
}

/** Resolve logical input without consulting native paths or worker output.
 * Only original semantic coordinates can authorize protected repository edits. */
function contextLogicalPath(userPath: string, options: { directory?: boolean } = {}): string {
  const input = options.directory ? userPath : canonicalizeWorkspaceFilePath(userPath);
  const logical = input.replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(logical);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("\0"))
    throw codedError("EACCES", "Path traversal detected");
  return normalized === "." ? "" : normalized;
}

function requestedReadEncoding(value: unknown): BufferEncoding | undefined {
  if (typeof value === "string") return value as BufferEncoding;
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { encoding?: unknown }).encoding === "string"
  ) {
    return (value as { encoding: BufferEncoding }).encoding;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Semantic VCS reroute — managed source mutations never write raw disk
// ---------------------------------------------------------------------------

/** Write content for a semantic edit (text, or base64 bytes). */
export type FsVcsContent = { kind: "text"; text: string } | { kind: "bytes"; base64: string };

/** Managed trees model regular files plus the executable bit, not arbitrary inode modes. */
function isExecutableMode(mode: number): boolean {
  if (!Number.isInteger(mode) || mode < 0) {
    throw codedError("EINVAL", `invalid file mode: ${String(mode)}`);
  }
  return (mode & 0o111) !== 0;
}

/** The edit ops the fs reroute emits (a subset of the vcs edit-op union). */
export type FsVcsEditOp =
  | { kind: "write"; path: string; content: FsVcsContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

export interface FsVcsMutationIntegrity {
  class: "internal" | "external";
  externalKeys: readonly string[];
}

/**
 * Bridge from the fs service to the workspace semantic VCS. When a sandboxed
 * context caller mutates a managed path, `edit` advances the working state and
 * the host materializes that state; the caller never writes managed disk bytes.
 * Paths outside reserved source roots (`.tmp`, `.testkit`, …) use native scratch.
 * Ignored paths inside a source repository cannot become raw disk writes.
 *
 * All tracked paths are resolved against one exact working state and one
 * workspace-wide edit transaction. Repository coordinates route content; they
 * do not split history or atomicity. Ordinary paths outside workspace source
 * roots remain context-local scratch.
 */
export interface FsVcsBridge {
  /** True iff `relPath` passes the VCS content-path policy (safe and not
   *  platform-ignored). FsService separately checks workspace repo taxonomy. */
  isTracked(relPath: string): Promise<boolean>;
  edit(
    input: VcsEditInput,
    causalParent: RpcCausalParent | null,
    contextIntegrity: FsVcsMutationIntegrity
  ): Promise<unknown>;
  move(
    input: VcsMoveInput,
    causalParent: RpcCausalParent | null,
    contextIntegrity: FsVcsMutationIntegrity
  ): Promise<unknown>;
  copy(
    input: VcsCopyInput,
    causalParent: RpcCausalParent | null,
    contextIntegrity: FsVcsMutationIntegrity
  ): Promise<unknown>;
  status(input: VcsStatusInput): Promise<VcsStatusResult>;
  resolveRepository(input: VcsResolveRepositoryInput): Promise<VcsResolveRepositoryResult>;
  readFile(input: VcsReadFileInput): Promise<VcsReadFileResult>;
  listDirectory(input: VcsListDirectoryInput): Promise<VcsListDirectoryResult>;
  listFiles(input: VcsListFilesInput): Promise<VcsListFilesResult>;
  /**
   * Ensure the context's complete authority-published projection exists before
   * a disk consumer walks it. `repos` records the caller's narrow read intent;
   * it does not create a partial or parallel projection channel.
   */
  ensureMaterialized(contextId: string, repos: RepoPath[] | "all"): Promise<void>;
  /** True iff `repoPath`'s subtree is currently materialized on disk for the
   *  context. Backs the loud read-time assertion. */
  isMaterialized(contextId: string, repoPath: RepoPath): Promise<boolean>;
}

interface ManagedWorkspaceRepository {
  repositoryId: string;
  repoPath: RepoPath;
}

interface ManagedWorkspaceSnapshot {
  state: VcsStateNodeRef;
  repositories: ManagedWorkspaceRepository[];
}

const SEMANTIC_READ_CONCURRENCY = 8;

async function mapWithBoundedConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      outputs[index] = await mapper(inputs[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return outputs;
}

async function listAllDirectoryEntries(
  bridge: FsVcsBridge,
  state: VcsStateNodeRef,
  path: string
): Promise<NonNullable<VcsListDirectoryResult>["entries"]> {
  const entries: NonNullable<VcsListDirectoryResult>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await bridge.listDirectory({
      state,
      path,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    if (!page) return [];
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

/** Resolve the bounded repository catalog from canonical visible entries. */
async function managedWorkspaceSnapshot(
  bridge: FsVcsBridge,
  contextId: string
): Promise<ManagedWorkspaceSnapshot> {
  const { workingHead: state } = await bridge.status({ contextId });
  const roots = await listAllDirectoryEntries(bridge, state, "");
  const repositories: ManagedWorkspaceRepository[] = [];
  const containers: string[] = [];
  for (const entry of roots) {
    if (entry.kind !== "directory" || !entry.repositoryId) continue;
    if (entry.repositoryRoot) {
      repositories.push({
        repositoryId: entry.repositoryId,
        repoPath: entry.path as RepoPath,
      });
    } else {
      containers.push(entry.path);
    }
  }
  const nested = await mapWithBoundedConcurrency(
    containers,
    SEMANTIC_READ_CONCURRENCY,
    (container) => listAllDirectoryEntries(bridge, state, container)
  );
  for (const entry of nested.flat()) {
    if (entry.kind !== "directory" || !entry.repositoryRoot || !entry.repositoryId) continue;
    repositories.push({
      repositoryId: entry.repositoryId,
      repoPath: entry.path as RepoPath,
    });
  }
  repositories.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
  return { state, repositories };
}

function managedRepository(
  snapshot: ManagedWorkspaceSnapshot,
  repoPath: RepoPath
): ManagedWorkspaceRepository {
  const repository = snapshot.repositories.find((candidate) => candidate.repoPath === repoPath);
  if (!repository) {
    throw codedError("ENOENT", `managed repository is absent at working state: ${repoPath}`);
  }
  return repository;
}

async function managedFile(
  bridge: FsVcsBridge,
  snapshot: ManagedWorkspaceSnapshot,
  repositoryId: string,
  filePath: string
): Promise<VcsListFilesResult["files"][number] | null> {
  let cursor: string | undefined;
  do {
    const page = await bridge.listFiles({
      state: snapshot.state,
      repositoryId,
      prefix: filePath,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    const file = page.files.find((candidate) => candidate.path === filePath);
    if (file) return file;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

async function managedWorkspaceFiles(
  bridge: FsVcsBridge,
  snapshot: ManagedWorkspaceSnapshot
): Promise<Array<ManagedWorkspaceRepository & VcsListFilesResult["files"][number]>> {
  const perRepository = await mapWithBoundedConcurrency(
    snapshot.repositories,
    SEMANTIC_READ_CONCURRENCY,
    async (repository) => {
      const files: Array<ManagedWorkspaceRepository & VcsListFilesResult["files"][number]> = [];
      let cursor: string | undefined;
      do {
        const page = await bridge.listFiles({
          state: snapshot.state,
          repositoryId: repository.repositoryId,
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        files.push(...page.files.map((file) => ({ ...repository, ...file })));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return files;
    }
  );
  return perRepository.flat();
}

/**
 * Plan exact repo-root reads when every glob names a literal file below a
 * repository-pattern prefix (for example a two-segment repo plus `SKILL.md`).
 * reads from enumerating every source file in every repository merely to find
 * one well-known metadata file.
 */
function managedRepoRootFileCandidates(
  snapshot: ManagedWorkspaceSnapshot,
  patterns: readonly string[]
): Array<ManagedWorkspaceRepository & { path: string }> | null {
  const parsed = patterns.map((pattern) => {
    if (!pattern.includes("/")) return null;
    const segments = pattern.split("/");
    const fileName = segments.at(-1);
    if (!fileName || /[*?[\]{}]/u.test(fileName)) return null;
    return { pattern, segments, fileName };
  });
  if (parsed.some((entry) => entry === null)) return null;

  const candidates = new Map<string, ManagedWorkspaceRepository & { path: string }>();
  for (const repository of snapshot.repositories) {
    const repoSegments = repository.repoPath.split("/");
    for (const entry of parsed) {
      if (!entry || entry.segments.length !== repoSegments.length + 1) continue;
      const workspacePath = `${repository.repoPath}/${entry.fileName}`;
      if (!matchesGlob(workspacePath, entry.pattern)) continue;
      candidates.set(`${repository.repositoryId}\u0000${entry.fileName}`, {
        ...repository,
        path: entry.fileName,
      });
    }
  }
  return [...candidates.values()];
}

async function managedWorkspaceFilesMatching(
  bridge: FsVcsBridge,
  snapshot: ManagedWorkspaceSnapshot,
  patterns: readonly string[]
): Promise<Array<ManagedWorkspaceRepository & VcsListFilesResult["files"][number]>> {
  const candidates = managedRepoRootFileCandidates(snapshot, patterns);
  if (!candidates) {
    return (await managedWorkspaceFiles(bridge, snapshot)).filter((file) => {
      const workspacePath = `${file.repoPath}/${file.path}`;
      return patterns.some((pattern) => matchesGlob(workspacePath, pattern));
    });
  }
  const files = await mapWithBoundedConcurrency(
    candidates,
    SEMANTIC_READ_CONCURRENCY,
    async (candidate) => {
      const file = await managedFile(bridge, snapshot, candidate.repositoryId, candidate.path);
      return file ? { ...candidate, ...file } : null;
    }
  );
  return files.filter(
    (file): file is ManagedWorkspaceRepository & VcsListFilesResult["files"][number] =>
      file !== null
  );
}

/**
 * Explicit construction authority for context-bound filesystem calls.
 *
 * `semantic` is the production adapter and owns every reserved workspace source
 * root. `scratch-only` is useful for deliberately isolated context-local files;
 * it may never observe or mutate a reserved root. There is no optional bridge
 * and therefore no missing-dependency fallthrough to a projected worktree.
 */
export type FsContextAuthority =
  | { kind: "semantic"; bridge: FsVcsBridge }
  | { kind: "scratch-only" };

export interface FsCallTelemetry {
  method: string;
  phase: "scope" | "materialize" | "operation";
  durationMs: number;
  contextId?: string;
  materializationScope?: "all" | number;
}

export interface FsServiceOptions {
  disk: FsDiskPort;
  contextAuthority: FsContextAuthority;
  /** Monotone latch update that must settle before managed read bytes return. */
  recordContextIngestion?: (
    ctx: ServiceContext,
    input: {
      key: string;
      via: string;
      classification: "derived";
      derivedClass: "internal" | "external";
    }
  ) => void | Promise<void>;
  /** One operation's lineage must become visible to the latch all-or-nothing. */
  recordContextIngestionBatch?: (
    ctx: ServiceContext,
    inputs: readonly {
      key: string;
      via: string;
      classification: "derived";
      derivedClass: "internal" | "external";
    }[]
  ) => void | Promise<void>;
  /** Structured phase timings for diagnosing filesystem transport stalls. */
  onTelemetry?: (event: FsCallTelemetry) => void;
  /** Default logging threshold when no telemetry sink is installed. */
  slowPhaseMs?: number;
}

/**
 * Decide whether a context mutation belongs on a repo's semantic working state or
 * on the context-local scratch disk.
 *
 * VCS content-path admissibility and workspace repo membership are distinct:
 * a harmless root file such as `.probe.txt` is safe but has no owning repo. It
 * is therefore scratch, not a malformed VCS edit. Conversely, paths beneath a
 * reserved workspace source root must not silently become scratch when their
 * repo shape is invalid (`packages`, `agents/foo`, etc.), because such files can
 * shadow or corrupt the authority-published context projection.
 *
 * Repo roots return `true` even though they have no repo-relative filename so
 * the existing operation-specific router can either handle subtree operations
 * or emit its actionable repo-root error for file mutations.
 */
async function isManagedVcsPath(_bridge: FsVcsBridge, wsRel: string): Promise<boolean> {
  const sourceRoot = wsRel.split("/", 1)[0] ?? "";
  const canonicalSourceRoot = CANONICAL_SOURCE_ROOT_BY_LOWER.get(sourceRoot.toLowerCase());
  if (canonicalSourceRoot && sourceRoot !== canonicalSourceRoot) {
    throw codedError(
      "EACCES",
      `fs mutation rejected: workspace source root ${JSON.stringify(sourceRoot)} has ` +
        `non-canonical casing; use ${JSON.stringify(canonicalSourceRoot)} instead.`
    );
  }

  const split = splitRepoPath(wsRel);
  if (split) {
    if (!split.repoRelPath) return true;
    return true;
  }

  if (WORKSPACE_SOURCE_ROOTS.has(sourceRoot)) {
    throw codedError(
      "EACCES",
      `fs mutation rejected: ${JSON.stringify(wsRel)} is under reserved workspace source root ` +
        `${JSON.stringify(sourceRoot)} but is not a writable workspace-repo file. ` +
        `Use a repo-shaped source path (for example projects/<name>/<file>) or a ` +
        `context-local scratch path (for example .tmp/<file>).`
    );
  }

  return false;
}

/**
 * Per-call path→repo router. Maps a workspace-relative edit path to its owning
 * repo (by section taxonomy) + repo-relative remainder and rejects paths outside
 * any workspace repo.
 */
interface RepoRouter {
  /** Owning repo + repo-relative path. */
  route(wsRelPath: string): { repoPath: RepoPath; repoRelPath: string };
  /** Throw EACCES if `wsRelPath` is not inside any workspace repo. */
  assertWritable(wsRelPath: string): void;
}

function contentToBuffer(c: FsVcsContent): Buffer {
  return c.kind === "text" ? Buffer.from(c.text, "utf8") : Buffer.from(c.base64, "base64");
}

function dataToVcsContent(data: unknown): FsVcsContent {
  if (isBinaryEnvelope(data)) return { kind: "bytes", base64: data.data };
  return { kind: "text", text: data as string };
}

function appendVcsContent(existing: FsVcsContent | null, data: unknown): FsVcsContent {
  const add = dataToVcsContent(data);
  if (!existing) return add;
  if (existing.kind === "text" && add.kind === "text") {
    return { kind: "text", text: existing.text + add.text };
  }
  return {
    kind: "bytes",
    base64: Buffer.concat([contentToBuffer(existing), contentToBuffer(add)]).toString("base64"),
  };
}

function truncateVcsContent(existing: FsVcsContent | null, len: number): FsVcsContent {
  if (!existing) throw codedError("ENOENT", "truncate: managed file not found");
  const targetLength = Math.max(0, len);
  const source = contentToBuffer(existing);
  const truncated = Buffer.alloc(targetLength);
  source.copy(truncated, 0, 0, Math.min(source.length, targetLength));

  if (existing.kind === "bytes") {
    return { kind: "bytes", base64: truncated.toString("base64") };
  }
  // POSIX truncate is byte-oriented. Preserve the text representation only
  // when the exact result remains valid UTF-8; a cut through a code point must
  // not be repaired with U+FFFD because that changes the requested bytes.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(truncated);
    return { kind: "text", text };
  } catch {
    return { kind: "bytes", base64: truncated.toString("base64") };
  }
}

// ---------------------------------------------------------------------------
// Stat serialisation
// ---------------------------------------------------------------------------

const INTERNAL_PROJECTION_ENTRIES = new Set([".gad"]);

function readBytesRangeFromBuffer(bytes: Buffer, rawOptions?: ReadBytesOptions): ReadBytesResult {
  const options = normalizedReadBytesOptions(rawOptions);
  const selected = bytes.subarray(options.offset, options.offset + options.limit);
  return byteRangeResult(
    selected,
    bytes.length,
    createHash("sha256").update(bytes).digest("hex"),
    options
  );
}

function readTextRangeFromBuffer(bytes: Buffer, options?: ReadTextOptions): ReadTextResult {
  const accumulator = new TextRangeAccumulator(normalizedReadTextOptions(options));
  accumulator.push(bytes.toString("utf8"));
  return accumulator.finish(createHash("sha256").update(bytes).digest("hex"), bytes.length);
}

export class FsService {
  private readonly disk: FsDiskPort;
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly contextFolderManager: ContextFolderManager;
  private readonly entityCache: EntityCache;
  /** Explicit semantic-workspace or scratch-only construction authority. */
  private readonly contextAuthority: FsContextAuthority;
  private readonly recordContextIngestion?: FsServiceOptions["recordContextIngestion"];
  private readonly recordContextIngestionBatch?: FsServiceOptions["recordContextIngestionBatch"];
  private readonly onTelemetry?: FsServiceOptions["onTelemetry"];
  private readonly slowPhaseMs: number;

  /** handleId → TrackedHandle */
  private readonly openHandles = new Map<number, TrackedHandle>();
  private nextHandleId = 1;

  constructor(
    contextFolderManager: ContextFolderManager,
    entityCache: EntityCache,
    opts: FsServiceOptions
  ) {
    this.disk = opts.disk;
    this.contextFolderManager = contextFolderManager;
    this.entityCache = entityCache;
    this.contextAuthority = opts.contextAuthority;
    this.recordContextIngestion = opts.recordContextIngestion;
    this.recordContextIngestionBatch = opts.recordContextIngestionBatch;
    this.onTelemetry = opts.onTelemetry;
    this.slowPhaseMs = opts.slowPhaseMs ?? 1_000;
  }

  private emitTelemetry(event: FsCallTelemetry): void {
    try {
      this.onTelemetry?.(event);
    } catch (error) {
      console.warn("[fs.telemetry] observer failed", error);
    }
    if (!this.onTelemetry && event.durationMs >= this.slowPhaseMs) {
      console.warn(`[fs.telemetry] ${JSON.stringify(event)}`);
    }
  }

  private semanticBridge(scope: FsCallScope): FsVcsBridge | null {
    if (!scope.contextId) return null;
    return this.contextAuthority.kind === "semantic" ? this.contextAuthority.bridge : null;
  }

  /**
   * Read a selected managed corpus from one exact semantic snapshot without
   * projecting the workspace to disk. Discovery, bytes, and lineage are one
   * operation: callers cannot accidentally enumerate at one working head and
   * read each result through a succession of later heads.
   */
  async readManagedFiles(
    ctx: ServiceContext,
    patterns: readonly string[],
    options?: { explicitContextId: string }
  ): Promise<Array<{ path: string; content: string }>> {
    if (
      patterns.length === 0 ||
      patterns.some((pattern) => typeof pattern !== "string" || pattern.length === 0)
    ) {
      throw new Error("Managed file reads require non-empty glob patterns");
    }
    const scope = await this.resolveContextRoot(ctx, options ? [options.explicitContextId] : []);
    const bridge = this.semanticBridge(scope);
    if (!bridge || !scope.contextId) {
      throw codedError(
        "ESEMANTICAUTHORITY",
        "Managed file reads require an exact semantic workspace context"
      );
    }
    const snapshot = await managedWorkspaceSnapshot(bridge, scope.contextId);
    const pointCandidates = managedRepoRootFileCandidates(snapshot, patterns);
    if (pointCandidates) {
      const resolved = (
        await mapWithBoundedConcurrency(
          pointCandidates,
          SEMANTIC_READ_CONCURRENCY,
          async (candidate) => {
            const result = await bridge.readFile({
              state: snapshot.state,
              repositoryId: candidate.repositoryId,
              file: { kind: "path", path: candidate.path },
            });
            if (!result) return null;
            return {
              path: `/${candidate.repoPath}/${candidate.path}`,
              content:
                result.content.kind === "text"
                  ? result.content.text
                  : Buffer.from(result.content.base64, "base64").toString("utf8"),
              ingestion: ingestionDescriptorsForVcsRead(result),
            };
          }
        )
      )
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
      const ingestion = new Map<string, ContextIngestionDescriptor>();
      for (const file of resolved) {
        for (const descriptor of file.ingestion) {
          retainStrongestIngestionDescriptor(ingestion, descriptor);
        }
      }
      await this.recordProjectedIngestion(ctx, "fs-managed-corpus-read", [...ingestion.values()]);
      return resolved.map(({ path, content }) => ({ path, content }));
    }
    const files = (await managedWorkspaceFilesMatching(bridge, snapshot, patterns)).sort(
      (left, right) =>
        compareUtf16CodeUnits(`${left.repoPath}/${left.path}`, `${right.repoPath}/${right.path}`)
    );

    const resolved = await mapWithBoundedConcurrency(
      files,
      SEMANTIC_READ_CONCURRENCY,
      async (file) => {
        const result = await bridge.readFile({
          state: snapshot.state,
          repositoryId: file.repositoryId,
          file: { kind: "id", fileId: file.fileId },
        });
        if (!result) {
          throw codedError(
            "EINTEGRITY",
            `Managed file ${JSON.stringify(`${file.repoPath}/${file.path}`)} disappeared during the exact corpus read`
          );
        }
        return {
          path: `/${file.repoPath}/${file.path}`,
          content:
            result.content.kind === "text"
              ? result.content.text
              : Buffer.from(result.content.base64, "base64").toString("utf8"),
          ingestion: ingestionDescriptorsForVcsRead(result),
        };
      }
    );

    const ingestion = new Map<string, ContextIngestionDescriptor>();
    for (const file of resolved) {
      for (const descriptor of file.ingestion) {
        retainStrongestIngestionDescriptor(ingestion, descriptor);
      }
    }
    await this.recordProjectedIngestion(ctx, "fs-managed-corpus-read", [...ingestion.values()]);

    return resolved.map(({ path, content }) => ({ path, content }));
  }

  private assertScratchOnlyCall(scope: FsCallScope, method: string, args: unknown[]): void {
    if (!scope.contextId || this.contextAuthority.kind !== "scratch-only") {
      return;
    }
    const managedPath = authorityPathsForCall(method, args)
      .map((input) => contextLogicalPath(input, { directory: true }))
      .find(requiresSemanticAuthority);
    if (managedPath === undefined) return;
    throw codedError(
      "ESEMANTICAUTHORITY",
      `fs.${method} cannot access managed workspace path ${JSON.stringify(managedPath)}: ` +
        `this filesystem adapter has scratch-only authority and no semantic VCS capability`
    );
  }

  // =========================================================================
  // FileHandle cleanup
  // =========================================================================

  /** Close all open file handles for a given caller. */
  closeHandlesForCaller(callerId: string): void {
    this._closeHandlesImpl(callerId);
  }

  private closeDisk(operation: Promise<unknown>): void {
    const closing = operation
      .then(
        () => undefined,
        (error) => {
          log.warn("Disk handle cleanup failed", { error: String(error) });
        }
      )
      .finally(() => this.pendingCloses.delete(closing));
    this.pendingCloses.add(closing);
  }

  async stop(): Promise<void> {
    for (const caller of new Set([...this.openHandles.values()].map((handle) => handle.panelId)))
      this._closeHandlesImpl(caller);
    await Promise.all(this.pendingCloses);
  }

  private _closeHandlesImpl(callerId: string): void {
    for (const [id, tracked] of this.openHandles) {
      if (tracked.panelId !== callerId) continue;
      clearTimeout(tracked.timer);
      this.openHandles.delete(id);
    }
    this.closeDisk(this.disk.closeCaller(callerId, AbortSignal.timeout(1_000)));
  }

  // =========================================================================
  // Context resolution
  // =========================================================================

  /**
   * Resolve the COMPOSED context root path for a service call. The root is the
   * current-epoch disposable projection for a full logical workspace branch.
   * Repos are materialized on demand under their workspace subtrees. Edit
   * routing maps each path back to its owning repo by section taxonomy.
   * - panel/app/worker/DO callers: look up contextId from EntityCache
   * - agent callers: use the host-verified connection binding
   * - extension callers inside an invocation: use the chained caller context
   * - extension callers outside an invocation: rejected; host acquisition is a separate service
   * - server/shell callers: contextId is the first arg (shifted from
   *   the args array). Shell callers must name an existing
   *   context; server callers may create one on the fly.
   */
  private async resolveContextRoot(ctx: ServiceContext, args: unknown[]): Promise<FsCallScope> {
    let contextId: string;
    let panelId: string;

    if (ctx.caller.runtime.kind === "agent") {
      const binding = ctx.caller.agentBinding;
      if (!binding) {
        throw new Error("agent fs caller has no entity binding");
      }
      contextId = binding.contextId;
      panelId = ctx.caller.runtime.id;
    } else if (
      ctx.caller.runtime.kind === "panel" ||
      ctx.caller.runtime.kind === "app" ||
      ctx.caller.runtime.kind === "worker" ||
      ctx.caller.runtime.kind === "do"
    ) {
      panelId = ctx.caller.runtime.id;
      const cid = this.entityCache.resolveContext(panelId);
      if (!cid) {
        throw new Error(`No context registered for ${ctx.caller.runtime.kind} ${panelId}`);
      }
      contextId = cid;
    } else if (ctx.caller.runtime.kind === "extension") {
      if (ctx.chainCaller) {
        panelId = `extension:${ctx.caller.runtime.id}:chain:${ctx.chainCaller.callerId}`;
        const cid = this.entityCache.resolveContext(ctx.chainCaller.callerId);
        if (!cid) {
          throw new Error(
            `No context registered for ${ctx.chainCaller.callerKind} ${ctx.chainCaller.callerId}`
          );
        }
        contextId = cid;
        const state = this.contextFolderManager.getContextFolderState(contextId);
        if (state.status !== "ready") {
          throw codedError(
            "ENOTREADY",
            `Context folder ${contextId} is ${state.status}; scoped extension filesystem calls must wait for context materialization`
          );
        }
        const root = await this.contextFolderManager.ensureContextFolder(contextId);
        return {
          sourceRoot: root,
          root: await this.contextFolderManager.ensureContextScratch(contextId),
          panelId,
          contextId,
          exposeHostPaths: true,
        };
      }
      throw codedError(
        "EACCES",
        `Extension ${ctx.caller.runtime.id} filesystem calls require an on-behalf-of context`
      );
    } else {
      // Server / shell callers pass an explicit contextId as the
      // first argument.
      const kind = ctx.caller.runtime.kind;
      contextId = args.shift() as string;
      panelId = `${kind}:${ctx.caller.runtime.id}`;
      if (!contextId || typeof contextId !== "string") {
        throw new Error(`${kind} fs calls must provide contextId as first argument`);
      }
      if (kind !== "server") {
        // Shell callers may only address contexts that already
        // exist (a context folder on disk, or an active entity bound to the
        // context). Server callers are trusted to create contexts.
        const known =
          this.contextFolderManager.getContextRoot(contextId) !== null ||
          this.entityCache.listActive().some((record) => record.contextId === contextId);
        if (!known) {
          throw new Error(`Unknown contextId: ${contextId}`);
        }
      }
    }

    const root = await this.contextFolderManager.ensureContextFolder(contextId);
    return {
      sourceRoot: root,
      root: await this.contextFolderManager.ensureContextScratch(contextId),
      panelId,
      contextId,
      exposeHostPaths: false,
    };
  }

  // =========================================================================
  // FileHandle helpers
  // =========================================================================

  private trackHandle(nativeId: number, scope: FsCallScope): number {
    const panelId = scope.panelId;
    const id = this.nextHandleId++;
    const timer = setTimeout(() => this.expireHandle(id), HANDLE_IDLE_TIMEOUT_MS);
    this.openHandles.set(id, { nativeId, panelId, timer, scope });
    return id;
  }

  private expireHandle(id: number): void {
    const tracked = this.openHandles.get(id);
    if (!tracked) return;
    this.openHandles.delete(id);
    clearTimeout(tracked.timer);
    this.closeDisk(
      this.disk.call(tracked.scope, "handleClose", [tracked.nativeId], AbortSignal.timeout(1_000))
    );
  }

  private getTrackedHandle(id: number, callerId: string): TrackedHandle {
    const tracked = this.openHandles.get(id);
    if (!tracked) throw new Error(`Invalid file handle: ${id}`);
    if (tracked.panelId !== callerId)
      throw new Error(`File handle ${id} does not belong to caller`);
    clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => this.expireHandle(id), HANDLE_IDLE_TIMEOUT_MS);
    return tracked;
  }

  /**
   * Resolve caller-visible projected paths back to exact semantic name
   * provenance. A filename is content too, so a returned directory covers the
   * descendant paths that establish it. The semantic listing supplies
   * authorship/class facts without reading any file body. Internal versions
   * retain exact file identity; external versions collapse to their persisted
   * outside sources so one imported tree cannot exhaust the session latch.
   */

  /** Native diagnostics and acknowledgements are data too, including failures. */
  private async callDisk(
    ctx: ServiceContext,
    scope: FsCallScope,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    await this.recordProjectedIngestion(ctx, "fs-native-read", [
      { key: `session:native-fs:${scope.contextId ?? "scratch"}`, derivedClass: "external" },
    ]);
    return this.disk.call(scope, method, args, ctx.signal);
  }

  private async recordProjectedIngestion(
    ctx: ServiceContext,
    via: string,
    descriptors: readonly ContextIngestionDescriptor[]
  ): Promise<void> {
    if (!this.recordContextIngestion || !ctx.caller.agentBinding) return;
    if (descriptors.length === 0) return;
    const inputs = descriptors.map((descriptor) => ({
      key: descriptor.key,
      via,
      classification: "derived" as const,
      derivedClass: descriptor.derivedClass,
    }));
    if (inputs.length > 1) {
      if (!this.recordContextIngestionBatch) {
        throw codedError(
          "EINTEGRITY",
          "Filesystem lineage recorder does not support atomic batch ingestion"
        );
      }
      await this.recordContextIngestionBatch(ctx, inputs);
      return;
    }
    await this.recordContextIngestion(ctx, inputs[0]!);
  }

  // =========================================================================
  // Semantic VCS reroute
  // =========================================================================

  /**
   * Intercept managed single-file reads and mutating fs calls from a sandboxed
   * context caller. Reads resolve the exact working state and return its
   * content-addressed bytes; mutations advance semantic state before materialization.
   * Scratch paths are delegated to the native disk worker.
   */
  private async maybeRouteToVcs(
    bridge: FsVcsBridge | null,
    scope: FsCallScope,
    ctx: ServiceContext,
    method: string,
    args: unknown[]
  ): Promise<{ handled: boolean; result?: unknown }> {
    if (!bridge || !scope.contextId) return { handled: false };
    const contextId = scope.contextId;
    const commandId = `fs:${ctx.idempotencyKey ?? ctx.requestId ?? randomBytes(16).toString("hex")}:${method}`;
    const causalParent = ctx.causalParent ?? null;
    const mutationIntegrity = (): FsVcsMutationIntegrity => {
      const fact = ctx.authorization?.contextIntegrity;
      if (!fact) {
        throw codedError(
          "EACCES",
          "Managed filesystem mutation requires resolved context-integrity authority"
        );
      }
      return fact.class === "external"
        ? { class: "external", externalKeys: [...fact.externalKeys] }
        : { class: "internal", externalKeys: [] };
    };
    const agentBinding =
      ctx.caller.agentBinding ??
      this.entityCache.resolveActive(ctx.caller.runtime.id)?.agentBinding ??
      null;
    const requireManagedCause = (): void => {
      if (!agentBinding || ctx.causalParent) return;
      throw codedError(
        "EACCES",
        "Agent-bound managed filesystem mutation requires an exact causal tool invocation"
      );
    };

    const router = this.buildRepoRouter();

    const relOf = (userPath: string): string => contextLogicalPath(userPath);
    const tracked = (rel: string) => isManagedVcsPath(bridge, rel);
    // Author one workspace-wide edit on the exact working state.
    const commit = (edits: FsVcsEditOp[]) => {
      requireManagedCause();
      return this.commitRoutedEdits(
        bridge,
        router,
        contextId,
        commandId,
        edits,
        causalParent,
        mutationIntegrity()
      );
    };
    const importFile = async (sourceRel: string, destinationRel: string) => {
      requireManagedCause();
      const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
      const destinationRoute = router.route(destinationRel);
      router.assertWritable(destinationRel);
      const destinationRepository = managedRepository(snapshot, destinationRoute.repoPath);
      const existing = await managedFile(
        bridge,
        snapshot,
        destinationRepository.repositoryId,
        destinationRoute.repoRelPath
      );
      if (existing) {
        throw codedError("EEXIST", `copyFile: managed destination exists: ${destinationRel}`);
      }
      const snapshotRead = (await this.callDisk(ctx, scope, "snapshot", [sourceRel])) as {
        buffer: BinaryEnvelope;
        mode: number;
      };
      const bytes = Buffer.from(snapshotRead.buffer.data, "base64");
      const sourceStat = { mode: snapshotRead.mode };
      await bridge.edit(
        {
          commandId,
          contextId,
          expectedWorkingHead: snapshot.state,
          intentSummary: `Import ${sourceRel} to ${destinationRel}`,
          changes: [
            {
              kind: "file-create",
              repositoryId: destinationRepository.repositoryId,
              path: destinationRoute.repoRelPath,
              content: { kind: "bytes", base64: bytes.toString("base64") },
              mode: isExecutableMode(sourceStat.mode) ? 0o755 : 0o644,
            },
          ],
        },
        causalParent,
        {
          class: "external",
          externalKeys: [
            ...new Set([...mutationIntegrity().externalKeys, `session:native-fs:${contextId}`]),
          ],
        }
      );
    };
    const readWsFile = async (
      wsRel: string,
      exposeToCaller = false
    ): Promise<FsVcsContent | null> => {
      const { workingHead: state } = await bridge.status({ contextId });
      const routed = router.route(wsRel);
      const repository = await bridge.resolveRepository({
        state,
        repoPath: routed.repoPath,
      });
      if (!repository) return null;
      const result = await bridge.readFile({
        state,
        repositoryId: repository.repositoryId,
        file: { kind: "path", path: routed.repoRelPath },
      });
      if (result && exposeToCaller && this.recordContextIngestion && ctx.caller.agentBinding) {
        await this.recordProjectedIngestion(
          ctx,
          "fs-read-file",
          ingestionDescriptorsForVcsRead(result)
        );
      }
      return result?.content ?? null;
    };

    switch (method) {
      case "readdir": {
        const opts = args[1] as { withFileTypes?: boolean; recursive?: boolean } | undefined;
        if (opts?.recursive) return { handled: false };
        const rel = contextLogicalPath(args[0] as string, { directory: true }).replace(/\/+$/u, "");
        if (rel !== "" && scopeForPath(rel) === null) return { handled: false };
        const { workingHead: state } = await bridge.status({ contextId });
        const entries: NonNullable<VcsListDirectoryResult>["entries"] = [];
        let cursor: string | undefined;
        do {
          const page = await bridge.listDirectory({
            state,
            path: rel,
            limit: 500,
            ...(cursor ? { cursor } : {}),
          });
          if (!page) {
            throw codedError("ENOENT", `readdir: managed directory not found: ${String(args[0])}`);
          }
          entries.push(...page.entries);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        await this.recordProjectedIngestion(
          ctx,
          "fs-readdir",
          ingestionDescriptorsForVisibleEntries(entries)
        );
        const scratchEntries =
          rel === ""
            ? (
                (await this.callDisk(ctx, scope, "readdir", [
                  "/",
                  { withFileTypes: true },
                ])) as Array<{
                  name: string;
                  _isFile: boolean;
                  _isDirectory: boolean;
                  _isSymbolicLink: boolean;
                }>
              ).filter(
                (entry) =>
                  !WORKSPACE_SOURCE_ROOTS.has(entry.name) &&
                  !INTERNAL_PROJECTION_ENTRIES.has(entry.name)
              )
            : [];
        const visibleNames = new Set(entries.map((entry) => entry.name));
        const orderedScratch = scratchEntries
          .filter((entry) => !visibleNames.has(entry.name))
          .sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
        return {
          handled: true,
          result: opts?.withFileTypes
            ? [
                ...entries.map((entry) => ({
                  name: entry.name,
                  _isFile: entry.kind === "file",
                  _isDirectory: entry.kind === "directory",
                  _isSymbolicLink: false,
                })),
                ...orderedScratch,
              ]
            : [...entries.map((entry) => entry.name), ...orderedScratch.map((entry) => entry.name)],
        };
      }
      case "readFile": {
        const userPath = args[0] as string;
        const rel = await relOf(userPath);
        if (!(await tracked(rel))) return { handled: false };
        const content = await readWsFile(rel, true);
        if (!content) {
          throw codedError("ENOENT", `readFile: managed file not found: ${userPath}`);
        }
        const bytes = contentToBuffer(content);
        const encoding = requestedReadEncoding(args[1]);
        return {
          handled: true,
          result: encoding ? bytes.toString(encoding) : encodeBinary(bytes),
        };
      }
      case "readText": {
        const userPath = args[0] as string;
        const rel = await relOf(userPath);
        if (!(await tracked(rel))) return { handled: false };
        const content = await readWsFile(rel, true);
        if (!content) {
          throw codedError("ENOENT", `readText: managed file not found: ${userPath}`);
        }
        return {
          handled: true,
          result: readTextRangeFromBuffer(
            contentToBuffer(content),
            args[1] as ReadTextOptions | undefined
          ),
        };
      }
      case "readBytes": {
        const userPath = args[0] as string;
        const rel = await relOf(userPath);
        if (!(await tracked(rel))) return { handled: false };
        const content = await readWsFile(rel, true);
        if (!content) {
          throw codedError("ENOENT", `readBytes: managed file not found: ${userPath}`);
        }
        return {
          handled: true,
          result: readBytesRangeFromBuffer(
            contentToBuffer(content),
            args[1] as ReadBytesOptions | undefined
          ),
        };
      }
      case "writeFile": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "write", path: rel, content: dataToVcsContent(args[1]) }]);
        return { handled: true };
      }
      case "mkdir": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        requireManagedCause();
        throw codedError(
          "ENOTSUP",
          `fs.mkdir cannot create managed empty directory ${JSON.stringify(rel)}: ` +
            `semantic workspace state contains repositories and files, and parent directories ` +
            `are created implicitly when a file is authored`
        );
      }
      case "appendFile": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        const content = appendVcsContent(await readWsFile(rel), args[1]);
        await commit([{ kind: "write", path: rel, content }]);
        return { handled: true };
      }
      case "truncate": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        const content = truncateVcsContent(
          await readWsFile(rel),
          (args[1] as number | undefined) ?? 0
        );
        await commit([{ kind: "write", path: rel, content }]);
        return { handled: true };
      }
      case "chmod": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "chmod", path: rel, mode: args[1] as number }]);
        return { handled: true };
      }
      case "unlink": {
        const userPath = args[0] as string;
        const rel = await relOf(userPath);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "delete", path: rel }]);
        return { handled: true };
      }
      case "rmdir": {
        const userPath = args[0] as string;
        const rel = await relOf(userPath);
        if (!(await tracked(rel))) return { handled: false };
        const edits = await this.subtreeDeleteEdits(bridge, contextId, rel);
        if (!edits.length) throw codedError("ENOENT", `delete: target not found: ${rel}`);
        await commit(edits);
        return { handled: true };
      }
      case "rm": {
        const userPath = args[0] as string;
        const rel = await relOf(userPath);
        if (!(await tracked(rel))) return { handled: false };
        const recursive = !!(args[1] as { recursive?: boolean } | undefined)?.recursive;
        const force = !!(args[1] as { force?: boolean } | undefined)?.force;
        if (recursive) {
          const edits = await this.subtreeDeleteEdits(bridge, contextId, rel);
          if (!edits.length) {
            if (force) return { handled: true };
            throw codedError("ENOENT", `delete: target not found: ${rel}`);
          }
          await commit(edits);
          return { handled: true };
        }
        if (force && !(await readWsFile(rel))) {
          const prefix = `${rel}/`;
          const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
          const hasSubtree = (await managedWorkspaceFiles(bridge, snapshot)).some((file) =>
            `${file.repoPath}/${file.path}`.startsWith(prefix)
          );
          if (!hasSubtree) return { handled: true };
        }
        await commit([{ kind: "delete", path: rel }]);
        return { handled: true };
      }
      case "copyFile": {
        const dstRel = await relOf(args[1] as string);
        const srcRel = await relOf(args[0] as string);
        if (!(await tracked(dstRel))) {
          if (!(await tracked(srcRel))) return { handled: false };
          const content = await readWsFile(srcRel, true);
          if (!content) throw codedError("ENOENT", `copyFile: source not found: ${srcRel}`);
          await this.callDisk(ctx, scope, "writeFile", [
            dstRel,
            encodeBinary(contentToBuffer(content)),
          ]);
          return { handled: true };
        }
        if (await tracked(srcRel)) {
          const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
          const [sourceRoute, destinationRoute] = [router.route(srcRel), router.route(dstRel)];
          router.assertWritable(srcRel);
          router.assertWritable(dstRel);
          const sourceRepository = managedRepository(snapshot, sourceRoute.repoPath);
          const destinationRepository = managedRepository(snapshot, destinationRoute.repoPath);
          const source = await managedFile(
            bridge,
            snapshot,
            sourceRepository.repositoryId,
            sourceRoute.repoRelPath
          );
          if (!source) {
            throw codedError("ENOENT", `copyFile: source not found: ${String(args[0])}`);
          }
          requireManagedCause();
          await bridge.copy(
            {
              commandId,
              contextId,
              expectedWorkingHead: snapshot.state,
              intentSummary: `Copy ${srcRel} to ${dstRel}`,
              copies: [
                {
                  source: {
                    state: snapshot.state,
                    repositoryId: sourceRepository.repositoryId,
                    fileId: source.fileId,
                  },
                  destination: {
                    repositoryId: destinationRepository.repositoryId,
                    path: destinationRoute.repoRelPath,
                  },
                },
              ],
            },
            causalParent,
            mutationIntegrity()
          );
          return { handled: true };
        }
        await importFile(srcRel, dstRel);
        return { handled: true };
      }
      case "rename": {
        const srcPath = args[0] as string;
        const dstPath = args[1] as string;
        const srcRel = await relOf(srcPath);
        const dstRel = await relOf(dstPath);
        const srcTracked = await tracked(srcRel);
        const dstTracked = await tracked(dstRel);
        if (!srcTracked && !dstTracked) return { handled: false };
        if (srcTracked && dstTracked) {
          const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
          const prefix = `${srcRel}/`;
          const sourcePaths = (await managedWorkspaceFiles(bridge, snapshot))
            .map((candidate) => `${candidate.repoPath}/${candidate.path}`)
            .filter((candidate) => candidate === srcRel || candidate.startsWith(prefix));
          if (sourcePaths.length === 0) {
            throw codedError("ENOENT", `rename: source not found: ${String(args[0])}`);
          }
          const moves = await Promise.all(
            sourcePaths.map(async (sourcePath) => {
              router.assertWritable(sourcePath);
              const destinationPath =
                sourcePath === srcRel ? dstRel : `${dstRel}/${sourcePath.slice(prefix.length)}`;
              router.assertWritable(destinationPath);
              const sourceRoute = router.route(sourcePath);
              const destinationRoute = router.route(destinationPath);
              const sourceRepository = managedRepository(snapshot, sourceRoute.repoPath);
              const destinationRepository = managedRepository(snapshot, destinationRoute.repoPath);
              const source = await managedFile(
                bridge,
                snapshot,
                sourceRepository.repositoryId,
                sourceRoute.repoRelPath
              );
              if (!source) {
                throw codedError("ENOENT", `rename: source not found: ${sourcePath}`);
              }
              return {
                kind: "file" as const,
                repositoryId: sourceRepository.repositoryId,
                fileId: source.fileId,
                destinationRepositoryId: destinationRepository.repositoryId,
                destinationPath: destinationRoute.repoRelPath,
              };
            })
          );
          requireManagedCause();
          await bridge.move(
            {
              commandId,
              contextId,
              expectedWorkingHead: snapshot.state,
              intentSummary: `Move ${srcRel} to ${dstRel}`,
              moves,
            },
            causalParent,
            mutationIntegrity()
          );
          return { handled: true };
        }
        if (!srcTracked && dstTracked) {
          throw codedError(
            "EACCES",
            `fs.rename cannot infer managed replacement intent from scratch path ` +
              `${JSON.stringify(srcPath)}. Use fs.copyFile for a new external import, or submit ` +
              `an exact-baseline managed edit for an existing file identity.`
          );
        }
        // managed → scratch: moving source out of semantic state.
        throw new Error(
          `fs.rename of the managed path ${JSON.stringify(args[0])} to a scratch path is not ` +
            `supported. Source mutations must go through vcs.edit or the write tool.`
        );
      }
      case "open": {
        const flags = (args[1] as string | undefined) ?? "r";
        if (!/[wax+]/.test(flags)) return { handled: false };
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        throw new Error(
          `fs.open with write flags is not supported on the managed path ${JSON.stringify(args[0])}. ` +
            `Source edits must use the write/edit tool or vcs.edit.`
        );
      }
      default:
        // reads, mkdir, utimes, mktemp, handle* → direct disk
        return { handled: false };
    }
  }

  /**
   * Build the per-call repo router. Every context is a full logical workspace
   * branch; routing is purely by section taxonomy so any repo path, including a
   * brand-new repo with no `main` yet, resolves to its owning repo.
   */
  private buildRepoRouter(): RepoRouter {
    return {
      route: (wsRel) => {
        const split = splitRepoPath(wsRel);
        if (!split) {
          throw codedError(
            "EACCES",
            `vcs edit rejected: ${JSON.stringify(wsRel)} is not inside a workspace repo ` +
              `(edits must live under packages/<name>/..., panels/<name>/..., meta/..., etc.).`
          );
        }
        return split;
      },
      assertWritable: (wsRel) => {
        const split = splitRepoPath(wsRel);
        if (split === null) {
          throw codedError(
            "EACCES",
            `vcs edit rejected: ${JSON.stringify(wsRel)} is not inside a workspace repo ` +
              `(edits must live under packages/<name>/..., panels/<name>/..., meta/..., etc.).`
          );
        }
        if (!split.repoRelPath) {
          throw codedError(
            "EACCES",
            `vcs edit rejected: ${JSON.stringify(wsRel)} names a workspace repo root. ` +
              repoRootWriteHint(split.repoPath)
          );
        }
      },
    };
  }

  /** Resolve every path and optimistic guard at one state, then author one
   * workspace-wide edit transaction. Repository coordinates never divide the
   * work unit or create partial success. */
  private async commitRoutedEdits(
    bridge: FsVcsBridge,
    router: RepoRouter,
    contextId: string,
    commandId: string,
    edits: FsVcsEditOp[],
    causalParent: RpcCausalParent | null,
    contextIntegrity: FsVcsMutationIntegrity
  ): Promise<void> {
    if (edits.length === 0) return;
    const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
    const scoped = (
      await Promise.all(
        edits.map(async (requested) => {
          router.assertWritable(requested.path);
          const route = router.route(requested.path);
          const repository = managedRepository(snapshot, route.repoPath);
          const file = await managedFile(
            bridge,
            snapshot,
            repository.repositoryId,
            route.repoRelPath
          );
          if (requested.kind !== "write" && !file) {
            throw codedError("ENOENT", `${requested.kind}: target not found: ${requested.path}`);
          }
          if (requested.kind === "write") {
            if (!file) {
              return [
                {
                  kind: "file-create" as const,
                  repositoryId: repository.repositoryId,
                  path: route.repoRelPath,
                  content: requested.content,
                  mode:
                    requested.mode === undefined
                      ? 0o644
                      : isExecutableMode(requested.mode)
                        ? 0o755
                        : 0o644,
                },
              ];
            }
            const nextContent = requested.content;
            const contentChange =
              nextContent.kind === "bytes"
                ? {
                    kind: "binary-replace" as const,
                    repositoryId: repository.repositoryId,
                    fileId: file.fileId,
                    base64: nextContent.base64,
                  }
                : await (async () => {
                    const current = await bridge.readFile({
                      state: snapshot.state,
                      repositoryId: repository.repositoryId,
                      file: { kind: "id", fileId: file.fileId },
                    });
                    return current?.content.kind === "text"
                      ? {
                          kind: "text-edit" as const,
                          repositoryId: repository.repositoryId,
                          fileId: file.fileId,
                          edits: [
                            { start: 0, end: current.content.text.length, text: nextContent.text },
                          ],
                        }
                      : {
                          kind: "binary-replace" as const,
                          repositoryId: repository.repositoryId,
                          fileId: file.fileId,
                          base64: Buffer.from(nextContent.text, "utf8").toString("base64"),
                        };
                  })();
            return requested.mode === undefined
              ? [contentChange]
              : [
                  contentChange,
                  {
                    kind: "file-mode" as const,
                    repositoryId: repository.repositoryId,
                    fileId: file.fileId,
                    mode: isExecutableMode(requested.mode) ? 0o755 : 0o644,
                  },
                ];
          }
          if (requested.kind === "delete") {
            return [
              {
                kind: "file-delete" as const,
                repositoryId: repository.repositoryId,
                fileId: file!.fileId,
              },
            ];
          }
          return [
            {
              kind: "file-mode" as const,
              repositoryId: repository.repositoryId,
              fileId: file!.fileId,
              mode: isExecutableMode(requested.mode) ? 0o755 : 0o644,
            },
          ];
        })
      )
    ).flat();
    await bridge.edit(
      {
        commandId,
        contextId,
        expectedWorkingHead: snapshot.state,
        changes: scoped,
      },
      causalParent,
      contextIntegrity
    );
  }

  /** Delete ops for a path and (if it is a directory) its whole tracked subtree. */
  private async subtreeDeleteEdits(
    bridge: FsVcsBridge,
    contextId: string,
    rel: string
  ): Promise<FsVcsEditOp[]> {
    const prefix = `${rel}/`;
    const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
    const files = (await managedWorkspaceFiles(bridge, snapshot)).map(
      (file) => `${file.repoPath}/${file.path}`
    );
    return files
      .filter((p) => p === rel || p.startsWith(prefix))
      .map((p) => ({ kind: "delete" as const, path: p }));
  }

  /**
   * Before a disk-reading op runs, ensure the complete exact context projection
   * exists, retaining the narrowest repo scope as caller intent, then assert the
   * requested repository is present in that projection.
   *
   * A repo can legitimately stay unmaterialized after `ensureMaterialized` when
   * it simply does not exist (nothing to project) — e.g. a read of a path under
   * a repo that was never created. Every context may read any repo in its
   * full workspace branch, so an existing repo is always
   * materialized here; only a non-existent one stays absent. We therefore let the
   * underlying fs method run and produce its OWN natural result for a missing
   * path (`readFile`/`open`/`stat`→ENOENT, `exists`→false, `readdir`→ENOENT) —
   * the behavior callers already handle — rather than a bespoke `ENOMATERIALIZE`
   * that breaks them. A `warn` keeps the case observable for diagnosing a genuine
   * materialize failure (which would also surface here).
   */
  private async demandForReadMethod(
    bridge: FsVcsBridge,
    scope: FsCallScope,
    method: string,
    args: unknown[]
  ): Promise<void> {
    if (!scope.contextId) return;
    const p = readScopePath(method, args);
    if (p === null) return;
    const fileOrSearchMethod = method !== "readdir" && method !== "glob";
    const wsRel = (fileOrSearchMethod ? canonicalizeWorkspaceFilePath(p) : p).replace(/^\/+/, "");
    // Resolving the already-ready context root exposes no repository bytes.
    // Callers such as native file tools follow it with one explicit, narrowly
    // scoped ensureMaterialized request; treating this metadata lookup as an
    // all-repository read creates a redundant semantic round trip per tool.
    if (method === "realpath" && wsRel === "") return;
    const repos = scopeForPath(wsRel);
    if (repos === null) return;
    if (repos !== "all" && !(await bridge.isTracked(wsRel.replace(/\/+$/, "")))) {
      return;
    }
    const materializeStartedAt = Date.now();
    await bridge.ensureMaterialized(scope.contextId, repos);
    this.emitTelemetry({
      method,
      phase: "materialize",
      durationMs: Date.now() - materializeStartedAt,
      contextId: scope.contextId,
      materializationScope: repos === "all" ? "all" : repos.length,
    });
    const repo = taxonomyRepoForPath(wsRel.replace(/\/+$/, ""));
    if (repo && !(await bridge.isMaterialized(scope.contextId, repo))) {
      console.warn(
        `[fs] ${method} ${JSON.stringify(wsRel)} (repo ${repo}) is not materialized for ` +
          `context ${scope.contextId} after ensureMaterialized — the repo likely does not ` +
          `exist; the read falls through to its natural result (ENOENT / false / empty).`
      );
    }
  }

  // =========================================================================
  // Main dispatch handler
  // =========================================================================

  async handleCall(ctx: ServiceContext, method: string, rawArgs: unknown[]): Promise<unknown> {
    // Clone args so shift() in resolveContextRoot doesn't mutate the original
    const args = [...rawArgs];
    const scopeStartedAt = Date.now();
    const scope = await this.resolveContextRoot(ctx, args);
    this.emitTelemetry({
      method,
      phase: "scope",
      durationMs: Date.now() - scopeStartedAt,
      ...(scope.contextId ? { contextId: scope.contextId } : {}),
    });
    const { panelId } = scope;
    const bridge = this.semanticBridge(scope);
    this.assertScratchOnlyCall(scope, method, args);

    if (method === "nativeRoots") {
      if (!scope.exposeHostPaths)
        throw codedError("EACCES", "Native roots are available only to scoped native extensions");
      return { source: scope.sourceRoot, scratch: scope.root };
    }

    // Explicit projection request for consumers that read disk OUTSIDE fs.*
    // (for example, grep/find in an extension). The argument declares the
    // narrowest read intent while the authority still publishes one complete
    // context projection.
    if (method === "ensureMaterialized") {
      if (scope.contextId && bridge) {
        const arg = args[0];
        let repos: RepoPath[] | "all";
        if (arg === "all") {
          repos = "all";
        } else {
          const paths = Array.isArray(arg) ? arg.map(String) : [String(arg)];
          const set = new Set<RepoPath>();
          let any = false;
          for (const p of paths) {
            const s = scopeForPath(p.replace(/^\/+/, ""));
            if (s === null) continue;
            if (s === "all") any = true;
            else for (const r of s) set.add(r);
          }
          if (!any && set.size === 0) return undefined;
          repos = any ? "all" : [...set];
        }
        await bridge.ensureMaterialized(scope.contextId, repos);
      }
      return undefined;
    }

    // Sandboxed context mutations + single-file tracked reads commit/read through
    // Semantic edits are content-addressed and never mutate materialized bytes directly.
    const routed = await this.maybeRouteToVcs(bridge, scope, ctx, method, args);
    if (routed.handled) return routed.result;

    // Anything that falls through here reads the context folder ON DISK. Demand
    // the narrowest repo scope as read intent, ensure the one complete context
    // projection, then loudly assert the repository is present — surfacing any
    // authority/projection mismatch instead of a silent partial read.
    if (bridge) await this.demandForReadMethod(bridge, scope, method, args);

    if (method.startsWith("handle")) {
      const id = args[0] as number;
      if (method === "handleClose" && !this.openHandles.has(id)) return;
      const tracked = this.getTrackedHandle(id, panelId);
      args[0] = tracked.nativeId;
      if (method === "handleClose") {
        clearTimeout(tracked.timer);
        this.openHandles.delete(id);
      }
    }
    const target =
      method === "mktemp" || method.startsWith("handle")
        ? ".tmp"
        : method === "symlink"
          ? String(args[1])
          : (readScopePath(method, args) ?? (typeof args[0] === "string" ? args[0] : "/"));
    const logical = contextLogicalPath(target, {
      directory: ["readdir", "grep", "glob", "mkdir", "rmdir", "rm"].includes(method),
    });
    const source = requiresSemanticAuthority(logical);
    const mutating = [
      "writeFile",
      "appendFile",
      "mkdir",
      "rmdir",
      "rm",
      "unlink",
      "rename",
      "copyFile",
      "truncate",
      "chmod",
      "utimes",
      "symlink",
    ].includes(method);
    if (source && mutating)
      throw codedError(
        "EROFS",
        "Managed workspace projections cannot be modified through raw disk operations"
      );
    if (method === "realpath" && logical === "" && scope.exposeHostPaths)
      throw codedError(
        "ENOTSUP",
        "The workspace has separate source and scratch roots; use fs.nativeRoots"
      );
    const diskScope = { ...scope, root: source ? scope.sourceRoot : scope.root };
    if ((method === "grep" || method === "glob" || method === "readdir") && logical === "") {
      const results = await Promise.all(
        [scope.sourceRoot, scope.root].map((root) =>
          this.callDisk(ctx, { ...scope, root }, method, args)
        )
      );
      if (method === "readdir") {
        const nameOf = (entry: unknown): string =>
          typeof entry === "string" ? entry : (entry as { name: string }).name;
        return (results as unknown[][])
          .flatMap((entries, index) =>
            entries.filter((entry) => requiresSemanticAuthority(nameOf(entry)) === (index === 0))
          )
          .sort((left, right) => compareUtf16CodeUnits(nameOf(left), nameOf(right)));
      }
      if (method === "grep") {
        const [managed, scratch] = results as [GrepResult, GrepResult];
        const matches = [
          ...managed.matches.filter((match) => requiresSemanticAuthority(match.file)),
          ...scratch.matches.filter((match) => !requiresSemanticAuthority(match.file)),
        ];
        const options = args[1] as GrepOptions | undefined;
        const limit = Math.min(
          options?.maxMatches ?? 200,
          Math.max(1, Math.floor(10000 / (2 * Math.min(options?.contextLines ?? 0, 4999) + 1)))
        );
        return {
          matches: matches.slice(0, limit),
          matchCount: Math.min(matches.length, limit),
          truncated: managed.truncated || scratch.truncated || matches.length > limit,
        };
      }
      const [managed, scratch] = results as [GlobResult, GlobResult];
      const files = [
        ...managed.files.filter((file) => requiresSemanticAuthority(file)),
        ...scratch.files.filter((file) => !requiresSemanticAuthority(file)),
      ].sort(compareUtf16CodeUnits);
      const limit = (args[1] as GlobOptions | undefined)?.limit ?? 1000;
      const selected = files.slice(0, limit);
      const truncated = managed.truncated || scratch.truncated || files.length > limit;
      return { files: selected, truncated, ...(truncated ? { nextCursor: selected.at(-1) } : {}) };
    }
    const operationStartedAt = Date.now();
    let result: unknown;
    try {
      result = await this.callDisk(ctx, diskScope, method, args);
    } finally {
      this.emitTelemetry({
        method,
        phase: "operation",
        durationMs: Date.now() - operationStartedAt,
        ...(scope.contextId ? { contextId: scope.contextId } : {}),
      });
    }
    if (method === "open") {
      const nativeId = (result as { handleId: number }).handleId;
      if (!Number.isSafeInteger(nativeId) || nativeId < 1)
        throw new Error("Invalid native file handle");
      return { handleId: this.trackHandle(nativeId, diskScope) };
    }
    return result;
  }
}

function repoRootWriteHint(repoPath: string): string {
  const segments = repoPath.split("/");
  const leaf = segments.at(-1) ?? repoPath;
  if (segments.length >= 2 && /\.[^/.]+$/.test(leaf)) {
    const repoName = leaf.replace(/\.[^/.]+$/, "");
    const section = segments.slice(0, -1).join("/");
    return `Write a file inside a repo-shaped path instead, e.g. ${section}/${repoName}/${leaf}.`;
  }
  return `Write a file inside the repo instead, e.g. ${repoPath}/README.md.`;
}

// ---------------------------------------------------------------------------
// Convenience: top-level handler for dispatcher.register("fs", ...)
// ---------------------------------------------------------------------------

export function handleFsCall(
  fsService: FsService,
  ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  return fsService.handleCall(ctx, method, args);
}

export type {
  GrepOptions,
  GlobOptions,
  GrepMatch,
  GrepResult,
  GlobResult,
  ReadTextOptions,
  ReadTextResult,
  ReadBytesOptions,
  ReadBytesResult,
} from "./fsValues.js";
