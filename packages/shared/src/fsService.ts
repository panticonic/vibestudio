/**
 * fsService — Server-side filesystem handler for panel RPC calls.
 *
 * Registered in the Electron main process dispatcher (not SERVER_SERVICES),
 * so panel fs.* calls route through Electron IPC where panel context
 * is available. In headless mode, registered in the server process dispatcher.
 *
 * All operations are sandboxed to the caller's context folder via path
 * validation and symlink traversal checks.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { randomBytes } from "node:crypto";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { FileHandle as NodeFileHandle } from "fs/promises";
import type { ServiceContext } from "./serviceDispatcher.js";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type { ContextFolderManager } from "./contextFolderManager.js";
import { createDevLogger } from "@vibestudio/dev-log";
import { EntityCache } from "./runtime/entityCache.js";
import {
  canonicalizeWorkspaceFilePath,
  CONTAINER_SECTIONS,
  splitRepoPath,
  taxonomyRepoForPath,
  type RepoPath,
} from "./runtime/entitySpec.js";
import { WORKSPACE_SOURCE_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";
import type {
  VcsCopyInput,
  VcsEditInput,
  VcsInspectInput,
  VcsInspectResult,
  VcsListFilesInput,
  VcsListFilesResult,
  VcsMoveInput,
  VcsNeighborsInput,
  VcsNeighborsResult,
  VcsReadFileInput,
  VcsReadFileResult,
  VcsStateNodeRef,
  VcsStatusInput,
  VcsStatusResult,
  VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";

const log = createDevLogger("FsService");
const WORKSPACE_SOURCE_ROOTS = new Set<string>(WORKSPACE_SOURCE_DIRS);
const CANONICAL_SOURCE_ROOT_BY_LOWER = new Map(
  WORKSPACE_SOURCE_DIRS.map((sourceRoot) => [sourceRoot.toLowerCase(), sourceRoot])
);

/** Idle timeout for open file handles (5 minutes). */
const HANDLE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Tracked file handle with cleanup metadata. */
interface TrackedHandle {
  handle: NodeFileHandle;
  panelId: string;
  timer: ReturnType<typeof setTimeout>;
  /** Exact semantic file versions whose bytes this handle can reveal. */
  ingestion: ContextIngestionDescriptor[];
  ingestionRecorded: boolean;
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

function ingestionDescriptorsForDirectoryListing(
  files: readonly (ManagedWorkspaceRepository & VcsListFilesResult["files"][number])[]
): ContextIngestionDescriptor[] {
  const descriptors = new Map<string, ContextIngestionDescriptor>();
  for (const file of files) {
    for (const descriptor of ingestionDescriptorsForVcsRead(file)) {
      retainStrongestIngestionDescriptor(descriptors, descriptor);
    }
  }
  return [...descriptors.values()];
}

interface FsCallScope {
  root: string;
  panelId: string;
  contextId?: string;
  unrestricted: boolean;
  exposeHostPaths: boolean;
}

interface ResolvedFsPath {
  path: string;
}

type SandboxLeafMode = "follow" | "entry" | "allow-dangling";

interface ResolveFsPathOptions {
  /**
   * `follow` validates the leaf target like every parent. `entry` validates
   * only parents for operations that act on the directory entry itself.
   * `allow-dangling` is the read-only `exists` variant: an unresolved leaf is
   * allowed through so fs.access can return false naturally.
   */
  leafMode?: SandboxLeafMode;
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
  const READ_PATH_METHODS = new Set([
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "exists",
    "access",
    "open",
    "createReadStream",
    "copyFile", // src = args[0]
  ]);
  if (READ_PATH_METHODS.has(method)) {
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
  const PATH_METHODS = new Set([
    "readFile",
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
  return PATH_METHODS.has(method) && typeof args[0] === "string" ? [args[0]] : [];
}

function requiresSemanticAuthority(userPath: string): boolean {
  const normalized = userPath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized === "" || normalized === ".") return true;
  const sourceRoot = normalized.split("/", 1)[0] ?? "";
  return CANONICAL_SOURCE_ROOT_BY_LOWER.has(sourceRoot.toLowerCase());
}

// ---------------------------------------------------------------------------
// Path sandboxing
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path within a sandbox root, preventing traversal
 * and symlink-based escapes.
 */
async function sandboxPath(
  root: string,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<ResolvedFsPath> {
  const leafMode = options.leafMode ?? "follow";
  const relative = userPath.startsWith("/") ? userPath.slice(1) : userPath;
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Path traversal detected");
  }
  const realRoot = await fs.realpath(root);
  // Walk path components and check for symlinks in parents.
  let current = root;
  const relativePath = path.relative(root, resolved);
  const segments = relativePath ? relativePath.split(path.sep) : [];
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let st: fsSync.Stats;
    try {
      st = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break; // remainder doesn't exist yet
      throw error;
    }
    if (st.isSymbolicLink()) {
      const isLeaf = index === segments.length - 1;
      if (isLeaf && leafMode === "entry") continue;
      let target: string;
      try {
        target = await fs.realpath(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (isLeaf && leafMode === "allow-dangling") continue;
          // A dangling link can point outside the context and become writable
          // later; without a real target there is no safe containment proof.
          throw new Error("Dangling symlink is not allowed in sandbox paths");
        }
        throw error;
      }
      if (!target.startsWith(realRoot + path.sep) && target !== realRoot) {
        throw new Error("Symlink escapes sandbox");
      }
    }
  }
  return { path: resolved };
}

async function resolveFsPathInfo(
  scope: FsCallScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<ResolvedFsPath> {
  if (!scope.unrestricted) {
    return sandboxPath(scope.root, userPath, options);
  }
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  return { path: path.resolve(userPath) };
}

async function resolveFsPath(
  scope: FsCallScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<string> {
  return (await resolveFsPathInfo(scope, userPath, options)).path;
}

/** Resolve a file-oriented path through the workspace's canonical shorthand.
 * Directory-oriented operations deliberately continue to use resolveFsPath:
 * a dotted repo id can still be addressed as a directory, while a file call
 * such as `projects/report.md` consistently addresses
 * `projects/report/report.md` across fs, vcs, and agent tools. */
async function resolveFsFilePathInfo(
  scope: FsCallScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<ResolvedFsPath> {
  return resolveFsPathInfo(
    scope,
    scope.unrestricted ? userPath : canonicalizeWorkspaceFilePath(userPath),
    options
  );
}

async function resolveFsFilePath(
  scope: FsCallScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<string> {
  return (await resolveFsFilePathInfo(scope, userPath, options)).path;
}

/**
 * Return the caller-visible path after resolving any existing in-sandbox
 * symlink/case aliases. The target file may not exist yet, so resolve the
 * nearest existing ancestor and append the missing suffix. Mutation routing
 * must classify this canonical path; otherwise an alias such as `alias/lib/x`
 * → `packages/lib/x` could be mistaken for scratch and written behind semantic state.
 */
async function canonicalContextRelativePath(
  scope: FsCallScope,
  userPath: string,
  options: { preserveLeaf?: boolean } = {}
): Promise<string> {
  const preserveLeaf = options.preserveLeaf ?? false;
  const resolved = await resolveFsFilePath(scope, userPath, {
    leafMode: preserveLeaf ? "entry" : "follow",
  });
  if (scope.unrestricted) return resolved;

  const realRoot = await fs.realpath(scope.root);
  let probe = preserveLeaf && resolved !== scope.root ? path.dirname(resolved) : resolved;
  const missingSegments: string[] =
    preserveLeaf && resolved !== scope.root ? [path.basename(resolved)] : [];

  while (true) {
    try {
      const realAncestor = await fs.realpath(probe);
      const canonical = path.resolve(realAncestor, ...missingSegments);
      if (!canonical.startsWith(realRoot + path.sep) && canonical !== realRoot) {
        throw new Error("Canonical path escapes sandbox");
      }
      return path.relative(realRoot, canonical).split(path.sep).join("/");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      if (probe === scope.root) throw error;
      missingSegments.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
}

/** Test the caller-visible leaf without following it. Parents remain fully
 * sandbox-validated, so this is safe for deciding whether an operation acts on
 * a disk-only symlink directory entry. */
async function isLeafSymlink(scope: FsCallScope, userPath: string): Promise<boolean> {
  const resolved = await resolveFsFilePath(scope, userPath, { leafMode: "entry" });
  try {
    return (await fs.lstat(resolved)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureDirectWriteParent(scope: FsCallScope, absolutePath: string): Promise<void> {
  if (scope.unrestricted || absolutePath === scope.root) return;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// Binary data encoding helpers (JSON RPC can't transport Uint8Array)
// ---------------------------------------------------------------------------

interface BinaryEnvelope {
  __bin: true;
  data: string; // base64
}

function isBinaryEnvelope(v: unknown): v is BinaryEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any).__bin === true &&
    typeof (v as any).data === "string"
  );
}

function encodeBinary(buf: Buffer): BinaryEnvelope {
  return { __bin: true, data: buf.toString("base64") };
}

function decodeBinary(envelope: BinaryEnvelope): Buffer {
  return Buffer.from(envelope.data, "base64");
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
 * Scratch/ignored paths (`.tmp`, `.testkit`, `node_modules`, `*.log`, …) are
 * not tracked and stay direct disk writes.
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
  ): Promise<VcsWorkingMutationResult>;
  move(
    input: VcsMoveInput,
    causalParent: RpcCausalParent | null,
    contextIntegrity: FsVcsMutationIntegrity
  ): Promise<VcsWorkingMutationResult>;
  copy(
    input: VcsCopyInput,
    causalParent: RpcCausalParent | null,
    contextIntegrity: FsVcsMutationIntegrity
  ): Promise<VcsWorkingMutationResult>;
  status(input: VcsStatusInput): Promise<VcsStatusResult>;
  inspect(input: VcsInspectInput): Promise<VcsInspectResult>;
  neighbors(input: VcsNeighborsInput): Promise<VcsNeighborsResult>;
  readFile(input: VcsReadFileInput): Promise<VcsReadFileResult>;
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

function sameStateNode(left: VcsStateNodeRef, right: VcsStateNodeRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "event"
      ? right.kind === "event" && left.eventId === right.eventId
      : right.kind === "application" && left.applicationId === right.applicationId)
  );
}

/** Resolve a context through the public graph instead of a second revision API. */
async function managedWorkspaceSnapshot(
  bridge: FsVcsBridge,
  contextId: string
): Promise<ManagedWorkspaceSnapshot> {
  const { workingHead: state } = await bridge.status({ contextId });
  const repositoryRefs = new Map<
    string,
    Extract<VcsNeighborsResult["edges"][number]["to"], { kind: "repository" }>
  >();
  let cursor: string | undefined;
  do {
    const page = await bridge.neighbors({
      root: state,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const edge of page.edges) {
      for (const node of [edge.from, edge.to]) {
        if (node.kind === "repository" && sameStateNode(node.state, state)) {
          repositoryRefs.set(node.repositoryId, node);
        }
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const repositories = (
    await mapWithBoundedConcurrency(
      [...repositoryRefs.values()],
      SEMANTIC_READ_CONCURRENCY,
      async (ref): Promise<ManagedWorkspaceRepository | null> => {
        const inspected = await bridge.inspect({ node: ref, edgeLimit: 1 });
        if (inspected.node.kind !== "repository" || inspected.node.value.kind !== "present") {
          return null;
        }
        return {
          repositoryId: ref.repositoryId,
          repoPath: inspected.node.value.repoPath as RepoPath,
        };
      }
    )
  ).filter((repository): repository is ManagedWorkspaceRepository => repository !== null);
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
      const file = await managedFile(
        bridge,
        snapshot,
        candidate.repositoryId,
        candidate.path
      );
      return file ? { ...candidate, ...file } : null;
    }
  );
  return files.filter(
    (
      file
    ): file is ManagedWorkspaceRepository & VcsListFilesResult["files"][number] => file !== null
  );
}

async function managedWorkspaceFilesForPaths(
  bridge: FsVcsBridge,
  snapshot: ManagedWorkspaceSnapshot,
  workspacePaths: ReadonlySet<string>
): Promise<Array<ManagedWorkspaceRepository & VcsListFilesResult["files"][number]>> {
  const files = new Map<string, ManagedWorkspaceRepository & VcsListFilesResult["files"][number]>();
  for (const repository of snapshot.repositories) {
    const prefixes = new Set<string>();
    for (const workspacePath of workspacePaths) {
      if (
        workspacePath === repository.repoPath ||
        repository.repoPath.startsWith(`${workspacePath}/`)
      ) {
        prefixes.clear();
        prefixes.add("");
        break;
      }
      if (workspacePath.startsWith(`${repository.repoPath}/`)) {
        prefixes.add(workspacePath.slice(repository.repoPath.length + 1));
      }
    }
    if (prefixes.size === 0) continue;

    for (const prefix of prefixes) {
      let cursor: string | undefined;
      do {
        const page = await bridge.listFiles({
          state: snapshot.state,
          repositoryId: repository.repositoryId,
          ...(prefix ? { prefix } : {}),
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        for (const file of page.files) {
          files.set(`${repository.repositoryId}\u0000${file.fileId}`, {
            ...repository,
            ...file,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
  }
  return [...files.values()];
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

export interface FsServiceOptions {
  contextAuthority: FsContextAuthority;
  hostFsCapableExtensions?: Iterable<string>;
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
async function isManagedVcsPath(bridge: FsVcsBridge, wsRel: string): Promise<boolean> {
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
    return bridge.isTracked(wsRel);
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

function serializeStat(stats: fsSync.Stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    ctime: stats.ctime.toISOString(),
    mode: stats.mode,
  };
}

function serializeDirent(d: fsSync.Dirent, name: string = d.name) {
  return {
    name,
    _isFile: d.isFile(),
    _isDirectory: d.isDirectory(),
    _isSymbolicLink: d.isSymbolicLink(),
  };
}

/** Path of a (possibly nested) Dirent relative to the listed directory. */
function relativeDirentName(listedDir: string, d: fsSync.Dirent): string {
  return path.relative(listedDir, path.join(d.parentPath, d.name)).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// grep / glob
// ---------------------------------------------------------------------------

/** Directories never descended into by grep/glob. */
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);

const GREP_DEFAULT_MAX_MATCHES = 200;
const GREP_HARD_MAX_MATCHES = 1000;
const GREP_MAX_CONTEXT_LINES = 10;

export interface GrepOptions {
  /** Directory (or single file) to search, relative to the context root. */
  path?: string;
  /** Glob filter for candidate files (gitignore-style; basename match when slash-free). */
  glob?: string;
  caseInsensitive?: boolean;
  /** Lines of context before/after each match (clamped to 10). */
  contextLines?: number;
  /** Stop after this many matches (default 200, hard cap 1000). */
  maxMatches?: number;
}

export interface GlobOptions {
  /** Directory to search, relative to the context root. */
  path?: string;
}

export interface GrepMatch {
  file: string;
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  matchCount: number;
  truncated: boolean;
}

interface RawGrepMatch {
  /** Absolute file path. */
  file: string;
  lineNumber: number;
  line: string;
}

let cachedRipgrepPath: string | null | undefined;

/** Locate `rg` on PATH (cached). Exported test hook: `_resetRipgrepCache`. */
function findRipgrep(): string | null {
  if (cachedRipgrepPath !== undefined) return cachedRipgrepPath;
  const names = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        if (fsSync.statSync(candidate).isFile()) {
          cachedRipgrepPath = candidate;
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  }
  cachedRipgrepPath = null;
  return null;
}

/** Test hook: force re-detection of ripgrep (and optionally disable it). */
export function _setRipgrepPathForTests(value: string | null | undefined): void {
  cachedRipgrepPath = value;
}

/**
 * Convert a glob pattern to a RegExp source string. Supports `*`, `**`, `?`,
 * `[...]` character classes, and `{a,b}` alternation.
 */
function globSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        i += 1;
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls}]`;
        i = end + 1;
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        i += 1;
      } else {
        const parts = glob.slice(i + 1, end).split(",");
        out += `(?:${parts.map(globSource).join("|")})`;
        i = end + 1;
      }
    } else {
      out += c.replace(/[.+^$()|\\\]}]/g, "\\$&");
      i += 1;
    }
  }
  return out;
}

/**
 * Match a slash-separated relative path against a glob pattern. Patterns
 * without a slash match against the basename (gitignore convention).
 */
function matchesGlob(relPath: string, pattern: string): boolean {
  const subject = pattern.includes("/") ? relPath : path.posix.basename(relPath);
  return new RegExp(`^${globSource(pattern)}$`).test(subject);
}

/** Recursively yield files under `dir`, skipping VCS/deps dirs and symlinks. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(abs);
    } else if (entry.isFile()) {
      yield abs;
    }
    // Symlinks (and other special entries) are intentionally skipped: they
    // could point outside the sandbox.
  }
}

/** Heuristic binary check: NUL byte in the first 8 KiB. */
async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Run ripgrep and collect up to `limit` raw matches. */
async function grepWithRipgrep(
  rgPath: string,
  searchRoot: string,
  pattern: string,
  opts: { caseInsensitive: boolean; glob?: string },
  limit: number
): Promise<{ raw: RawGrepMatch[]; truncated: boolean }> {
  const { spawn } = await import("node:child_process");
  const rgArgs = [
    "--json",
    "--no-ignore",
    "--hidden",
    "--no-messages",
    "--glob",
    "!**/.git/**",
    "--glob",
    "!**/node_modules/**",
  ];
  if (opts.caseInsensitive) rgArgs.push("--ignore-case");
  if (opts.glob) rgArgs.push("--glob", opts.glob);
  rgArgs.push("--regexp", pattern, "--", searchRoot);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(rgPath, rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const raw: RawGrepMatch[] = [];
    let truncated = false;
    let stderr = "";
    let buffered = "";
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) rejectPromise(err);
      else resolvePromise({ raw, truncated });
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "match") continue;
        const file = event.data?.path?.text;
        const text = event.data?.lines?.text;
        const lineNumber = event.data?.line_number;
        // Skip non-UTF8 payloads (rg reports them as base64 `bytes`).
        if (typeof file !== "string" || typeof text !== "string") continue;
        if (typeof lineNumber !== "number") continue;
        if (raw.length >= limit) {
          truncated = true;
          child.kill();
          finish();
          return;
        }
        raw.push({ file, lineNumber, line: text.replace(/\r?\n$/, "") });
      }
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      // rg exits 0 on matches, 1 on no matches, 2 on error.
      if (!truncated && code !== null && code > 1) {
        finish(new Error(`ripgrep failed: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      finish();
    });
  });
}

/** Pure-JS streaming grep fallback (no ripgrep on PATH). */
async function grepWithJs(
  searchRoot: string,
  regex: RegExp,
  globFilter: string | undefined,
  limit: number
): Promise<{ raw: RawGrepMatch[]; truncated: boolean }> {
  const { createInterface } = await import("node:readline");
  const raw: RawGrepMatch[] = [];
  let truncated = false;

  const rootStat = await fs.stat(searchRoot);
  const files = rootStat.isFile() ? singleton(searchRoot) : walkFiles(searchRoot);

  outer: for await (const file of files) {
    if (globFilter) {
      const rel =
        searchRoot === file
          ? path.basename(file)
          : path.relative(searchRoot, file).split(path.sep).join("/");
      if (!matchesGlob(rel, globFilter)) continue;
    }
    try {
      if (await isBinaryFile(file)) continue;
    } catch {
      continue;
    }
    const stream = fsSync.createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of rl) {
        lineNumber += 1;
        if (!regex.test(line)) continue;
        if (raw.length >= limit) {
          truncated = true;
          break outer;
        }
        raw.push({ file, lineNumber, line });
      }
    } catch {
      // Unreadable file mid-stream: skip the rest of it.
    } finally {
      rl.close();
      stream.destroy();
    }
  }
  return { raw, truncated };
}

async function* singleton<T>(value: T): AsyncGenerator<T> {
  yield value;
}

// ---------------------------------------------------------------------------
// FsService class
// ---------------------------------------------------------------------------

export class FsService {
  private readonly contextFolderManager: ContextFolderManager;
  private readonly entityCache: EntityCache;
  /** Extensions granted explicit unrestricted host-fs access (Phase 3 capability). */
  private readonly hostFsCapableExtensions?: ReadonlySet<string>;
  /** Explicit semantic-workspace or scratch-only construction authority. */
  private readonly contextAuthority: FsContextAuthority;
  private readonly recordContextIngestion?: FsServiceOptions["recordContextIngestion"];
  private readonly recordContextIngestionBatch?: FsServiceOptions["recordContextIngestionBatch"];

  /** handleId → TrackedHandle */
  private readonly openHandles = new Map<number, TrackedHandle>();
  private nextHandleId = 1;

  constructor(
    contextFolderManager: ContextFolderManager,
    entityCache: EntityCache,
    opts: FsServiceOptions
  ) {
    this.contextFolderManager = contextFolderManager;
    this.entityCache = entityCache;
    this.hostFsCapableExtensions = opts.hostFsCapableExtensions
      ? new Set(opts.hostFsCapableExtensions)
      : undefined;
    this.contextAuthority = opts.contextAuthority;
    this.recordContextIngestion = opts.recordContextIngestion;
    this.recordContextIngestionBatch = opts.recordContextIngestionBatch;
  }

  private semanticBridge(scope: FsCallScope): FsVcsBridge | null {
    if (scope.unrestricted || !scope.contextId) return null;
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
    options: { explicitContextId: string } | undefined = undefined
  ): Promise<Array<{ path: string; content: string }>> {
    if (
      patterns.length === 0 ||
      patterns.some((pattern) => typeof pattern !== "string" || pattern.length === 0)
    ) {
      throw new Error("Managed file reads require non-empty glob patterns");
    }
    const scope = await this.resolveContextRoot(
      ctx,
      options ? [options.explicitContextId] : []
    );
    const bridge = this.semanticBridge(scope);
    if (!bridge || !scope.contextId) {
      throw codedError(
        "ESEMANTICAUTHORITY",
        "Managed file reads require an exact semantic workspace context"
      );
    }
    const snapshot = await managedWorkspaceSnapshot(bridge, scope.contextId);
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
    if (scope.unrestricted || !scope.contextId || this.contextAuthority.kind !== "scratch-only") {
      return;
    }
    const managedPath = authorityPathsForCall(method, args).find(requiresSemanticAuthority);
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

  private _closeHandlesImpl(callerId: string): void {
    for (const [id, tracked] of this.openHandles) {
      if (tracked.panelId === callerId) {
        clearTimeout(tracked.timer);
        tracked.handle.close().catch(() => {});
        this.openHandles.delete(id);
      }
    }
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
   * - extension callers outside an invocation: unrestricted host fs
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
          root,
          panelId,
          contextId,
          unrestricted: false,
          exposeHostPaths: true,
        };
      }
      // Phase 3: an extension acting on its own behalf (no chainCaller) used to
      // SILENTLY get unrestricted host filesystem access — conflating two trust
      // models and escalating privilege without any signal. Host-fs authority is
      // now an explicit, named capability an extension must hold; otherwise the
      // call fails loud rather than reading `/`.
      if (this.extensionHasHostFsCapability(ctx.caller.runtime.id)) {
        return {
          root: "",
          panelId: `extension:${ctx.caller.runtime.id}`,
          unrestricted: true,
          exposeHostPaths: true,
        };
      }
      throw new Error(
        `Extension ${ctx.caller.runtime.id} attempted a filesystem call outside an ` +
          `on-behalf-of context and without the host-fs-access capability`
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
      root,
      panelId,
      contextId,
      unrestricted: false,
      exposeHostPaths: false,
    };
  }

  /**
   * Whether an extension holds the explicit `host-fs-access` capability that
   * grants unrestricted host filesystem access when acting on its own behalf
   * (no on-behalf-of context). This is a *distinct* grant from native-code
   * install approval — being native does not imply host-fs authority. The
   * allowlist is injected via deps (`hostFsCapableExtensions`); empty by default,
   * so the privileged path is opt-in rather than a silent fallback.
   */
  private extensionHasHostFsCapability(extensionId: string): boolean {
    return this.hostFsCapableExtensions?.has(extensionId) ?? false;
  }

  // =========================================================================
  // FileHandle helpers
  // =========================================================================

  private trackHandle(
    handle: NodeFileHandle,
    panelId: string,
    ingestion: ContextIngestionDescriptor[] = []
  ): number {
    const id = this.nextHandleId++;
    const timer = setTimeout(() => {
      log.info(`Closing idle file handle ${id} for ${panelId}`);
      handle.close().catch(() => {});
      this.openHandles.delete(id);
    }, HANDLE_IDLE_TIMEOUT_MS);
    this.openHandles.set(id, { handle, panelId, timer, ingestion, ingestionRecorded: false });
    return id;
  }

  private getTrackedHandle(handleId: number, callerPanelId: string): TrackedHandle {
    const tracked = this.openHandles.get(handleId);
    if (!tracked) throw new Error(`Invalid file handle: ${handleId}`);
    if (tracked.panelId !== callerPanelId) {
      throw new Error(`File handle ${handleId} does not belong to caller`);
    }
    // Reset idle timer
    clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => {
      tracked.handle.close().catch(() => {});
      this.openHandles.delete(handleId);
    }, HANDLE_IDLE_TIMEOUT_MS);
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
  private async ingestionForProjectedPaths(
    bridge: FsVcsBridge | null,
    scope: FsCallScope,
    ctx: ServiceContext,
    absolutePaths: readonly string[]
  ): Promise<ContextIngestionDescriptor[]> {
    if (
      !bridge ||
      scope.unrestricted ||
      !scope.contextId ||
      !ctx.caller.agentBinding ||
      !this.recordContextIngestion ||
      absolutePaths.length === 0
    ) {
      return [];
    }

    const exposed = new Set(
      absolutePaths.flatMap((absolutePath) => {
        const relative = path.relative(scope.root, absolutePath).split(path.sep).join("/");
        return relative === "" || relative === "." || relative.startsWith("../") ? [] : [relative];
      })
    );
    if (exposed.size === 0) return [];

    const snapshot = await managedWorkspaceSnapshot(bridge, scope.contextId);
    const files = await managedWorkspaceFilesForPaths(bridge, snapshot, exposed);
    const selected = files
      .filter((file) => {
        const workspacePath = `${file.repoPath}/${file.path}`;
        for (const exposedPath of exposed) {
          if (workspacePath === exposedPath || workspacePath.startsWith(`${exposedPath}/`)) {
            return true;
          }
        }
        return false;
      })
      .sort((a, b) => compareUtf16CodeUnits(`${a.repoPath}/${a.path}`, `${b.repoPath}/${b.path}`));

    return ingestionDescriptorsForDirectoryListing(selected);
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
   * Scratch/ignored paths and host-fs/unrestricted callers deliberately retain
   * the direct-disk implementation.
   */
  private async maybeRouteToVcs(
    bridge: FsVcsBridge | null,
    scope: FsCallScope,
    ctx: ServiceContext,
    method: string,
    args: unknown[]
  ): Promise<{ handled: boolean; result?: unknown }> {
    if (!bridge || scope.unrestricted || !scope.contextId) return { handled: false };
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

    const relOf = (userPath: string, options: { preserveLeaf?: boolean } = {}): Promise<string> =>
      canonicalContextRelativePath(scope, userPath, options);
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
    const importFile = async (sourceRel: string, sourceAbs: string, destinationRel: string) => {
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
      const [bytes, sourceStat] = await Promise.all([fs.readFile(sourceAbs), fs.stat(sourceAbs)]);
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
        mutationIntegrity()
      );
    };
    const readWsFile = async (
      wsRel: string,
      exposeToCaller = false
    ): Promise<FsVcsContent | null> => {
      const snapshot = await managedWorkspaceSnapshot(bridge, contextId);
      const routed = router.route(wsRel);
      const repository = managedRepository(snapshot, routed.repoPath);
      const result = await bridge.readFile({
        state: snapshot.state,
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
      case "writeFile": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "write", path: rel, content: dataToVcsContent(args[1]) }]);
        return { handled: true };
      }
      case "mkdir": {
        const rel = await relOf(args[0] as string, { preserveLeaf: true });
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
        if (await isLeafSymlink(scope, userPath)) return { handled: false };
        const rel = await relOf(userPath, { preserveLeaf: true });
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "delete", path: rel }]);
        return { handled: true };
      }
      case "rmdir": {
        const userPath = args[0] as string;
        if (await isLeafSymlink(scope, userPath)) return { handled: false };
        const rel = await relOf(userPath, { preserveLeaf: true });
        if (!(await tracked(rel))) return { handled: false };
        await commit(await this.subtreeDeleteEdits(bridge, contextId, rel));
        return { handled: true };
      }
      case "rm": {
        const userPath = args[0] as string;
        if (await isLeafSymlink(scope, userPath)) return { handled: false };
        const rel = await relOf(userPath, { preserveLeaf: true });
        if (!(await tracked(rel))) return { handled: false };
        const recursive = !!(args[1] as { recursive?: boolean } | undefined)?.recursive;
        const force = !!(args[1] as { force?: boolean } | undefined)?.force;
        if (recursive) {
          const edits = await this.subtreeDeleteEdits(bridge, contextId, rel);
          if (force && edits.length === 0) return { handled: true };
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
        if (!(await tracked(dstRel))) return { handled: false };
        const srcRel = await relOf(args[0] as string);
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
        const srcAbs = await resolveFsFilePath(scope, args[0] as string);
        await importFile(srcRel, srcAbs, dstRel);
        return { handled: true };
      }
      case "rename": {
        const srcPath = args[0] as string;
        const dstPath = args[1] as string;
        const [srcIsSymlink, dstIsSymlink, srcRel, dstRel] = await Promise.all([
          isLeafSymlink(scope, srcPath),
          isLeafSymlink(scope, dstPath),
          relOf(srcPath, { preserveLeaf: true }),
          relOf(dstPath, { preserveLeaf: true }),
        ]);
        const dstTracked = await tracked(dstRel);
        if (srcIsSymlink) {
          if (!dstTracked) return { handled: false };
          throw codedError(
            "EACCES",
            `fs.rename cannot move or replace a symbolic link at the managed destination ` +
              `${JSON.stringify(dstPath)}; semantic edits cannot represent symlink entries.`
          );
        }
        const srcTracked = await tracked(srcRel);
        if (dstTracked && dstIsSymlink) {
          throw codedError(
            "EACCES",
            `fs.rename cannot move or replace a symbolic link at the managed destination ` +
              `${JSON.stringify(dstPath)}; semantic edits cannot represent symlink entries.`
          );
        }
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
    if (!scope.contextId || scope.unrestricted) return;
    const p = readScopePath(method, args);
    if (p === null) return;
    const fileOrSearchMethod = method !== "readdir" && method !== "glob";
    const wsRel = (fileOrSearchMethod ? canonicalizeWorkspaceFilePath(p) : p).replace(/^\/+/, "");
    const repos = scopeForPath(wsRel);
    if (repos === null) return;
    if (repos !== "all" && !(await bridge.isTracked(wsRel.replace(/\/+$/, "")))) {
      return;
    }
    await bridge.ensureMaterialized(scope.contextId, repos);
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
    const scope = await this.resolveContextRoot(ctx, args);
    const { panelId } = scope;
    const bridge = this.semanticBridge(scope);
    this.assertScratchOnlyCall(scope, method, args);

    // Explicit projection request for consumers that read disk OUTSIDE fs.*
    // (for example, grep/find in an extension). The argument declares the
    // narrowest read intent while the authority still publishes one complete
    // context projection.
    if (method === "ensureMaterialized") {
      if (scope.contextId && !scope.unrestricted && bridge) {
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

    switch (method) {
      // ----- File content -----
      case "readFile": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        const encoding = args[1] as string | undefined;
        if (encoding) {
          return fs.readFile(p, encoding as BufferEncoding);
        }
        const buf = await fs.readFile(p);
        return encodeBinary(buf);
      }

      case "writeFile": {
        const resolvedPath = await resolveFsFilePathInfo(scope, args[0] as string);
        const p = resolvedPath.path;
        const data = isBinaryEnvelope(args[1]) ? decodeBinary(args[1]) : (args[1] as string);
        await ensureDirectWriteParent(scope, p);
        await fs.writeFile(p, data);
        return;
      }

      case "appendFile": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        const data = isBinaryEnvelope(args[1]) ? decodeBinary(args[1]) : (args[1] as string);
        await ensureDirectWriteParent(scope, p);
        await fs.appendFile(p, data);
        return;
      }

      // ----- Directory operations -----
      case "readdir": {
        const p = await resolveFsPath(scope, args[0] as string);
        const opts = args[1] as { withFileTypes?: boolean; recursive?: boolean } | undefined;
        const recursive = opts?.recursive ?? false;
        if (opts?.withFileTypes) {
          const entries = await fs.readdir(p, { withFileTypes: true, recursive });
          const ingestion = await this.ingestionForProjectedPaths(
            bridge,
            scope,
            ctx,
            entries.map((entry) => path.join(entry.parentPath, entry.name))
          );
          await this.recordProjectedIngestion(ctx, "fs-readdir", ingestion);
          // For recursive listings, report names relative to the listed
          // directory (Node's Dirent.name is just the basename).
          return entries.map((d) =>
            serializeDirent(d, recursive ? relativeDirentName(p, d) : d.name)
          );
        }
        const entries = await fs.readdir(p, recursive ? { recursive } : undefined);
        const ingestion = await this.ingestionForProjectedPaths(
          bridge,
          scope,
          ctx,
          entries.map((entry) => path.join(p, entry))
        );
        await this.recordProjectedIngestion(ctx, "fs-readdir", ingestion);
        return entries;
      }

      case "grep": {
        const result = await this.grep(
          scope,
          args[0] as string,
          args[1] as GrepOptions | undefined
        );
        const ingestion = await this.ingestionForProjectedPaths(
          bridge,
          scope,
          ctx,
          result.matches.map((match) =>
            scope.unrestricted ? match.file : path.join(scope.root, match.file.replace(/^\/+/, ""))
          )
        );
        await this.recordProjectedIngestion(ctx, "fs-grep", ingestion);
        return result;
      }

      case "glob": {
        const result = await this.glob(
          scope,
          args[0] as string,
          args[1] as GlobOptions | undefined
        );
        const ingestion = await this.ingestionForProjectedPaths(
          bridge,
          scope,
          ctx,
          result.map((file) =>
            scope.unrestricted ? file : path.join(scope.root, file.replace(/^\/+/, ""))
          )
        );
        await this.recordProjectedIngestion(ctx, "fs-glob", ingestion);
        return result;
      }

      case "mkdir": {
        const resolvedPath = await resolveFsPathInfo(scope, args[0] as string);
        const p = resolvedPath.path;
        const opts = args[1] as { recursive?: boolean } | undefined;
        const result = await fs.mkdir(p, opts);
        // Return first-created path relative to context root (Node API contract)
        return result && !scope.unrestricted ? "/" + path.relative(scope.root, result) : result;
      }

      case "rmdir": {
        const p = await resolveFsPath(scope, args[0] as string, { leafMode: "entry" });
        await fs.rmdir(p);
        return;
      }

      case "rm": {
        const p = await resolveFsPath(scope, args[0] as string, { leafMode: "entry" });
        const opts = args[1] as { recursive?: boolean; force?: boolean } | undefined;
        await fs.rm(p, opts);
        return;
      }

      // ----- Stat / metadata -----
      case "stat": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        return serializeStat(await fs.stat(p));
      }

      case "lstat": {
        const p = await resolveFsFilePath(scope, args[0] as string, { leafMode: "entry" });
        return serializeStat(await fs.lstat(p));
      }

      case "exists": {
        const p = await resolveFsFilePath(scope, args[0] as string, {
          leafMode: "allow-dangling",
        });
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }

      case "access": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        await fs.access(p, args[1] as number | undefined);
        return;
      }

      // ----- File manipulation -----
      case "unlink": {
        const p = await resolveFsFilePath(scope, args[0] as string, { leafMode: "entry" });
        await fs.unlink(p);
        return;
      }

      case "copyFile": {
        const src = await resolveFsFilePath(scope, args[0] as string);
        const dest = await resolveFsFilePath(scope, args[1] as string);
        await ensureDirectWriteParent(scope, dest);
        await fs.copyFile(src, dest);
        return;
      }

      case "rename": {
        const oldP = await resolveFsFilePath(scope, args[0] as string, { leafMode: "entry" });
        const newP = await resolveFsFilePath(scope, args[1] as string, { leafMode: "entry" });
        await ensureDirectWriteParent(scope, newP);
        await fs.rename(oldP, newP);
        return;
      }

      case "realpath": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        const real = await fs.realpath(p);
        if (scope.unrestricted || scope.exposeHostPaths) return real;
        // Return relative to root (panel sees paths relative to context root)
        if (!real.startsWith(scope.root + path.sep) && real !== scope.root) {
          throw new Error("Realpath escapes sandbox");
        }
        return "/" + path.relative(scope.root, real);
      }

      case "truncate": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        await fs.truncate(p, args[1] as number | undefined);
        return;
      }

      // ----- Symlinks -----
      case "readlink": {
        const p = await resolveFsFilePath(scope, args[0] as string, { leafMode: "entry" });
        const target = await fs.readlink(p);
        if (scope.unrestricted) return target;
        // If the target is absolute, relativize to prevent leaking host paths
        if (path.isAbsolute(target)) {
          const resolved = path.resolve(path.dirname(p), target);
          if (!resolved.startsWith(scope.root + path.sep) && resolved !== scope.root) {
            throw new Error("Readlink target escapes sandbox");
          }
          return "/" + path.relative(scope.root, resolved);
        }
        return target;
      }

      case "symlink": {
        const target = args[0] as string;
        const linkPath = args[1] as string;
        const type = args[2] as "file" | "dir" | "junction" | undefined;
        const p = await resolveFsPath(scope, linkPath, { leafMode: "entry" });
        if (scope.unrestricted) {
          await ensureDirectWriteParent(scope, p);
          await fs.symlink(target, p, type);
          return;
        }
        const wsRel = await canonicalContextRelativePath(scope, linkPath, { preserveLeaf: true });
        const sourceRoot = wsRel.split("/", 1)[0] ?? "";
        const isWorkspaceSourcePath = bridge
          ? await isManagedVcsPath(bridge, wsRel)
          : splitRepoPath(wsRel) !== null || WORKSPACE_SOURCE_ROOTS.has(sourceRoot);
        if (isWorkspaceSourcePath) {
          throw codedError(
            "ENOTSUP",
            `Symbolic links are supported for context-local scratch paths, not managed workspace paths: ${JSON.stringify(linkPath)}`
          );
        }
        const virtualLinkDir = path.posix.dirname(linkPath.replaceAll("\\", "/"));
        const virtualTarget = target.startsWith("/")
          ? target
          : path.posix.join(virtualLinkDir, target);
        const targetPath = await resolveFsPath(scope, virtualTarget, {
          leafMode: "allow-dangling",
        });
        const containedTarget = path.relative(path.dirname(p), targetPath) || ".";
        await ensureDirectWriteParent(scope, p);
        await fs.symlink(containedTarget, p, type);
        return;
      }

      // `chown` remains absent: ownership mutation is neither portable nor safe
      // for context callers. Symlink creation above is scratch-only and stores
      // a target proven to resolve lexically inside the context; every follow-up
      // operation still revalidates traversal through sandboxPath().

      // ----- Permissions & timestamps -----
      case "chmod": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        await fs.chmod(p, args[1] as number);
        return;
      }

      case "utimes": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        await fs.utimes(p, args[1] as number, args[2] as number);
        return;
      }

      // ----- File handles -----
      case "open": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        const flags = (args[1] as string) ?? "r";
        const mode = args[2] as number | undefined;
        const ingestion = await this.ingestionForProjectedPaths(bridge, scope, ctx, [p]);
        const handle = await fs.open(p, flags, mode);
        const handleId = this.trackHandle(handle, panelId, ingestion);
        return { handleId };
      }

