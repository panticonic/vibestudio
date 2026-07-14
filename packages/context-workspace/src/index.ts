import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalArtifactPath, sha256 } from "@vibestudio/shared/execution/identity";

export interface CanonicalWorkspaceFile {
  path: string;
  bytes: Uint8Array;
  mode: 0o644 | 0o755;
}

export type WorkspaceEdit =
  | { kind: "write"; path: string; bytes: Uint8Array; mode: 0o644 | 0o755 }
  | { kind: "delete"; path: string };

export interface ContextWorkspaceAdapters {
  readState(repoPath: string, stateHash: string): Promise<CanonicalWorkspaceFile[]>;
  edit(input: {
    repoPath: string;
    baseStateHash: string;
    clientEditId: string;
    edits: WorkspaceEdit[];
  }): Promise<{ stateHash: string }>;
}

interface SerializedEdit {
  kind: "write" | "delete";
  path: string;
  bytes?: string;
  mode?: 0o644 | 0o755;
}

interface SyncJournal {
  clientEditId: string;
  baseStateHash: string;
  edits: SerializedEdit[];
}

interface SyncCheckpoint {
  version: 1;
  repoPath: string;
  acknowledgedStateHash: string;
  generation: number;
  canonical: Record<string, { digest: string; mode: 0o644 | 0o755 }>;
  journal?: SyncJournal;
  status: "ready" | "disconnected" | "conflict";
  conflict?: { expected: string; message: string };
}

export interface ContextWorkspaceStatus {
  stateHash: string;
  generation: number;
  fileCount: number;
  pendingEdits: number;
  status: SyncCheckpoint["status"];
  conflict?: SyncCheckpoint["conflict"];
}

export interface ContextWorkspaceTarget {
  repoPath: string;
  stateHash: string;
}

/**
 * Durable per-repository GAD↔writable-tree CAS state machine. Network outcomes
 * are retried with the same journal id; stale bases stop mutation and preserve
 * the working bytes for explicit reconciliation.
 */
export class ContextWorkspaceSynchronizer {
  private readonly metadataDir: string;
  private readonly checkpointFile: string;
  private checkpoint: SyncCheckpoint;

  private constructor(
    private readonly root: string,
    private readonly repoPath: string,
    private readonly adapters: ContextWorkspaceAdapters,
    checkpoint: SyncCheckpoint
  ) {
    this.metadataDir = path.join(root, ".vibestudio-sync");
    this.checkpointFile = path.join(this.metadataDir, "checkpoint.json");
    this.checkpoint = checkpoint;
  }

  static async open(input: {
    root: string;
    repoPath: string;
    stateHash: string;
    adapters: ContextWorkspaceAdapters;
  }): Promise<ContextWorkspaceSynchronizer> {
    const root = path.resolve(input.root);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const checkpointFile = path.join(root, ".vibestudio-sync", "checkpoint.json");
    if (fs.existsSync(checkpointFile)) {
      const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8")) as SyncCheckpoint;
      if (checkpoint.version !== 1 || checkpoint.repoPath !== input.repoPath) {
        throw new Error("Context workspace checkpoint does not match requested repository");
      }
      return new ContextWorkspaceSynchronizer(root, input.repoPath, input.adapters, checkpoint);
    }
    const files = await input.adapters.readState(input.repoPath, input.stateHash);
    const checkpoint: SyncCheckpoint = {
      version: 1,
      repoPath: input.repoPath,
      acknowledgedStateHash: input.stateHash,
      generation: 1,
      canonical: {},
      status: "ready",
    };
    const synchronizer = new ContextWorkspaceSynchronizer(root, input.repoPath, input.adapters, checkpoint);
    synchronizer.applyCanonical(files, new Set());
    synchronizer.persist();
    return synchronizer;
  }

  status(): ContextWorkspaceStatus {
    return {
      stateHash: this.checkpoint.acknowledgedStateHash,
      generation: this.checkpoint.generation,
      fileCount: Object.keys(this.checkpoint.canonical).length,
      pendingEdits: this.checkpoint.journal?.edits.length ?? 0,
      status: this.checkpoint.status,
      ...(this.checkpoint.conflict ? { conflict: { ...this.checkpoint.conflict } } : {}),
    };
  }

