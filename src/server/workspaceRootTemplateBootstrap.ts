import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import { encodeWorktreeTree, treeHashDigest } from "@vibestudio/shared/contentTree/treeObjects";
import type { ExactGitSnapshot, ExactSnapshotFile } from "@vibestudio/git";
import type { SnapshotContentSink } from "@vibestudio/git";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import { prepareRootTemplateMetadata } from "@vibestudio/workspace/rootTemplate";
import { WorkspaceCreationDescriptorSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import { discoverRepos } from "./vcsHost/repoDiscovery.js";

const CREATION_DESCRIPTOR_PATH = "workspace-creation/v1.json";
const MATERIALIZATION_RECEIPT_PATH = "workspace-creation/materialization-v1.json";
const WORKSPACE_MANIFEST_PATH = "meta/vibestudio.yml";

export interface RootTemplateRepository {
  repoPath: string;
  subdir: string;
  snapshot: CanonicalSnapshotDigest;
  contentRoot: `state:${string}`;
  files: ExactSnapshotFile[];
}

export interface PreparedRootTemplateInitialization {
  pin: WorkspaceTemplatePin;
  repositories: RootTemplateRepository[];
}

export interface WorkspaceRootTemplateBootstrapDeps {
  workspaceId: string;
  statePath: string;
  sourcePath: string;
  acquire(pin: WorkspaceTemplatePin): Promise<ExactGitSnapshot>;
  sink: SnapshotContentSink;
  expectedSystemEpoch: number;
}

function repositorySnapshot(files: readonly ExactSnapshotFile[]): CanonicalSnapshotDigest {
  return canonicalSnapshotDigest(
    files.map((file) => ({
      path: file.path,
      mode: file.mode === 0o755 ? 0o100755 : 0o100644,
      size: file.size,
      contentHash: file.contentHash,
    }))
  );
}

function repositoryContentTree(files: readonly ExactSnapshotFile[]) {
  return encodeWorktreeTree(
    files.map((file) => ({
      path: file.path,
      contentHash: file.contentHash,
      mode: file.mode === 0o755 ? 0o100755 : 0o100644,
    }))
  );
}

async function publishRepositoryContentTrees(
  repositories: readonly RootTemplateRepository[],
  sink: SnapshotContentSink
): Promise<void> {
  const pending = repositories[Symbol.iterator]();
  const publishNext = async (): Promise<void> => {
    for (let entry = pending.next(); !entry.done; entry = pending.next()) {
      const repository = entry.value;
      const encoded = repositoryContentTree(repository.files);
      if (encoded.stateHash !== repository.contentRoot) {
        throw new Error(
          `Root template repository ${repository.repoPath} changed while publishing its content tree`
        );
      }
      // Nodes are child-first and the state pointer is published last. Thus a
      // visible state object always implies a complete reconstructable tree.
      for (const node of encoded.nodes) {
        const stored = await sink.put(new TextEncoder().encode(node.canonicalText));
        if (stored.digest !== treeHashDigest(node.treeHash)) {
          throw new Error(`Content sink changed the tree identity for ${repository.repoPath}`);
        }
      }
      const state = await sink.put(new TextEncoder().encode(encoded.stateNode.canonicalText));
      if (state.digest !== treeHashDigest(encoded.stateHash)) {
        throw new Error(`Content sink changed the state identity for ${repository.repoPath}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, repositories.length) }, () => publishNext()));
}

/**
 * Split one verified root snapshot into the semantic repositories it contains.
 * Files outside workspace source sections are repository tooling and remain
 * outside the imported workspace tree.
 */
export function enumerateRootTemplateRepositories(
  snapshot: ExactGitSnapshot
): RootTemplateRepository[] {
  const repositories: RootTemplateRepository[] = [];
  for (const repository of discoverRepos(snapshot.files.map((file) => file.path))) {
    const prefix = repository.repoPath === "meta" ? "meta/" : `${repository.repoPath}/`;
    const files = snapshot.files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
      .sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    const contentTree = repositoryContentTree(files);
    repositories.push({
      repoPath: repository.repoPath,
      subdir: repository.repoPath,
      snapshot: repositorySnapshot(files),
      contentRoot: contentTree.stateHash as `state:${string}`,
      files,
    });
  }
  return repositories;
}

/**
 * The entire host-side template boundary: if workspace creation carries one
 * exact root pin, acquire that one immutable snapshot and expose its ordinary
 * workspace repositories for the initial semantic publication. There is no
 * dependency walk, lock generation, layering, conflict policy, or lifecycle
 * state here; those begin only after the imported workspace can run userland.
 */
export class WorkspaceRootTemplateBootstrap {
  private readonly descriptorPath: string;
  private preparedInitialization: PreparedRootTemplateInitialization | null = null;
  private acquiredSnapshot: ExactGitSnapshot | null = null;
  private generatedSourceFiles = new Map<string, Uint8Array>();

  constructor(private readonly deps: WorkspaceRootTemplateBootstrapDeps) {
    this.descriptorPath = path.join(deps.statePath, CREATION_DESCRIPTOR_PATH);
  }

  /**
   * Ensure the exact root is present for the first startup. Once the local
   * materialization receipt exists, restart no longer depends on the original
   * remote template being reachable.
   */
  async prepareSource(): Promise<WorkspaceTemplatePin> {
    const descriptor = this.readDescriptor();
    if (this.preparedInitialization) return this.preparedInitialization.pin;
    if (this.validateMaterializedSource(descriptor.rootTemplate)) {
      return descriptor.rootTemplate;
    }
    const startedAt = performance.now();
    this.preparedInitialization = await this.acquireInitialization(descriptor.rootTemplate);
    const acquiredAt = performance.now();
    this.materializeExactSource(this.acquiredSnapshot!);
    const materializedAt = performance.now();
    if (materializedAt - startedAt >= 100) {
      console.log("[Perf] root template preparation", {
        acquireMs: acquiredAt - startedAt,
        materializeMs: materializedAt - acquiredAt,
        totalMs: materializedAt - startedAt,
      });
    }
    return this.preparedInitialization.pin;
  }

  async prepareInitialization(): Promise<PreparedRootTemplateInitialization> {
    const pin = await this.prepareSource();
    if (!this.preparedInitialization) {
      // Crash recovery after source materialization but before the provider
      // recorded its initialization receipt still needs the exact repository
      // plan. This is the only restart path that reacquires the root.
      this.preparedInitialization = await this.acquireInitialization(pin);
    }
    return this.preparedInitialization;
  }

  private async acquireInitialization(
    pin: WorkspaceTemplatePin
  ): Promise<PreparedRootTemplateInitialization> {
    const snapshot = await this.deps.acquire(pin);
    if (snapshot.commit !== pin.commit || snapshot.snapshot !== pin.snapshot) {
      throw new Error(
        `Root template acquisition returned coordinates different from the creation descriptor`
      );
    }
    const manifestBytes = snapshot.readFile(WORKSPACE_MANIFEST_PATH);
    if (!manifestBytes) {
      throw new Error(`Root template is missing ${WORKSPACE_MANIFEST_PATH}`);
    }
    const manifest = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    parseWorkspaceConfigContentWithId(manifest, this.deps.workspaceId);
    const repositories = enumerateRootTemplateRepositories(snapshot);
    if (!repositories.some((repository) => repository.repoPath === "meta")) {
      throw new Error(`Root template has no importable meta repository`);
    }
    for (const file of snapshot.files) {
      if (
        file.path === "meta/templates.state.yml" ||
        file.path === "meta/templates.lock.yml" ||
        file.path.startsWith("meta/templates/")
      ) {
        throw new Error(`Root release contains installed workspace state at ${file.path}`);
      }
    }
    const metadata = prepareRootTemplateMetadata({
      pin,
      workspaceId: this.deps.workspaceId,
      expectedSystemEpoch: this.deps.expectedSystemEpoch,
      readFile: (filePath) => snapshot.readFile(filePath),
      snapshotPaths: snapshot.files.map((file) => file.path),
      repositories,
    });
    this.generatedSourceFiles = new Map([
      ["meta/templates/workspace.yml", new TextEncoder().encode(metadata.sourceYaml)],
      ["meta/templates.state.yml", new TextEncoder().encode(metadata.stateYaml)],
    ]);
    const meta = repositories.find((repository) => repository.repoPath === "meta")!;
    for (const [filePath, bytes] of this.generatedSourceFiles) {
      const stored = await this.deps.sink.put(bytes);
      const relativePath = filePath.slice("meta/".length);
      meta.files.push({
        path: relativePath,
        contentHash: stored.digest,
        size: stored.size,
        mode: 0o644,
      });
    }
    meta.files.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    meta.snapshot = repositorySnapshot(meta.files);
    meta.contentRoot = repositoryContentTree(meta.files).stateHash as `state:${string}`;
    await publishRepositoryContentTrees(repositories, this.deps.sink);
    this.acquiredSnapshot = snapshot;
    return {
      pin,
      repositories,
    };
  }

  private validateMaterializedSource(pin: WorkspaceTemplatePin): boolean {
    const receiptPath = path.join(this.deps.statePath, MATERIALIZATION_RECEIPT_PATH);
    const expectedReceipt = {
      version: 1,
      commit: pin.commit,
      snapshot: pin.snapshot,
    };
    if (!fs.existsSync(receiptPath)) return false;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as unknown;
    if (canonicalJsonValue(receipt) !== canonicalJsonValue(expectedReceipt)) {
      throw new Error("Workspace root materialization receipt does not match its exact pin");
    }
    const manifestPath = path.join(this.deps.sourcePath, WORKSPACE_MANIFEST_PATH);
    if (!fs.existsSync(manifestPath)) {
      throw new Error("Workspace root materialization receipt exists but its source is missing");
    }
    parseWorkspaceConfigContentWithId(fs.readFileSync(manifestPath, "utf8"), this.deps.workspaceId);
    return true;
  }

  private materializeExactSource(snapshot: ExactGitSnapshot): void {
    const receiptPath = path.join(this.deps.statePath, MATERIALIZATION_RECEIPT_PATH);
    const expectedReceipt = {
      version: 1,
      commit: snapshot.commit,
      snapshot: snapshot.snapshot,
    };
    const parent = path.dirname(this.deps.sourcePath);
    const basename = path.basename(this.deps.sourcePath);
    const operationKey = snapshot.commit.slice(0, 16);
    const staging = path.join(parent, `.${basename}.bootstrap-${operationKey}`);
    const backup = path.join(parent, `.${basename}.pre-bootstrap-${operationKey}`);
    this.recoverMaterializationPaths(staging, backup);
    if (fs.existsSync(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    fs.mkdirSync(staging, { recursive: false });
    for (const file of snapshot.files) {
      const destination = safeSnapshotDestination(staging, file.path);
      const bytes = snapshot.readFile(file.path);
      if (!bytes) throw new Error(`Exact root snapshot cannot read ${file.path}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, {
        mode: file.mode === 0o755 ? 0o755 : 0o644,
        flag: "wx",
      });
    }
    for (const [filePath, bytes] of this.generatedSourceFiles) {
      const destination = safeSnapshotDestination(staging, filePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { mode: 0o644, flag: "wx" });
    }
    parseWorkspaceConfigContentWithId(
      fs.readFileSync(path.join(staging, WORKSPACE_MANIFEST_PATH), "utf8"),
      this.deps.workspaceId
    );
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(this.deps.sourcePath, backup);
    try {
      fs.renameSync(staging, this.deps.sourcePath);
    } catch (error) {
      if (!fs.existsSync(this.deps.sourcePath) && fs.existsSync(backup)) {
        fs.renameSync(backup, this.deps.sourcePath);
      }
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const temporaryReceipt = `${receiptPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryReceipt, `${JSON.stringify(expectedReceipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryReceipt, receiptPath);
  }

  private recoverMaterializationPaths(staging: string, backup: string): void {
    if (!fs.existsSync(this.deps.sourcePath) && fs.existsSync(staging)) {
      fs.renameSync(staging, this.deps.sourcePath);
    }
    if (!fs.existsSync(this.deps.sourcePath) && fs.existsSync(backup)) {
      fs.renameSync(backup, this.deps.sourcePath);
    }
    if (fs.existsSync(this.deps.sourcePath) && fs.existsSync(backup)) {
      fs.rmSync(backup, { recursive: true, force: true });
    }
  }

  /**
   * The exact root this workspace was created from, when it came from one.
   *
   * The creation review heads with where the code came from, so it needs the
   * pin — and only the parts of it a person can read: the URL and the human
   * ref. The commit stays here, in the descriptor, for audit.
   */
  readDescriptor(): WorkspaceCreationDescriptor {
    if (!fs.existsSync(this.descriptorPath)) {
      throw new Error(
        `Workspace is missing its current creation descriptor at ${CREATION_DESCRIPTOR_PATH}`
      );
    }
    const descriptor = WorkspaceCreationDescriptorSchema.parse(
      JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"))
    );
    if (descriptor.workspaceId !== this.deps.workspaceId) {
      throw new Error(
        `Workspace creation descriptor belongs to ${descriptor.workspaceId}, expected ${this.deps.workspaceId}`
      );
    }
    return descriptor;
  }
}

function safeSnapshotDestination(root: string, relativePath: string): string {
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Root snapshot contains an invalid path ${JSON.stringify(relativePath)}`);
  }
  const destination = path.resolve(root, relativePath);
  const resolvedRoot = path.resolve(root);
  if (!destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Root snapshot path escapes its materialization root: ${relativePath}`);
  }
  return destination;
}

function canonicalJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