      case "handleRead": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        const length = args[1] as number;
        if (length < 0) {
          throw new Error(`Read length out of range`);
        }
        const position = args[2] as number | null;
        const buf = Buffer.alloc(length);
        const result = await tracked.handle.read(buf, 0, length, position);
        if (result.bytesRead > 0 && !tracked.ingestionRecorded) {
          await this.recordProjectedIngestion(ctx, "fs-handle-read", tracked.ingestion);
          tracked.ingestionRecorded = true;
        }
        return {
          bytesRead: result.bytesRead,
          buffer: encodeBinary(buf.subarray(0, result.bytesRead)),
        };
      }

      case "handleWrite": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        const data = isBinaryEnvelope(args[1])
          ? decodeBinary(args[1])
          : Buffer.from(args[1] as string);
        const position = (args[2] as number | null) ?? null;
        const result = await tracked.handle.write(data, 0, data.length, position);
        return { bytesWritten: result.bytesWritten };
      }

      case "handleClose": {
        const id = args[0] as number;
        const tracked = this.openHandles.get(id);
        if (tracked) {
          if (tracked.panelId !== panelId) {
            throw new Error(`File handle ${id} does not belong to caller`);
          }
          clearTimeout(tracked.timer);
          await tracked.handle.close();
          this.openHandles.delete(id);
        }
        return;
      }

      case "handleStat": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        return serializeStat(await tracked.handle.stat());
      }

      // ----- Tmp files (atomic-write helper for tools) -----
      case "mktemp": {
        const prefix = args[0];
        if (prefix !== undefined && typeof prefix !== "string") {
          throw new Error("mktemp prefix must be a string when provided");
        }
        // Normalize prefix: strip any path separators so callers can't escape
        // `.tmp/` by passing e.g. "../foo". Audit finding #20 (filesystem
        // report): strip leading dots so callers cannot create .htaccess /
        // .DS_Store / other hidden-file conventions inside `.tmp/`.
        let safePrefix = (prefix ?? "tmp").replace(/[\\/]/g, "_").replace(/^\.+/, "");
        if (safePrefix.length === 0) safePrefix = "tmp";
        const tmpDir = path.join(scope.root, ".tmp");
        await fs.mkdir(tmpDir, { recursive: true });
        // Audit finding #34: 16 bytes of crypto-grade entropy in the suffix
        // (was already crypto.randomBytes(8); widened to 16 to reduce
        // brute-force pre-create races).
        const random = randomBytes(16).toString("hex");
        const filename = `${safePrefix}-${random}`;
        // Return path relative to context root (with leading `/`) so it
        // matches the format other fs methods accept.
        return "/" + path.posix.join(".tmp", filename);
      }

      default:
        throw new Error(`Unknown fs method: ${method}`);
    }
  }

  // =========================================================================
  // Search (grep / glob)
  // =========================================================================

  /** Map an absolute path back to the caller-visible form. */
  private toDisplayPath(scope: FsCallScope, absolutePath: string): string {
    if (scope.unrestricted) return absolutePath;
    if (absolutePath === scope.root) return "/";
    return "/" + path.relative(scope.root, absolutePath).split(path.sep).join("/");
  }

  /**
   * Search file contents under the context root. Uses a ripgrep subprocess
   * when `rg` is on PATH, with a streaming pure-JS fallback. Skips `.git`,
   * `node_modules`, symlinks, and binary files.
   */
  private async grep(
    scope: FsCallScope,
    pattern: string,
    opts: GrepOptions = {}
  ): Promise<GrepResult> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("grep pattern must be a non-empty string");
    }
    const caseInsensitive = opts.caseInsensitive ?? false;
    // Validate the pattern eagerly (also used by the JS fallback and shared
    // with ripgrep's regex dialect for everyday patterns).
    const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    const contextLines = Math.min(
      GREP_MAX_CONTEXT_LINES,
      Math.max(0, Math.floor(opts.contextLines ?? 0))
    );
    const maxMatches = Math.min(
      GREP_HARD_MAX_MATCHES,
      Math.max(1, Math.floor(opts.maxMatches ?? GREP_DEFAULT_MAX_MATCHES))
    );
    const searchRoot = await resolveFsFilePath(scope, opts.path ?? "/");

    const rgPath = findRipgrep();
    const { raw, truncated } = rgPath
      ? await grepWithRipgrep(
          rgPath,
          searchRoot,
          pattern,
          { caseInsensitive, glob: opts.glob },
          maxMatches
        )
      : await grepWithJs(searchRoot, regex, opts.glob, maxMatches);

    // Attach context lines by re-reading matched files (bounded by maxMatches).
    const fileLines = new Map<string, string[]>();
    if (contextLines > 0) {
      for (const file of new Set(raw.map((m) => m.file))) {
        try {
          fileLines.set(file, (await fs.readFile(file, "utf8")).split(/\r?\n/));
        } catch {
          // File vanished between search and context read; emit without context.
        }
      }
    }

    const matches: GrepMatch[] = raw.map((m) => {
      const lines = fileLines.get(m.file);
      const idx = m.lineNumber - 1;
      return {
        file: this.toDisplayPath(scope, m.file),
        lineNumber: m.lineNumber,
        line: m.line,
        before: lines ? lines.slice(Math.max(0, idx - contextLines), idx) : [],
        after: lines ? lines.slice(idx + 1, idx + 1 + contextLines) : [],
      };
    });

    return { matches, matchCount: matches.length, truncated };
  }

  /**
   * Find files matching a glob pattern under the context root, sorted by
   * mtime descending. Skips `.git`, `node_modules`, and symlinks.
   */
  private async glob(
    scope: FsCallScope,
    pattern: string,
    opts: GlobOptions = {}
  ): Promise<string[]> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("glob pattern must be a non-empty string");
    }
    const searchRoot = await resolveFsPath(scope, opts.path ?? "/");
    const matched: Array<{ file: string; mtimeMs: number }> = [];
    for await (const file of walkFiles(searchRoot)) {
      const rel = path.relative(searchRoot, file).split(path.sep).join("/");
      if (!matchesGlob(rel, pattern)) continue;
      try {
        matched.push({ file, mtimeMs: (await fs.lstat(file)).mtimeMs });
      } catch {
        // File vanished mid-walk.
      }
    }
    matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matched.map((m) => this.toDisplayPath(scope, m.file));
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