  async flush(): Promise<ContextWorkspaceStatus> {
    if (this.checkpoint.status === "conflict") {
      throw new Error(`Context workspace has an unresolved CAS conflict: ${this.checkpoint.conflict?.message}`);
    }
    if (!this.checkpoint.journal) {
      const edits = this.computeLocalEdits();
      if (edits.length === 0) return this.status();
      this.checkpoint.journal = {
        clientEditId: randomUUID(),
        baseStateHash: this.checkpoint.acknowledgedStateHash,
        edits: edits.map(serializeEdit),
      };
      this.persist();
    }
    const journal = this.checkpoint.journal;
    try {
      const result = await this.adapters.edit({
        repoPath: this.repoPath,
        baseStateHash: journal.baseStateHash,
        clientEditId: journal.clientEditId,
        edits: journal.edits.map(deserializeEdit),
      });
      this.checkpoint.acknowledgedStateHash = result.stateHash;
      this.applyEditsToCanonical(journal.edits);
      delete this.checkpoint.journal;
      delete this.checkpoint.conflict;
      this.checkpoint.status = "ready";
      this.checkpoint.generation += 1;
      this.persist();
      return this.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCasConflict(error)) {
        this.checkpoint.status = "conflict";
        this.checkpoint.conflict = { expected: journal.baseStateHash, message };
      } else {
        this.checkpoint.status = "disconnected";
      }
      this.persist();
      throw error;
    }
  }

  /** Retry an unknown/disconnected write with the original durable client id. */
  async reconnect(): Promise<ContextWorkspaceStatus> {
    if (this.checkpoint.status === "conflict") return this.status();
    this.checkpoint.status = "ready";
    return this.flush();
  }

  async pull(stateHash: string): Promise<ContextWorkspaceStatus> {
    const localEdits = this.computeLocalEdits();
    const dirtyPaths = new Set(localEdits.map((edit) => edit.path));
    if (this.checkpoint.journal) {
      for (const edit of this.checkpoint.journal.edits) dirtyPaths.add(edit.path);
    }
    const files = await this.adapters.readState(this.repoPath, stateHash);
    const incoming = new Map(
      files.map((file) => {
        const relative = canonicalArtifactPath(file.path);
        return [relative, { digest: sha256(file.bytes), mode: file.mode }] as const;
      })
    );
    const actual = scanRegularFiles(
      this.root,
      this.metadataDir,
      new Set(Object.keys(this.checkpoint.canonical))
    );
    const protectedPaths = new Set<string>();
    for (const dirtyPath of dirtyPaths) {
      const localFile = actual.get(dirtyPath);
      const local = localFile
        ? { digest: sha256(localFile.bytes), mode: localFile.mode }
        : undefined;
      const base = this.checkpoint.canonical[dirtyPath];
      const next = incoming.get(dirtyPath);
      if (sameFileIdentity(local, next)) continue;
      if (sameFileIdentity(base, next)) {
        protectedPaths.add(dirtyPath);
        continue;
      }
      {
        this.checkpoint.status = "conflict";
        this.checkpoint.conflict = {
          expected: this.checkpoint.acknowledgedStateHash,
          message: `Inbound and local state both changed path: ${dirtyPath}`,
        };
        this.persist();
        return this.status();
      }
    }
    this.applyCanonical(files, protectedPaths);
    this.checkpoint.acknowledgedStateHash = stateHash;
    if (this.checkpoint.journal) {
      const reflected = this.checkpoint.journal.edits.every((edit) => {
        const next = incoming.get(edit.path);
        return edit.kind === "delete"
          ? next === undefined
          : sameFileIdentity(
              { digest: sha256(Buffer.from(edit.bytes!, "base64")), mode: edit.mode! },
              next
            );
      });
      if (reflected) delete this.checkpoint.journal;
      else this.checkpoint.journal.baseStateHash = stateHash;
    }
    this.checkpoint.generation += 1;
    this.checkpoint.status = "ready";
    delete this.checkpoint.conflict;
    this.persist();
    return this.status();
  }

  private computeLocalEdits(): WorkspaceEdit[] {
    const actual = scanRegularFiles(this.root, this.metadataDir, new Set(Object.keys(this.checkpoint.canonical)));
    const edits: WorkspaceEdit[] = [];
    for (const [relative, file] of actual) {
      const canonical = this.checkpoint.canonical[relative];
      if (!canonical || canonical.digest !== sha256(file.bytes) || canonical.mode !== file.mode) {
        edits.push({ kind: "write", path: relative, bytes: file.bytes, mode: file.mode });
      }
    }
    for (const relative of Object.keys(this.checkpoint.canonical)) {
      if (!actual.has(relative)) edits.push({ kind: "delete", path: relative });
    }
    return edits.sort((a, b) => a.path.localeCompare(b.path));
  }

  private applyCanonical(files: CanonicalWorkspaceFile[], protectedPaths: Set<string>): void {
    const next: SyncCheckpoint["canonical"] = {};
    const portablePaths = new Map<string, string>();
    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const relative = canonicalArtifactPath(file.path);
      const portable = relative.toLocaleLowerCase("en-US");
      const collision = portablePaths.get(portable);
      if (collision && collision !== relative) {
        throw new Error(`Canonical workspace paths collide on supported targets: ${collision} and ${relative}`);
      }
      portablePaths.set(portable, relative);
      assertRepresentableMode(file.mode, relative);
      next[relative] = { digest: sha256(file.bytes), mode: file.mode };
      if (!protectedPaths.has(relative)) writeFile(this.root, relative, file.bytes, file.mode);
    }
    for (const previous of Object.keys(this.checkpoint.canonical)) {
      if (!next[previous] && !protectedPaths.has(previous)) {
        fs.rmSync(path.join(this.root, ...previous.split("/")), { force: true });
      }
    }
    this.checkpoint.canonical = next;
  }

  private applyEditsToCanonical(edits: SerializedEdit[]): void {
    for (const edit of edits) {
      if (edit.kind === "delete") delete this.checkpoint.canonical[edit.path];
      else {
        const bytes = Buffer.from(edit.bytes!, "base64");
        this.checkpoint.canonical[edit.path] = { digest: sha256(bytes), mode: edit.mode! };
      }
    }
  }

  private persist(): void {
    fs.mkdirSync(this.metadataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.checkpointFile}.tmp.${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(this.checkpoint, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.checkpointFile);
  }
}

