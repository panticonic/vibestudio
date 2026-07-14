import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  canonicalArtifactPath,
  computeRecipeDigest,
  createExecutionArtifactRef,
  parseSha256,
  sha256,
  verifyExecutionArtifactRef,
  type ArtifactBundleEntry,
  type ArtifactManifest,
  type BuildRecipe,
  type ExecutionArtifactRef,
  type Sha256,
  type SourceRevisionRef,
} from "@vibestudio/shared/execution/identity";

export interface StoredExecutionArtifact {
  version: 1;
  ref: ExecutionArtifactRef;
  manifest: ArtifactManifest;
  recipe: BuildRecipe;
  createdAt: number;
}

interface ArtifactIndex {
  version: 1;
  executions: Record<string, { recordDir: string }>;
  sourceRecipes: Record<string, string>;
  buildKeys: Record<string, string>;
}

interface GcState {
  version: 1;
  unmarkedEpochs: Record<string, number>;
}

export interface ArtifactRetentionRoot {
  kind:
    | "active-incarnation"
    | "retained-incarnation"
    | "upgrade-transition"
    | "app-version"
    | "code-grant"
    | "bootstrap-manifest"
    | "build-lease"
    | "diagnostic";
  id: string;
  executionDigest: Sha256;
}

export interface ArtifactCollectionPlan {
  retained: Array<{ executionDigest: Sha256; roots: ArtifactRetentionRoot[] }>;
  eligible: Array<{ executionDigest: Sha256; unmarkedEpochs: number }>;
}

const INDEX_FILE = "index.json";
const GC_FILE = "gc.json";

/**
 * Immutable execution-artifact authority. It stores the complete verified
 * record and emitted bytes, and owns both recovery indexes. A cache miss never
 * rebuilds from a moving head.
 */
export class ExecutionArtifactStore {
  private readonly root: string;
  private readonly recordsRoot: string;
  private index: ArtifactIndex;
  private verified = new Set<string>();

  constructor(root: string) {
    this.root = path.resolve(root);
    this.recordsRoot = path.join(this.root, "records");
    fs.mkdirSync(this.recordsRoot, { recursive: true, mode: 0o700 });
    this.index = this.loadIndex();
    this.reconcileRecords();
  }

