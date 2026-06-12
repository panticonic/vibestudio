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
import type { FileHandle as NodeFileHandle } from "fs/promises";
import type { ServiceContext } from "./serviceDispatcher.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import { createDevLogger } from "@natstack/dev-log";
import { EntityCache } from "./runtime/entityCache.js";

const log = createDevLogger("FsService");

/** Idle timeout for open file handles (5 minutes). */
const HANDLE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Tracked file handle with cleanup metadata. */
interface TrackedHandle {
  handle: NodeFileHandle;
  panelId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface FsCallScope {
  root: string;
  panelId: string;
  contextId?: string;
  unrestricted: boolean;
  exposeHostPaths: boolean;
  isAllowedSharedGitObjectsSymlink?: (args: {
    contextRoot: string;
    symlinkPath: string;
    realTarget: string;
  }) => Promise<boolean>;
}

interface ResolvePathOptions {
  allowSharedGitObjects?: boolean;
  isAllowedSharedGitObjectsSymlink?: FsCallScope["isAllowedSharedGitObjectsSymlink"];
}

interface ResolvedFsPath {
  path: string;
  escapedViaSharedGitObjects: boolean;
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Path sandboxing
// ---------------------------------------------------------------------------

function relativeSegments(root: string, absolutePath: string): string[] {
  const relative = path.relative(root, absolutePath);
  return relative ? relative.split(path.sep) : [];
}

function isContextGitObjectsPath(root: string, absolutePath: string): boolean {
  const segments = relativeSegments(root, absolutePath);
  return (
    segments.length >= 3 &&
    segments[segments.length - 2] === ".git" &&
    segments[segments.length - 1] === "objects"
  );
}

function sharedGitObjectsSubpath(root: string, absolutePath: string): string[] | null {
  const segments = relativeSegments(root, absolutePath);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === ".git" && segments[i + 1] === "objects") {
      return segments.slice(i + 2);
    }
  }
  return null;
}

function sharedGitObjectsRepoPath(root: string, absolutePath: string): string | null {
  const segments = relativeSegments(root, absolutePath);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === ".git" && segments[i + 1] === "objects") {
      return segments.slice(0, i).join("/");
    }
  }
  return null;
}

function isLooseGitObjectDirectory(root: string, absolutePath: string): boolean {
  const subpath = sharedGitObjectsSubpath(root, absolutePath);
  if (subpath === null || subpath.length !== 1) return false;
  const fanout = subpath[0]!;
  return /^[0-9a-f]{2}$/.test(fanout);
}

function isLooseGitObjectFile(root: string, absolutePath: string): boolean {
  const subpath = sharedGitObjectsSubpath(root, absolutePath);
  if (subpath === null || subpath.length !== 2) return false;
  const fanout = subpath[0]!;
  const objectName = subpath[1]!;
  return /^[0-9a-f]{2}$/.test(fanout) && /^[0-9a-f]{38}$/.test(objectName);
}

/**
 * Resolve a user-provided path within a sandbox root, preventing traversal
 * and symlink-based escapes.
 */
async function sandboxPath(
  root: string,
  userPath: string,
  opts: ResolvePathOptions = {}
): Promise<ResolvedFsPath> {
  const relative = userPath.startsWith("/") ? userPath.slice(1) : userPath;
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Path traversal detected");
  }
  // Walk path components and check for symlinks in parents.
  let current = root;
  let escapedViaSharedGitObjects = false;
  const segments = path.relative(root, resolved).split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        const target = await fs.realpath(current);
        if (!target.startsWith(root + path.sep) && target !== root) {
          const allowedSharedObjects =
            opts.allowSharedGitObjects &&
            isContextGitObjectsPath(root, current) &&
            opts.isAllowedSharedGitObjectsSymlink &&
            (await opts.isAllowedSharedGitObjectsSymlink({
              contextRoot: root,
              symlinkPath: current,
              realTarget: target,
            }));
          if (allowedSharedObjects) {
            escapedViaSharedGitObjects = true;
            continue;
          }
          throw new Error("Symlink escapes sandbox");
        }
      }
    } catch (e: any) {
      if (e.code === "ENOENT") break; // remainder doesn't exist yet
      if (e.message === "Symlink escapes sandbox") throw e;
      throw e;
    }
  }
  return { path: resolved, escapedViaSharedGitObjects };
}

async function resolveFsPathInfo(
  scope: FsCallScope,
  userPath: string,
  opts: ResolvePathOptions = {}
): Promise<ResolvedFsPath> {
  if (!scope.unrestricted) {
    return sandboxPath(scope.root, userPath, opts);
  }
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  return { path: path.resolve(userPath), escapedViaSharedGitObjects: false };
}