/**
 * Multi-repository attached workspace lifecycle. Both the CLI and native tool
 * extensions use this owner, so polling, serialization, conflict handling and
 * final-flush behavior have one implementation.
 */
export class ContextWorkspaceSession {
  private localTimer: NodeJS.Timeout | null = null;
  private inboundTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  private constructor(
    readonly root: string,
    private readonly adapters: ContextWorkspaceAdapters,
    private readonly synchronizers: Map<string, ContextWorkspaceSynchronizer>
  ) {}

  static async open(input: {
    root: string;
    targets: readonly ContextWorkspaceTarget[];
    adapters: ContextWorkspaceAdapters;
  }): Promise<ContextWorkspaceSession> {
    const session = new ContextWorkspaceSession(
      path.resolve(input.root),
      input.adapters,
      new Map()
    );
    fs.mkdirSync(session.root, { recursive: true, mode: 0o700 });
    await session.reconcile(input.targets);
    return session;
  }

  statuses(): Record<string, ContextWorkspaceStatus> {
    return Object.fromEntries(
      [...this.synchronizers.entries()].map(([repoPath, sync]) => [repoPath, sync.status()])
    );
  }

  async reconcile(targets: readonly ContextWorkspaceTarget[]): Promise<void> {
    for (const target of targets) {
      const repoPath = canonicalArtifactPath(target.repoPath);
      let sync = this.synchronizers.get(repoPath);
      if (!sync) {
        sync = await ContextWorkspaceSynchronizer.open({
          root: path.join(this.root, ...repoPath.split("/")),
          repoPath,
          stateHash: target.stateHash,
          adapters: this.adapters,
        });
        this.synchronizers.set(repoPath, sync);
      }
      if (sync.status().stateHash !== target.stateHash) await sync.pull(target.stateHash);
    }
  }

  async flush(input: { failOnConflict?: boolean } = {}): Promise<void> {
    for (const [repoPath, sync] of this.synchronizers) {
      if (sync.status().status === "conflict") {
        if (input.failOnConflict) {
          throw new Error(`Context workspace ${repoPath} has an unresolved synchronization conflict`);
        }
        continue;
      }
      await sync.flush();
    }
  }