  put(input: {
    source: SourceRevisionRef;
    recipe: BuildRecipe;
    entries: readonly ArtifactBundleEntry[];
    createdAt?: number;
  }): ExecutionArtifactRef {
    const computed = createExecutionArtifactRef(input);
    const digest = computed.ref.executionDigest;
    const existing = this.index.executions[digest];
    if (existing) {
      const loaded = this.get(digest);
      if (!loaded) throw new Error(`Indexed execution artifact ${digest} is missing`);
      return loaded.ref;
    }

    const sourceRecipeKey = this.sourceRecipeKey(computed.ref.source, computed.ref.recipeDigest);
    const indexedForSource = this.index.sourceRecipes[sourceRecipeKey];
    if (indexedForSource && indexedForSource !== digest) {
      throw new Error(
        `Non-reproducible build: source/recipe already maps to ${indexedForSource}, produced ${digest}`
      );
    }
    const indexedForBuild = this.index.buildKeys[computed.ref.buildKey];
    if (indexedForBuild && indexedForBuild !== digest) {
      throw new Error(
        `Build key collision: ${computed.ref.buildKey} maps to ${indexedForBuild}, produced ${digest}`
      );
    }

    const recordDirName = digest;
    const finalDir = path.join(this.recordsRoot, recordDirName);
    const tempDir = `${finalDir}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    fs.mkdirSync(path.join(tempDir, "bundle"), { recursive: true, mode: 0o700 });
    try {
      for (const entry of input.entries) {
        const relative = canonicalArtifactPath(entry.path);
        const target = path.join(tempDir, "bundle", ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, entry.bytes, { mode: entry.mode });
        fs.chmodSync(target, entry.mode);
      }
      const record: StoredExecutionArtifact = {
        version: 1,
        ref: computed.ref,
        manifest: computed.manifest,
        recipe: input.recipe,
        createdAt: input.createdAt ?? Date.now(),
      };
      fs.writeFileSync(path.join(tempDir, "record.json"), JSON.stringify(record, null, 2), {
        mode: 0o600,
      });
      try {
        fs.renameSync(tempDir, finalDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }

    this.index = {
      version: 1,
      executions: {
        ...this.index.executions,
        [digest]: { recordDir: recordDirName },
      },
      sourceRecipes: { ...this.index.sourceRecipes, [sourceRecipeKey]: digest },
      buildKeys: { ...this.index.buildKeys, [computed.ref.buildKey]: digest },
    };
    this.persistIndex();
    this.verified.add(digest);
    return computed.ref;
  }

  get(executionDigest: string): StoredExecutionArtifact | null {
    const digest = parseSha256(executionDigest, "execution digest");
    const entry = this.index.executions[digest];
    if (!entry) return null;
    const recordPath = path.join(this.recordsRoot, entry.recordDir, "record.json");
    const record = this.readRecord(recordPath);
    if (record.ref.executionDigest !== digest) {
      throw new Error(`Execution index mismatch for ${digest}`);
    }
    if (!this.verified.has(digest)) {
      this.verifyRecordBytes(record, path.dirname(recordPath));
      this.verified.add(digest);
    }
    return record;
  }

  resolve(source: SourceRevisionRef, recipe: BuildRecipe): StoredExecutionArtifact | null {
    const recipeDigest = computeRecipeDigest(recipe);
    const execution = this.index.sourceRecipes[this.sourceRecipeKey(source, recipeDigest)];
    return execution ? this.get(execution) : null;
  }

  getByBuildKey(buildKey: string): StoredExecutionArtifact | null {
    const key = parseSha256(buildKey, "build key");
    const execution = this.index.buildKeys[key];
    return execution ? this.get(execution) : null;
  }

  artifactPath(executionDigest: string, artifactPath: string): string {
    const record = this.get(executionDigest);
    if (!record) throw new Error(`Unknown execution artifact: ${executionDigest}`);
    const relative = canonicalArtifactPath(artifactPath);
    if (!record.manifest.entries.some((entry) => entry.path === relative)) {
      throw new Error(`Artifact ${relative} is not declared by ${executionDigest}`);
    }
    const indexEntry = this.index.executions[record.ref.executionDigest];
    if (!indexEntry) {
      throw new Error(`Execution artifact index changed while reading ${executionDigest}`);
    }
    return path.join(this.recordsRoot, indexEntry.recordDir, "bundle", ...relative.split("/"));
  }

  readBundle(executionDigest: string): {
    record: StoredExecutionArtifact;
    entries: ArtifactBundleEntry[];
  } {
    const record = this.get(executionDigest);
    if (!record) throw new Error(`Unknown execution artifact: ${executionDigest}`);
    return {
      record,
      entries: record.manifest.entries.map((entry) => ({
        path: entry.path,
        role: entry.role,
        mode: entry.mode,
        contentType: entry.contentType,
        bytes: fs.readFileSync(this.artifactPath(executionDigest, entry.path)),
      })),
    };
  }

  list(): ExecutionArtifactRef[] {
    return Object.keys(this.index.executions)
      .sort()
      .map((digest) => this.get(digest)?.ref)
      .filter((ref): ref is ExecutionArtifactRef => ref !== undefined && ref !== null);
  }

  explainRetention(
    roots: readonly ArtifactRetentionRoot[],
    graceEpochs = 2
  ): ArtifactCollectionPlan {
    if (!Number.isInteger(graceEpochs) || graceEpochs < 1) {
      throw new Error("Artifact grace epochs must be a positive integer");
    }
    const byDigest = new Map<string, ArtifactRetentionRoot[]>();
    for (const root of roots) {
      const digest = parseSha256(root.executionDigest, `retention root ${root.id}`);
      if (!this.index.executions[digest]) {
        throw new Error(`Retention root ${root.kind}:${root.id} names missing artifact ${digest}`);
      }
      const found = byDigest.get(digest) ?? [];
      found.push({ ...root, executionDigest: digest });
      byDigest.set(digest, found);
    }
    const state = this.loadGcState();
    const retained: ArtifactCollectionPlan["retained"] = [];
    const eligible: ArtifactCollectionPlan["eligible"] = [];
    for (const rawDigest of Object.keys(this.index.executions).sort()) {
      const digest = rawDigest as Sha256;
      const matchingRoots = byDigest.get(digest);
      if (matchingRoots?.length) {
        retained.push({ executionDigest: digest, roots: matchingRoots });
        continue;
      }
      const unmarkedEpochs = (state.unmarkedEpochs[digest] ?? 0) + 1;
      if (unmarkedEpochs >= graceEpochs) eligible.push({ executionDigest: digest, unmarkedEpochs });
    }
    return { retained, eligible };
  }

  collect(
    roots: readonly ArtifactRetentionRoot[],
    options: { graceEpochs?: number; dryRun?: boolean } = {}
  ): ArtifactCollectionPlan {
    const graceEpochs = options.graceEpochs ?? 2;
    const plan = this.explainRetention(roots, graceEpochs);
    if (options.dryRun) return plan;

    const retained = new Set(plan.retained.map((item) => item.executionDigest));
    const eligible = new Set(plan.eligible.map((item) => item.executionDigest));
    const previous = this.loadGcState();
    const nextGc: GcState = { version: 1, unmarkedEpochs: {} };
    for (const digest of Object.keys(this.index.executions)) {
      if (retained.has(digest as Sha256)) continue;
      if (!eligible.has(digest as Sha256)) {
        nextGc.unmarkedEpochs[digest] = (previous.unmarkedEpochs[digest] ?? 0) + 1;
        continue;
      }
      const entry = this.index.executions[digest];
      if (!entry) throw new Error(`Execution artifact index changed during collection: ${digest}`);
      fs.rmSync(path.join(this.recordsRoot, entry.recordDir), { recursive: true, force: true });
      this.verified.delete(digest);
    }
    this.index = {
      version: 1,
      executions: Object.fromEntries(
        Object.entries(this.index.executions).filter(([digest]) => !eligible.has(digest as Sha256))
      ),
      sourceRecipes: Object.fromEntries(
        Object.entries(this.index.sourceRecipes).filter(
          ([, digest]) => !eligible.has(digest as Sha256)
        )
      ),
      buildKeys: Object.fromEntries(
        Object.entries(this.index.buildKeys).filter(([, digest]) => !eligible.has(digest as Sha256))
      ),
    };
    this.persistIndex();
    this.writeAtomicJson(path.join(this.root, GC_FILE), nextGc);
    return plan;
  }

  private sourceRecipeKey(source: SourceRevisionRef, recipeDigest: Sha256): string {
    return `${source.repoPath}\0${parseSha256(source.stateHash)}\0${parseSha256(source.sourceEv)}\0${parseSha256(recipeDigest)}`;
  }

  private verifyRecordBytes(record: StoredExecutionArtifact, recordDir: string): void {
    verifyExecutionArtifactRef(record.ref);
    if (computeRecipeDigest(record.recipe) !== record.ref.recipeDigest) {
      throw new Error(`Stored recipe digest mismatch for ${record.ref.executionDigest}`);
    }
    const entries: ArtifactBundleEntry[] = record.manifest.entries.map((entry) => {
      const filePath = path.join(
        recordDir,
        "bundle",
        ...canonicalArtifactPath(entry.path).split("/")
      );
      const bytes = fs.readFileSync(filePath);
      const stat = fs.statSync(filePath);
      if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.digest) {
        throw new Error(`Artifact bytes failed verification: ${entry.path}`);
      }
      const mode = (stat.mode & 0o111) !== 0 ? 0o755 : 0o644;
      if (mode !== entry.mode) throw new Error(`Artifact mode failed verification: ${entry.path}`);
      return {
        path: entry.path,
        role: entry.role,
        mode,
        contentType: entry.contentType,
        bytes,
      };
    });
    const recomputed = createExecutionArtifactRef({
      source: record.ref.source,
      recipe: record.recipe,
      entries,
    });
    if (recomputed.ref.executionDigest !== record.ref.executionDigest) {
      throw new Error(`Stored artifact digest mismatch for ${record.ref.executionDigest}`);
    }
  }

  private readRecord(filePath: string): StoredExecutionArtifact {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read execution artifact record ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
      throw new Error(`Unsupported execution artifact record format: ${filePath}`);
    }
    return value as StoredExecutionArtifact;
  }

  private loadIndex(): ArtifactIndex {
    const file = path.join(this.root, INDEX_FILE);
    if (!fs.existsSync(file)) {
      return { version: 1, executions: {}, sourceRecipes: {}, buildKeys: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ArtifactIndex;
    if (parsed.version !== 1 || !parsed.executions || !parsed.sourceRecipes || !parsed.buildKeys) {
      throw new Error(`Unsupported execution artifact index format: ${file}`);
    }
    return parsed;
  }

  /**
   * Complete an interrupted record/index commit. Artifact directories are the
   * immutable authority; the compact index is a recoverable projection.
   */
  private reconcileRecords(): void {
    const recovered: ArtifactIndex = {
      version: 1,
      executions: {},
      sourceRecipes: {},
      buildKeys: {},
    };
    for (const recordDir of fs.readdirSync(this.recordsRoot).sort()) {
      if (recordDir.includes(".tmp.")) continue;
      const fullDir = path.join(this.recordsRoot, recordDir);
      if (!fs.statSync(fullDir).isDirectory()) continue;
      const record = this.readRecord(path.join(fullDir, "record.json"));
      this.verifyRecordBytes(record, fullDir);
      const digest = record.ref.executionDigest;
      if (recordDir !== digest) {
        throw new Error(`Execution artifact directory mismatch: ${recordDir} != ${digest}`);
      }
      const sourceRecipe = this.sourceRecipeKey(record.ref.source, record.ref.recipeDigest);
      const priorSource = recovered.sourceRecipes[sourceRecipe];
      if (priorSource && priorSource !== digest) {
        throw new Error(`Non-reproducible artifacts in store: ${priorSource} and ${digest}`);
      }
      const priorBuild = recovered.buildKeys[record.ref.buildKey];
      if (priorBuild && priorBuild !== digest) {
        throw new Error(`Build key collision in store: ${priorBuild} and ${digest}`);
      }
      recovered.executions[digest] = { recordDir };
      recovered.sourceRecipes[sourceRecipe] = digest;
      recovered.buildKeys[record.ref.buildKey] = digest;
      this.verified.add(digest);
    }
    if (JSON.stringify(recovered) !== JSON.stringify(this.index)) {
      this.index = recovered;
      this.persistIndex();
    }
  }

  private loadGcState(): GcState {
    const file = path.join(this.root, GC_FILE);
    if (!fs.existsSync(file)) return { version: 1, unmarkedEpochs: {} };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as GcState;
    if (parsed.version !== 1 || !parsed.unmarkedEpochs) {
      throw new Error(`Unsupported execution artifact GC format: ${file}`);
    }
    return parsed;
  }

  private persistIndex(): void {
    this.writeAtomicJson(path.join(this.root, INDEX_FILE), this.index);
  }

  private writeAtomicJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
}