async function resolveFsPath(
  scope: FsCallScope,
  userPath: string,
  opts: ResolvePathOptions = {}
): Promise<string> {
  return (await resolveFsPathInfo(scope, userPath, opts)).path;
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

  /** handleId → TrackedHandle */
  private readonly openHandles = new Map<number, TrackedHandle>();
  private readonly sharedObjectWrites = new Map<string, { count: number; bytes: number }>();
  private nextHandleId = 1;

  constructor(
    contextFolderManager: ContextFolderManager,
    entityCache: EntityCache = new EntityCache(),
    opts?: { hostFsCapableExtensions?: Iterable<string> }
  ) {
    this.contextFolderManager = contextFolderManager;
    this.entityCache = entityCache;
    this.hostFsCapableExtensions = opts?.hostFsCapableExtensions
      ? new Set(opts.hostFsCapableExtensions)
      : undefined;
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
   * Resolve the context root path for a service call.
   * - panel/app/worker/DO callers: look up contextId from EntityCache
   * - extension callers inside an invocation: use the chained caller context
   * - extension callers outside an invocation: unrestricted host fs
   * - server/shell/harness callers: contextId is the first arg (shifted from
   *   the args array). Shell and harness callers must name an existing
   *   context; server callers may create one on the fly.
   */
  private async resolveContextRoot(ctx: ServiceContext, args: unknown[]): Promise<FsCallScope> {
    let contextId: string;
    let panelId: string;

    if (
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
          isAllowedSharedGitObjectsSymlink: (args) =>
            this.contextFolderManager.isAllowedSharedGitObjectsSymlink(args),
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
      // Server / shell / harness callers pass an explicit contextId as the
      // first argument.
      const kind = ctx.caller.runtime.kind;
      contextId = args.shift() as string;
      panelId = `${kind}:${ctx.caller.runtime.id}`;
      if (!contextId || typeof contextId !== "string") {
        throw new Error(`${kind} fs calls must provide contextId as first argument`);
      }
      if (kind !== "server") {
        // Shell / harness callers may only address contexts that already
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
      isAllowedSharedGitObjectsSymlink: (args) =>
        this.contextFolderManager.isAllowedSharedGitObjectsSymlink(args),
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

  private trackHandle(handle: NodeFileHandle, panelId: string): number {
    const id = this.nextHandleId++;
    const timer = setTimeout(() => {
      log.info(`Closing idle file handle ${id} for ${panelId}`);
      handle.close().catch(() => {});
      this.openHandles.delete(id);
    }, HANDLE_IDLE_TIMEOUT_MS);
    this.openHandles.set(id, { handle, panelId, timer });
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

  // =========================================================================
  // Main dispatch handler
  // =========================================================================

  async handleCall(ctx: ServiceContext, method: string, rawArgs: unknown[]): Promise<unknown> {
    // Clone args so shift() in resolveContextRoot doesn't mutate the original
    const args = [...rawArgs];
    const scope = await this.resolveContextRoot(ctx, args);
    const { root, panelId } = scope;

    switch (method) {
      // ----- File content -----
      case "readFile": {
        const p = await resolveFsPath(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        const encoding = args[1] as string | undefined;
        if (encoding) {
          return fs.readFile(p, encoding as BufferEncoding);
        }
        const buf = await fs.readFile(p);
        return encodeBinary(buf);
      }

      case "writeFile": {
        const resolvedPath = await resolveFsPathInfo(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        const p = resolvedPath.path;
        const data = isBinaryEnvelope(args[1]) ? decodeBinary(args[1]) : (args[1] as string);
        if (resolvedPath.escapedViaSharedGitObjects) {
          if (!isLooseGitObjectFile(root, p)) {
            throw new Error("Shared git object writes are limited to loose object files");
          }
          await fs.writeFile(p, data, { flag: "wx" });
          const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          const objectPath = sharedGitObjectsSubpath(root, p)?.join("/") ?? path.basename(p);
          const quotaKey = `${scope.contextId ?? root}:${sharedGitObjectsRepoPath(root, p) ?? "unknown"}`;
          const previous = this.sharedObjectWrites.get(quotaKey) ?? { count: 0, bytes: 0 };
          const next = { count: previous.count + 1, bytes: previous.bytes + bytes };
          this.sharedObjectWrites.set(quotaKey, next);
          if (bytes > 50 * 1024 * 1024) {
            log.warn(`Large shared git object admitted: ${objectPath} (${bytes} bytes)`);
          } else {
            log.info(`Shared git object admitted: ${objectPath} (${bytes} bytes)`);
          }
          if (next.bytes > 250 * 1024 * 1024) {
            log.warn(
              `Shared git object write volume is high for ${quotaKey}: ${next.count} object(s), ${next.bytes} bytes`
            );
          }
          return;
        }
        await fs.writeFile(p, data);
        return;
      }

      case "appendFile": {
        const p = await resolveFsPath(scope, args[0] as string);
        const data = isBinaryEnvelope(args[1]) ? decodeBinary(args[1]) : (args[1] as string);
        await fs.appendFile(p, data);
        return;
      }

      // ----- Directory operations -----
      case "readdir": {
        const p = await resolveFsPath(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        const opts = args[1] as { withFileTypes?: boolean; recursive?: boolean } | undefined;
        const recursive = opts?.recursive ?? false;
        if (opts?.withFileTypes) {
          const entries = await fs.readdir(p, { withFileTypes: true, recursive });
          // For recursive listings, report names relative to the listed
          // directory (Node's Dirent.name is just the basename).
          return entries.map((d) =>
            serializeDirent(d, recursive ? relativeDirentName(p, d) : d.name)
          );
        }
        return fs.readdir(p, recursive ? { recursive } : undefined);
      }

      case "grep": {
        return this.grep(scope, args[0] as string, args[1] as GrepOptions | undefined);
      }

      case "glob": {
        return this.glob(scope, args[0] as string, args[1] as GlobOptions | undefined);
      }

      case "mkdir": {
        const resolvedPath = await resolveFsPathInfo(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        const p = resolvedPath.path;
        const opts = args[1] as { recursive?: boolean } | undefined;
        if (resolvedPath.escapedViaSharedGitObjects && !isLooseGitObjectDirectory(root, p)) {
          throw new Error(
            "Shared git object directory creation is limited to loose object fanout directories"
          );
        }
        const result = await fs.mkdir(p, opts);
        // Return first-created path relative to context root (Node API contract)
        return result && !scope.unrestricted ? "/" + path.relative(root, result) : result;
      }

      case "rmdir": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.rmdir(p);
        return;
      }

      case "rm": {
        const p = await resolveFsPath(scope, args[0] as string);
        const opts = args[1] as { recursive?: boolean; force?: boolean } | undefined;
        await fs.rm(p, opts);
        return;
      }

      // ----- Stat / metadata -----
      case "stat": {
        const p = await resolveFsPath(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        return serializeStat(await fs.stat(p));
      }

      case "lstat": {
        const p = await resolveFsPath(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        return serializeStat(await fs.lstat(p));
      }

      case "exists": {
        const p = await resolveFsPath(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }

      case "access": {
        const p = await resolveFsPath(scope, args[0] as string, {
          allowSharedGitObjects: true,
          isAllowedSharedGitObjectsSymlink: scope.isAllowedSharedGitObjectsSymlink,
        });
        await fs.access(p, args[1] as number | undefined);
        return;
      }

      // ----- File manipulation -----
      case "unlink": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.unlink(p);
        return;
      }

      case "copyFile": {
        const src = await resolveFsPath(scope, args[0] as string);
        const dest = await resolveFsPath(scope, args[1] as string);
        await fs.copyFile(src, dest);
        return;
      }

      case "rename": {
        const oldP = await resolveFsPath(scope, args[0] as string);
        const newP = await resolveFsPath(scope, args[1] as string);
        await fs.rename(oldP, newP);
        return;
      }

      case "realpath": {
        const p = await resolveFsPath(scope, args[0] as string);
        const real = await fs.realpath(p);
        if (scope.unrestricted || scope.exposeHostPaths) return real;
        // Return relative to root (panel sees paths relative to context root)
        if (!real.startsWith(root + path.sep) && real !== root) {
          throw new Error("Realpath escapes sandbox");
        }
        return "/" + path.relative(root, real);
      }

      case "truncate": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.truncate(p, args[1] as number | undefined);
        return;
      }

      // ----- Symlinks -----
      case "readlink": {
        const p = await resolveFsPath(scope, args[0] as string);
        const target = await fs.readlink(p);
        if (scope.unrestricted) return target;
        // If the target is absolute, relativize to prevent leaking host paths
        if (path.isAbsolute(target)) {
          const resolved = path.resolve(path.dirname(p), target);
          if (!resolved.startsWith(root + path.sep) && resolved !== root) {
            throw new Error("Readlink target escapes sandbox");
          }
          return "/" + path.relative(root, resolved);
        }
        return target;
      }

      // NOTE: `symlink` and `chown` were removed entirely (audit findings #38,
      // #39): they are sandbox-escape primitives (TOCTOU symlink races,
      // privilege weirdness on setgid dirs). Internal server code can use raw
      // Node fs; nothing in the service surface needs them.

      // ----- Permissions & timestamps -----
      case "chmod": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.chmod(p, args[1] as number);
        return;
      }

      case "utimes": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.utimes(p, args[1] as number, args[2] as number);
        return;
      }

      // ----- File handles -----
      case "open": {
        const p = await resolveFsPath(scope, args[0] as string);
        const flags = (args[1] as string) ?? "r";
        const mode = args[2] as number | undefined;
        const handle = await fs.open(p, flags, mode);
        const handleId = this.trackHandle(handle, panelId);
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
        const tmpDir = path.join(root, ".tmp");
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
    const searchRoot = await resolveFsPath(scope, opts.path ?? "/");

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