  start(input: {
    readTargets: () => Promise<readonly ContextWorkspaceTarget[]>;
    onError: (message: string, error: unknown) => void;
    localIntervalMs?: number;
    inboundIntervalMs?: number;
  }): void {
    if (this.localTimer || this.inboundTimer) throw new Error("Context workspace session is already attached");
    const serialized = (work: () => Promise<void>, label: string): void => {
      if (this.running) return;
      this.running = work()
        .catch((error: unknown) => input.onError(label, error))
        .finally(() => {
          this.running = null;
        });
    };
    this.localTimer = setInterval(
      () => serialized(() => this.flush(), "outbound synchronization paused"),
      input.localIntervalMs ?? 350
    );
    this.inboundTimer = setInterval(
      () =>
        serialized(
          async () => this.reconcile(await input.readTargets()),
          "inbound synchronization paused"
        ),
      input.inboundIntervalMs ?? 4_000
    );
    this.localTimer.unref?.();
    this.inboundTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.localTimer) clearInterval(this.localTimer);
    if (this.inboundTimer) clearInterval(this.inboundTimer);
    this.localTimer = null;
    this.inboundTimer = null;
    await this.running;
    await this.flush({ failOnConflict: true });
  }
}

function sameFileIdentity(
  left: { digest: string; mode: 0o644 | 0o755 } | undefined,
  right: { digest: string; mode: 0o644 | 0o755 } | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.digest === right.digest && left.mode === right.mode;
}

function scanRegularFiles(
  root: string,
  metadataDir: string,
  canonicalPaths: ReadonlySet<string>
): Map<string, { bytes: Buffer; mode: 0o644 | 0o755 }> {
  const result = new Map<string, { bytes: Buffer; mode: 0o644 | 0o755 }>();
  const canonicalDirectories = new Set<string>();
  for (const file of canonicalPaths) {
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      canonicalDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (absolute === metadataDir) continue;
      const relative = canonicalArtifactPath(path.relative(root, absolute).split(path.sep).join("/"));
      const canonical = canonicalPaths.has(relative) || canonicalDirectories.has(relative);
      if (!canonical && isLocalScratchPath(relative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Unsupported local symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        result.set(relative, {
          bytes: fs.readFileSync(absolute),
          mode: (stat.mode & 0o111) !== 0 ? 0o755 : 0o644,
        });
      } else throw new Error(`Unsupported local entry type: ${relative}`);
    }
  };
  visit(root);
  return result;
}

const LOCAL_SCRATCH_DIRS = new Set([
  ".git",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  ".turbo",
  ".vite",
  "node_modules",
  "dist",
  "out",
  "coverage",
  "test-results",
  "dist_electron",
  "release",
]);

function isLocalScratchPath(relative: string): boolean {
  const segments = relative.split("/");
  if (segments.some((segment) => LOCAL_SCRATCH_DIRS.has(segment))) return true;
  const base = segments.at(-1) ?? "";
  return (
    base === ".DS_Store" ||
    base === "Thumbs.db" ||
    /^\.env(?:\..*)?$/.test(base) ||
    /(?:\.log|\.sw[op]|\.tsbuildinfo|\.tgz|~)$/.test(base)
  );
}

function writeFile(root: string, relative: string, bytes: Uint8Array, mode: 0o644 | 0o755): void {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.vibestudio-inbound-${process.pid}`;
  fs.writeFileSync(temp, bytes, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
}

function serializeEdit(edit: WorkspaceEdit): SerializedEdit {
  return edit.kind === "delete"
    ? { kind: "delete", path: canonicalArtifactPath(edit.path) }
    : {
        kind: "write",
        path: canonicalArtifactPath(edit.path),
        bytes: Buffer.from(edit.bytes).toString("base64"),
        mode: edit.mode,
      };
}

function deserializeEdit(edit: SerializedEdit): WorkspaceEdit {
  return edit.kind === "delete"
    ? { kind: "delete", path: edit.path }
    : { kind: "write", path: edit.path, bytes: Buffer.from(edit.bytes!, "base64"), mode: edit.mode! };
}

function assertRepresentableMode(mode: number, file: string): asserts mode is 0o644 | 0o755 {
  if (mode !== 0o644 && mode !== 0o755) throw new Error(`Unsupported canonical file mode for ${file}: ${mode}`);
}

function isCasConflict(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { code?: unknown }).code === "CAS_CONFLICT" ||
        (error as { errorCode?: unknown }).errorCode === "CAS_CONFLICT" ||
        (typeof (error as { message?: unknown }).message === "string" &&
          (error as { message: string }).message.includes("edit CAS conflict")))
  );
}
