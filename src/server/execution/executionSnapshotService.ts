import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  canonicalArtifactPath,
  computeBuildKey,
  computeRecipeDigest,
  createSourceRevision,
  parseSha256,
  sha256,
  type BuildRecipe,
  type Sha256,
  type SourceRevisionRef,
} from "@vibestudio/shared/execution/identity";

export interface ExecutionSnapshotInput {
  source: {
    repoPath: string;
    stateHash: string;
    closure?: readonly { repoPath: string; stateHash: string }[];
  };
  recipe: BuildRecipe;
}

export interface ExecutionSnapshotFile {
  path: string;
  contentHash: string;
  mode: number;
}

export interface ExecutionSnapshot {
  snapshotId: string;
  executionInputHash: Sha256;
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  sourceRoot: string;
  scratchRoot: string;
  manifestPath: string;
  createdAt: number;
}

interface SnapshotManifest {
  version: 1;
  snapshotId: string;
  ownershipNonce: string;
  executionInputHash: Sha256;
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  files: Array<{ path: string; contentHash: Sha256; size: number; mode: 0o444 | 0o555 }>;
  createdAt: number;
}

export interface ExecutionSnapshotDeps {
  root: string;
  listStateFiles(stateHash: string): Promise<ExecutionSnapshotFile[]>;
  readBlob(contentHash: string): Promise<Buffer | null>;
  /** Optional content-store proof that the supplied listing is the named state. */
  verifyStateFiles?(stateHash: string, files: readonly ExecutionSnapshotFile[]): Promise<void>;
}

/**
 * Materializes one immutable CAS state into an operation-owned private root.
 * It never accepts a source directory, so a live projection cannot become a
 * build input by accident.
 */
export class ExecutionSnapshotService {
  private readonly root: string;

  constructor(private readonly deps: ExecutionSnapshotDeps) {
    this.root = path.resolve(deps.root);
  }

  async create(input: ExecutionSnapshotInput): Promise<ExecutionSnapshot> {
    const source = createSourceRevision(input.source);
    const recipeDigest = computeRecipeDigest(input.recipe);
    const executionInputHash = computeBuildKey(source, recipeDigest);
    const snapshotId = randomUUID();
    const ownershipNonce = randomBytes(24).toString("hex");
    const finalRoot = path.join(this.root, executionInputHash, snapshotId);
    const tempRoot = `${finalRoot}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    const sourceRoot = path.join(tempRoot, "source");
    const scratchRoot = path.join(tempRoot, "scratch");
    await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 });

    try {
      const rawFiles = await this.deps.listStateFiles(input.source.stateHash);
      await this.deps.verifyStateFiles?.(input.source.stateHash, rawFiles);
      const files = [...rawFiles]
        .map((file) => ({
          path: canonicalArtifactPath(file.path),
          contentHash: parseSha256(file.contentHash, `content hash for ${file.path}`),
          mode: normalizeSourceMode(file.mode, file.path),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      let previousPath: string | null = null;
      for (const file of files) {
        if (file.path === previousPath) {
          throw new Error(`Duplicate source path in execution state: ${file.path}`);
        }
        previousPath = file.path;
      }

      const manifestFiles: SnapshotManifest["files"] = [];
      for (const file of files) {
        const bytes = await this.deps.readBlob(file.contentHash);
        if (!bytes) {
          throw new Error(
            `Execution snapshot is incomplete: missing blob ${file.contentHash} for ${file.path}`
          );
        }
        if (sha256(bytes) !== file.contentHash) {
          throw new Error(`Execution snapshot blob failed verification: ${file.path}`);
        }
        const target = path.join(sourceRoot, ...file.path.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: file.mode });
        await fs.chmod(target, file.mode);
        manifestFiles.push({ ...file, size: bytes.byteLength });
      }
      await makeDirectoriesReadOnly(sourceRoot);

      const createdAt = Date.now();
      const manifest: SnapshotManifest = {
        version: 1,
        snapshotId,
        ownershipNonce,
        executionInputHash,
        source,
        recipeDigest,
        files: manifestFiles,
        createdAt,
      };
      const manifestPath = path.join(tempRoot, "snapshot.json");
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await fs.mkdir(path.dirname(finalRoot), { recursive: true, mode: 0o700 });
      await fs.rename(tempRoot, finalRoot);
      return {
        snapshotId,
        executionInputHash,
        source,
        recipeDigest,
        sourceRoot: path.join(finalRoot, "source"),
        scratchRoot: path.join(finalRoot, "scratch"),
        manifestPath: path.join(finalRoot, "snapshot.json"),
        createdAt,
      };
    } catch (error) {
      await makeDirectoriesWritable(sourceRoot).catch(() => undefined);
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      await fs.rmdir(path.dirname(tempRoot)).catch(() => undefined);
      throw error;
    }
  }

  async verify(snapshot: ExecutionSnapshot): Promise<void> {
    const root = this.snapshotRoot(snapshot);
    const manifest = await this.readManifest(path.join(root, "snapshot.json"));
    if (
      manifest.snapshotId !== snapshot.snapshotId ||
      manifest.executionInputHash !== snapshot.executionInputHash ||
      manifest.recipeDigest !== snapshot.recipeDigest
    ) {
      throw new Error(`Execution snapshot identity mismatch: ${snapshot.snapshotId}`);
    }
    for (const file of manifest.files) {
      const bytes = await fs.readFile(path.join(root, "source", ...file.path.split("/")));
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.contentHash) {
        throw new Error(`Execution snapshot file failed verification: ${file.path}`);
      }
    }
  }

  async release(snapshot: ExecutionSnapshot): Promise<void> {
    const root = this.snapshotRoot(snapshot);
    const manifest = await this.readManifest(path.join(root, "snapshot.json"));
    if (manifest.snapshotId !== snapshot.snapshotId) {
      throw new Error(`Refusing to release an unowned execution root: ${root}`);
    }
    await makeDirectoriesWritable(path.join(root, "source")).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: false });
    await fs.rmdir(path.dirname(root)).catch(() => undefined);
  }

  private snapshotRoot(snapshot: ExecutionSnapshot): string {
    const root = path.resolve(path.dirname(snapshot.manifestPath));
    const relative = path.relative(this.root, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Execution snapshot is outside the owned root: ${root}`);
    }
    return root;
  }

  private async readManifest(file: string): Promise<SnapshotManifest> {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as SnapshotManifest;
    if (
      parsed.version !== 1 ||
      typeof parsed.snapshotId !== "string" ||
      typeof parsed.ownershipNonce !== "string" ||
      !Array.isArray(parsed.files)
    ) {
      throw new Error(`Invalid execution snapshot manifest: ${file}`);
    }
    return parsed;
  }
}

function normalizeSourceMode(mode: number, filePath: string): 0o444 | 0o555 {
  if (mode === 33261 || (mode & 0o111) !== 0) return 0o555;
  if (mode === 33188 || (mode & 0o111) === 0) return 0o444;
  throw new Error(`Unsupported source mode for ${filePath}: ${mode}`);
}

async function makeDirectoriesReadOnly(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const child = path.join(root, entry.name);
        await makeDirectoriesReadOnly(child);
        await fs.chmod(child, 0o555);
      })
  );
  await fs.chmod(root, 0o555);
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  await fs.chmod(root, 0o700).catch(() => undefined);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => makeDirectoriesWritable(path.join(root, entry.name)))
  );
}
