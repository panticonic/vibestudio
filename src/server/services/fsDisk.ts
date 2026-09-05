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
  type GrepMatch,
  type GlobOptions,
  type GrepOptions,
  encodeBinary,
  isBinaryEnvelope,
  type BinaryEnvelope,
} from "./fsValues.js";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import ignore, { type Ignore } from "ignore";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { FileHandle as NodeFileHandle } from "fs/promises";
import { createDevLogger } from "@vibestudio/dev-log";
import {
  canonicalizeWorkspaceFilePath,
  splitRepoPath,
} from "@vibestudio/shared/runtime/entitySpec";
import { WORKSPACE_SOURCE_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";
export interface FsDiskScope {
  root: string;
  panelId: string;
  exposeHostPaths: boolean;
}
interface TrackedHandle {
  handle: NodeFileHandle;
  panelId: string;
  timer: ReturnType<typeof setTimeout>;
}

const log = createDevLogger("FsService");

const WORKSPACE_SOURCE_ROOTS = new Set<string>(WORKSPACE_SOURCE_DIRS);

const HANDLE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
  scope: FsDiskScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<ResolvedFsPath> {
  return sandboxPath(scope.root, userPath, options);
}

async function resolveFsPath(
  scope: FsDiskScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<string> {
  return (await resolveFsPathInfo(scope, userPath, options)).path;
}

async function resolveFsFilePathInfo(
  scope: FsDiskScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<ResolvedFsPath> {
  return resolveFsPathInfo(scope, canonicalizeWorkspaceFilePath(userPath), options);
}

async function resolveFsFilePath(
  scope: FsDiskScope,
  userPath: string,
  options: ResolveFsPathOptions = {}
): Promise<string> {
  return (await resolveFsFilePathInfo(scope, userPath, options)).path;
}

async function canonicalContextRelativePath(
  scope: FsDiskScope,
  userPath: string,
  options: { preserveLeaf?: boolean; directory?: boolean } = {}
): Promise<string> {
  const preserveLeaf = options.preserveLeaf ?? false;
  const resolved = options.directory
    ? await resolveFsPath(scope, userPath, {
        leafMode: preserveLeaf ? "entry" : "follow",
      })
    : await resolveFsFilePath(scope, userPath, {
        leafMode: preserveLeaf ? "entry" : "follow",
      });

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

async function ensureDirectWriteParent(scope: FsDiskScope, absolutePath: string): Promise<void> {
  if (absolutePath === scope.root) return;
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
}

function decodeBinary(envelope: BinaryEnvelope): Buffer {
  return Buffer.from(envelope.data, "base64");
}

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

function relativeDirentName(listedDir: string, d: fsSync.Dirent): string {
  return path.relative(listedDir, path.join(d.parentPath, d.name)).split(path.sep).join("/");
}

const SEARCH_SKIP_DIRS = new Set([".git", ".gad", "node_modules"]);

const GREP_DEFAULT_MAX_MATCHES = 200;

const GREP_HARD_MAX_MATCHES = 1000;

const GREP_MAX_RESULT_LINES = 10_000;

interface RawGrepMatch {
  /** Absolute file path. */
  file: string;
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

async function readBytesRangeFromFile(
  filePath: string,
  rawOptions: ReadBytesOptions | undefined,
  signal?: AbortSignal
): Promise<ReadBytesResult> {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
  const options = normalizedReadBytesOptions(rawOptions);
  const selected: Buffer[] = [];
  const hash = createHash("sha256");
  let totalBytes = 0;
  const stream = fsSync.createReadStream(filePath);
  try {
    for await (const value of stream) {
      if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
      const chunk = Buffer.from(value as Uint8Array);
      const chunkStart = totalBytes;
      const chunkEnd = chunkStart + chunk.length;
      hash.update(chunk);
      totalBytes = chunkEnd;
      const overlapStart = Math.max(options.offset, chunkStart);
      const overlapEnd = Math.min(options.offset + options.limit, chunkEnd);
      if (overlapStart < overlapEnd) {
        selected.push(chunk.subarray(overlapStart - chunkStart, overlapEnd - chunkStart));
      }
    }
    return byteRangeResult(Buffer.concat(selected), totalBytes, hash.digest("hex"), options);
  } finally {
    stream.destroy();
  }
}

async function readTextRangeFromFile(
  filePath: string,
  options: ReadTextOptions | undefined,
  signal?: AbortSignal
): Promise<ReadTextResult> {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
  const accumulator = new TextRangeAccumulator(normalizedReadTextOptions(options));
  const decoder = new StringDecoder("utf8");
  const hash = createHash("sha256");
  let totalBytes = 0;
  const stream = fsSync.createReadStream(filePath);
  try {
    for await (const value of stream) {
      if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
      const chunk = Buffer.from(value as Uint8Array);
      totalBytes += chunk.length;
      hash.update(chunk);
      accumulator.push(decoder.write(chunk));
    }
    accumulator.push(decoder.end());
    return accumulator.finish(hash.digest("hex"), totalBytes);
  } finally {
    stream.destroy();
  }
}

let ripgrepPathOverride: string | null | undefined;
export function _setRipgrepPathForTests(value: string | null | undefined): void {
  ripgrepPathOverride = value;
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

async function addSearchIgnoreRules(matcher: Ignore, dir: string, root: string): Promise<void> {
  const relativeDir = path.relative(root, dir).split(path.sep).join("/");
  const prefix = relativeDir ? `${relativeDir}/` : "";
  for (const filename of [".gitignore", ".ignore"]) {
    try {
      const rules = (await fs.readFile(path.join(dir, filename), "utf8"))
        .split(/\r?\n/u)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => line !== null);
      if (rules.length > 0) matcher.add(rules);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function* walkFiles(
  root: string,
  options: { includeIgnored?: boolean; signal?: AbortSignal } = {}
): AsyncGenerator<string> {
  const matcher = ignore().add([".git/", ".gad/", "node_modules/"]);
  async function* visit(dir: string): AsyncGenerator<string> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Operation aborted");
    if (!options.includeIgnored) await addSearchIgnoreRules(matcher, dir, root);
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) =>
      compareUtf16CodeUnits(
        left.name + (left.isDirectory() ? "/" : ""),
        right.name + (right.isDirectory() ? "/" : "")
      )
    );
    for (const entry of entries) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Operation aborted");
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
        if (!options.includeIgnored && matcher.ignores(`${rel}/`)) continue;
        yield* visit(abs);
      } else if (entry.isFile()) {
        if (!options.includeIgnored && matcher.ignores(rel)) continue;
        yield abs;
      }
      // Symlinks and special entries are never followed across the authority boundary.
    }
  }
  yield* visit(root);
}

async function grepWithRipgrep(
  rgPath: string,
  searchRoot: string,
  pattern: string,
  opts: { caseInsensitive: boolean; glob?: string; includeIgnored: boolean },
  limit: number,
  contextLines: number,
  signal?: AbortSignal
): Promise<{ raw: RawGrepMatch[]; truncated: boolean }> {
  const { spawn } = await import("node:child_process");
  const rgArgs = [
    "--json",
    "--sort",
    "path",
    "--hidden",
    "--no-messages",
    "--no-require-git",
    "--glob",
    "!**/.git/**",
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!**/.gad/**",
  ];
  if (opts.includeIgnored) rgArgs.push("--no-ignore");
  if (contextLines > 0) rgArgs.push("--context", String(contextLines));
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
    const contextByFile = new Map<string, Map<number, string>>();
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (err) rejectPromise(err);
      else resolvePromise({ raw, truncated });
    };
    const abort = () => {
      child.kill();
      finish(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

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
        if (event.type !== "match" && event.type !== "context") continue;
        const file = event.data?.path?.text;
        const text = event.data?.lines?.text;
        const lineNumber = event.data?.line_number;
        // Skip non-UTF8 payloads (rg reports them as base64 `bytes`).
        if (typeof file !== "string" || typeof text !== "string") continue;
        if (typeof lineNumber !== "number") continue;
        if (event.type === "context") {
          const lines = contextByFile.get(file) ?? new Map<number, string>();
          lines.set(lineNumber, text.replace(/\r?\n$/u, ""));
          contextByFile.set(file, lines);
          continue;
        }
        if (raw.length >= limit) {
          truncated = true;
          child.kill();
          return;
        }
        const lines = contextByFile.get(file) ?? new Map<number, string>();
        lines.set(lineNumber, text.replace(/\r?\n$/u, ""));
        contextByFile.set(file, lines);
        raw.push({
          file,
          lineNumber,
          line: text.replace(/\r?\n$/u, ""),
          before: [],
          after: [],
        });
      }
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      // rg exits 0 on matches, 1 on no matches, 2 on error.
      if (!truncated && code !== null && code > 1) {
        finish(new Error(`ripgrep failed: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      for (const match of raw) {
        const lines = contextByFile.get(match.file);
        if (!lines) continue;
        for (let line = match.lineNumber - contextLines; line < match.lineNumber; line += 1) {
          const value = lines.get(line);
          if (value !== undefined) match.before.push(value);
        }
        for (let line = match.lineNumber + 1; line <= match.lineNumber + contextLines; line += 1) {
          const value = lines.get(line);
          if (value !== undefined) match.after.push(value);
        }
      }
      finish();
    });
  });
}
export interface FsDiskPort {
  call(scope: FsDiskScope, method: string, args: unknown[], signal?: AbortSignal): Promise<unknown>;
  closeCaller(callerId: string, signal?: AbortSignal): Promise<void>;
}

/** Native disk operations only. No ServiceContext, semantic bridge or authority resolver. */
export class FsDisk implements FsDiskPort {
  constructor(private readonly ripgrepPath: string) {}
  private readonly openHandles = new Map<number, TrackedHandle>();
  private nextHandleId = 1;
  async closeCaller(callerId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [id, tracked] of this.openHandles) {
      if (tracked.panelId !== callerId) continue;
      this.openHandles.delete(id);
      clearTimeout(tracked.timer);
      closing.push(tracked.handle.close());
    }
    await Promise.allSettled(closing);
  }
  async stop(): Promise<void> {
    await Promise.all(
      [...new Set([...this.openHandles.values()].map((x) => x.panelId))].map((id) =>
        this.closeCaller(id)
      )
    );
  }
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
  async call(
    scope: FsDiskScope,
    method: string,
    args: unknown[],
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    const { panelId } = scope;
    switch (method) {
      // ----- File content -----
      case "snapshot": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        const handle = await fs.open(p, "r");
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw codedError("EINVAL", "Only regular files can be imported");
          const maximum = 16 * 1024 * 1024;
          const bytes = Buffer.alloc(maximum + 1);
          let size = 0;
          while (size < bytes.length) {
            const read = await handle.read(bytes, size, bytes.length - size, size);
            if (!read.bytesRead) break;
            size += read.bytesRead;
          }
          if (size > maximum) throw codedError("ELIMIT", "Native import exceeds 16 MiB");
          return { buffer: encodeBinary(bytes.subarray(0, size)), mode: stat.mode };
        } finally {
          await handle.close();
        }
      }
      case "readFile": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        const encoding = args[1] as string | undefined;
        if (encoding) {
          return fs.readFile(p, encoding as BufferEncoding);
        }
        const buf = await fs.readFile(p);
        return encodeBinary(buf);
      }

      case "readText": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        return readTextRangeFromFile(p, args[1] as ReadTextOptions | undefined, signal);
      }

      case "readBytes": {
        const p = await resolveFsFilePath(scope, args[0] as string);
        return readBytesRangeFromFile(p, args[1] as ReadBytesOptions | undefined, signal);
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
          return entries.map((d) =>
            serializeDirent(d, recursive ? relativeDirentName(p, d) : d.name)
          );
        }
        return fs.readdir(p, recursive ? { recursive } : undefined);
      }

      case "grep":
        return this.grep(scope, args[0] as string, args[1] as GrepOptions | undefined, signal);

      case "glob":
        return this.glob(scope, args[0] as string, args[1] as GlobOptions | undefined, signal);

      case "mkdir": {
        const resolvedPath = await resolveFsPathInfo(scope, args[0] as string);
        const p = resolvedPath.path;
        const opts = args[1] as { recursive?: boolean } | undefined;
        const result = await fs.mkdir(p, opts);
        // Return first-created path relative to context root (Node API contract)
        return result ? "/" + path.relative(scope.root, result) : result;
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
        if (scope.exposeHostPaths) return real;
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
        const wsRel = await canonicalContextRelativePath(scope, linkPath, { preserveLeaf: true });
        const sourceRoot = wsRel.split("/", 1)[0] ?? "";
        const isWorkspaceSourcePath =
          splitRepoPath(wsRel) !== null || WORKSPACE_SOURCE_ROOTS.has(sourceRoot);
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
  private toDisplayPath(scope: FsDiskScope, absolutePath: string): string {
    if (absolutePath === scope.root) return "/";
    return "/" + path.relative(scope.root, absolutePath).split(path.sep).join("/");
  }
  private async grep(
    scope: FsDiskScope,
    pattern: string,
    opts: GrepOptions = {},
    signal?: AbortSignal
  ): Promise<GrepResult> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("grep pattern must be a non-empty string");
    }
    const caseInsensitive = opts.caseInsensitive ?? false;
    const requestedContextLines = opts.contextLines ?? 0;
    if (!Number.isSafeInteger(requestedContextLines) || requestedContextLines < 0) {
      throw new RangeError("grep contextLines must be a non-negative safe integer");
    }
    const maxMatches = opts.maxMatches ?? GREP_DEFAULT_MAX_MATCHES;
    if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > GREP_HARD_MAX_MATCHES) {
      throw new RangeError(`grep maxMatches must be an integer from 1 to ${GREP_HARD_MAX_MATCHES}`);
    }
    // Context is useful precisely when callers need to inspect a larger local
    // region. Bound the aggregate response instead of rejecting that request
    // at an arbitrary per-match number. One result consumes at most
    // (2 * context + 1) lines; both dimensions are reduced only as necessary
    // to keep the complete host-side result within this invariant.
    const contextLines = Math.min(
      requestedContextLines,
      Math.floor((GREP_MAX_RESULT_LINES - 1) / 2)
    );
    const boundedMaxMatches = Math.min(
      maxMatches,
      Math.max(1, Math.floor(GREP_MAX_RESULT_LINES / (2 * contextLines + 1)))
    );
    const contextTruncated = contextLines !== requestedContextLines;
    const searchRoot = await resolveFsFilePath(scope, opts.path ?? "/");
    try {
      await fs.stat(searchRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const requestedPath = opts.path ?? "/";
      throw Object.assign(new Error(`grep search path not found: ${requestedPath}`), {
        code: "ENOENT",
        path: requestedPath,
      });
    }

    const rgPath = ripgrepPathOverride === undefined ? this.ripgrepPath : ripgrepPathOverride;
    if (!rgPath) throw new Error("The bundled ripgrep search engine is unavailable");
    const { raw, truncated } = await grepWithRipgrep(
      rgPath,
      searchRoot,
      pattern,
      { caseInsensitive, glob: opts.glob, includeIgnored: opts.includeIgnored === true },
      boundedMaxMatches,
      contextLines,
      signal
    );

    const matches: GrepMatch[] = raw.map((m) => {
      return {
        file: this.toDisplayPath(scope, m.file),
        lineNumber: m.lineNumber,
        line: m.line,
        before: m.before,
        after: m.after,
      };
    });

    return { matches, matchCount: matches.length, truncated: truncated || contextTruncated };
  }
  private async glob(
    scope: FsDiskScope,
    pattern: string,
    opts: GlobOptions = {},
    signal?: AbortSignal
  ): Promise<GlobResult> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("glob pattern must be a non-empty string");
    }
    const searchRoot = await resolveFsPath(scope, opts.path ?? "/");
    const limit = opts.limit ?? 1_000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("glob limit must be an integer from 1 to 10000");
    }
    const matched: string[] = [];
    for await (const file of walkFiles(searchRoot, {
      includeIgnored: opts.includeIgnored,
      signal,
    })) {
      const rel = path.relative(searchRoot, file).split(path.sep).join("/");
      if (!matchesGlob(rel, pattern)) continue;
      const display = this.toDisplayPath(scope, file);
      if (opts.after !== undefined && compareUtf16CodeUnits(display, opts.after) <= 0) continue;
      matched.push(display);
      if (matched.length > limit) break;
    }
    const truncated = matched.length > limit;
    const files = truncated ? matched.slice(0, limit) : matched;
    return {
      files,
      truncated,
      ...(truncated ? { nextCursor: files.at(-1) } : {}),
    };
  }
}
