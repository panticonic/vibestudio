import * as fs from "node:fs";
import * as path from "node:path";
import {
  canonicalSnapshotDigest,
  compareUtf16CodeUnits,
  sha256Hex,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import { encodeWorktreeTree, treeHashDigest } from "@vibestudio/shared/contentTree/treeObjects";
import type { ExactGitSnapshot, ExactSnapshotFile } from "@vibestudio/git";
import type { SnapshotContentSink } from "@vibestudio/git";
import { parseWorkspaceConfigContentWithId } from "@vibestudio/workspace/configParser";
import { validateRootTemplateSource } from "@vibestudio/workspace/rootTemplate";
import {
  canonicalTemplateYaml,
  readTemplateManifest,
  type ParsedTemplateManifest,
} from "@vibestudio/workspace/templateManifest";
import { TEMPLATE_SOURCE_MANIFEST_PATH } from "@vibestudio/workspace/templateCoordinates";
import { composeTemplateLayers } from "@vibestudio/workspace/templateComposition";
import { mergeTemplateManifests } from "@vibestudio/workspace/templateManifestMerge";
import {
  resolveTemplateDependencies,
  type ResolvedTemplateDependency,
} from "@vibestudio/workspace/templateDependencies";
import { WorkspaceCreationDescriptorSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import {
  buildHostBuildUnitInventory,
  hostBuildUnitInventoryPath,
} from "@vibestudio/shared/hostBuildUnits";
import { discoverRepos } from "./vcsHost/repoDiscovery.js";

function recordedLayers(receipt: unknown): MaterializedLayer[] {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return [];
  const layers = (receipt as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return [];
  return layers.filter(
    (layer): layer is MaterializedLayer =>
      Boolean(layer) &&
      typeof layer === "object" &&
      typeof (layer as MaterializedLayer).url === "string" &&
      typeof (layer as MaterializedLayer).ref === "string" &&
      typeof (layer as MaterializedLayer).commit === "string"
  );
}

/** One layer of a composed template root, in the order it was laid down. */
export interface ComposedTemplateLayer {
  url: string;
  ref: string;
  commit: string;
}

export interface ComposeDeclaredTemplateLayersInput {
  pin: WorkspaceTemplatePin;
  /** The already-acquired snapshot of `pin` itself. */
  root: ExactGitSnapshot;
  expectedSystemEpoch: number;
  acquire(pin: WorkspaceTemplatePin): Promise<ExactGitSnapshot>;
  resolveTrack?(address: {
    url: string;
    track: string;
    credential?: string;
  }): Promise<{ ref: string; commit: string }>;
}

/**
 * Lay any templates one template is built on underneath it, and merge what they
 * declare into the one manifest the composed workspace runs on.
 *
 * A standalone template takes none of this: its acquired snapshot is already
 * the tree, and round-tripping its manifest through a merge would only risk
 * changing it.
 *
 * This is the composition a workspace install performs, exposed on its own so
 * that anything reasoning about what a distribution actually runs — including
 * product trust decisions about its units — resolves the same tree rather than
 * a bare snapshot whose dependency closure is missing.
 */
export async function composeDeclaredTemplateLayers(
  input: ComposeDeclaredTemplateLayersInput
): Promise<{ snapshot: ExactGitSnapshot; layers: ComposedTemplateLayer[] }> {
  const { pin, root } = input;
  const readManifestOf = (snapshot: ExactGitSnapshot): ParsedTemplateManifest =>
    readTemplateManifest({
      readFile: (filePath) => snapshot.readFile(filePath),
      expectedSystemEpoch: input.expectedSystemEpoch,
    });
  const rootManifest = readManifestOf(root);
  if (rootManifest.dependencies.length === 0) {
    return { snapshot: root, layers: [{ url: pin.url, ref: pin.ref, commit: pin.commit }] };
  }
  const resolveTrack = input.resolveTrack;
  if (!resolveTrack) {
    throw new Error(
      `Root template ${pin.url} declares dependencies, but this host cannot resolve their tracks`
    );
  }
  const acquired = new Map<
    string,
    { pin: WorkspaceTemplatePin; snapshot: ExactGitSnapshot; manifest: ParsedTemplateManifest }
  >();
  const acquireLayer = async (
    layer: ResolvedTemplateDependency
  ): Promise<{
    pin: WorkspaceTemplatePin;
    snapshot: ExactGitSnapshot;
    manifest: ParsedTemplateManifest;
  }> => {
    const existing = acquired.get(layer.url);
    if (existing) return existing;
    const layerPin = {
      url: layer.url,
      ref: layer.ref,
      commit: layer.commit,
      ...(layer.credential ? { credential: layer.credential } : {}),
    } as WorkspaceTemplatePin;
    const snapshot = await input.acquire(layerPin);
    if (snapshot.commit !== layer.commit) {
      throw new Error(`Template dependency ${layer.url} acquired a different commit`);
    }
    const entry = { pin: layerPin, snapshot, manifest: readManifestOf(snapshot) };
    acquired.set(layer.url, entry);
    return entry;
  };
  const resolved = await resolveTemplateDependencies({
    root: { label: pin.url, dependencies: rootManifest.dependencies },
    resolveTrack,
    readDependencies: async (layer) => (await acquireLayer(layer)).manifest.dependencies,
  });
  // Dependency-first, with this template last: it is the one being installed.
  const stack = [
    ...resolved.layers.map((layer) => acquired.get(layer.url)!),
    { pin, snapshot: root, manifest: rootManifest },
  ];
  const merged = mergeTemplateManifests(
    stack.map((entry) => ({ label: entry.pin.url, manifest: entry.manifest }))
  );
  const manifestBytes = new TextEncoder().encode(canonicalTemplateYaml(merged.document));
  const composed = composeTemplateLayers({
    layers: stack.map((entry) => ({
      label: entry.pin.url,
      files: entry.snapshot.files,
      readFile: (filePath) => entry.snapshot.readFile(filePath),
    })),
    composedPaths: [TEMPLATE_SOURCE_MANIFEST_PATH],
  });
  const files = [
    ...composed.files,
    {
      path: TEMPLATE_SOURCE_MANIFEST_PATH,
      contentHash: sha256Hex(manifestBytes),
      size: manifestBytes.byteLength,
      mode: 0o644 as const,
    },
  ].sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
  const layers = stack.map((entry) => ({
    url: entry.pin.url,
    ref: entry.pin.ref,
    commit: entry.pin.commit,
  }));
  const snapshot: ExactGitSnapshot = {
    // The root's commit, which keys this materialization's staging paths. What
    // the workspace is made of is the recorded layers, not this one commit.
    commit: pin.commit,
    snapshot: canonicalSnapshotDigest(
      files.map((file) => ({
        path: file.path,
        mode: file.mode === 0o755 ? 0o100755 : 0o100644,
        size: file.size,
        contentHash: file.contentHash,
      }))
    ),
    files,
    readFile: (filePath) =>
      filePath === TEMPLATE_SOURCE_MANIFEST_PATH
        ? new Uint8Array(manifestBytes)
        : composed.readFile(filePath),
  };
  return { snapshot, layers };
}

/** One layer of a materialized workspace, in the order it was laid down. */
interface MaterializedLayer {
  url: string;
  ref: string;
  commit: string;
}

/**
 * What a workspace is made of.
 *
 * A composed workspace has no single commit to name it: its content is the
 * layers that went into it, and the dependencies among them normally float, so
 * the root's commit alone does not determine what was built. Recording the
 * resolved layers is therefore the identity, and it is recorded once — a
 * restart deliberately does not re-resolve, because re-resolving could pick up
 * a newer dependency and quietly replace a source the user has been editing.
 */
function materializationReceipt(layers: readonly MaterializedLayer[]): {
  version: number;
  layers: readonly MaterializedLayer[];
} {
  return { version: 2, layers };
}

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
  /**
   * Whether the host build designates this template as its own, and whether it
   * designated a local checkout rather than a fetched pin. Only a designated
   * template records host-build units, so a third-party template cannot claim
   * any of its units ship with Vibestudio.
   */
  designation?(pin: WorkspaceTemplatePin): { vouchesWholeTree: boolean } | null;
  /**
   * Resolve what a dependency's track selects right now. Required only once a
   * template declares dependencies; a standalone template never asks.
   */
  resolveTrack?(address: {
    url: string;
    track: string;
    credential?: string;
  }): Promise<{ ref: string; commit: string }>;
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
  private acquiredLayers: MaterializedLayer[] = [];

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
    const snapshot = this.acquiredSnapshot;
    if (!snapshot) throw new Error("Root template acquisition produced no source snapshot");
    this.materializeExactSource(snapshot);
    this.recordHostBuildUnits(this.preparedInitialization);
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

  /**
   * Lay any templates this one is built on underneath it, and merge what they
   * declare into the one manifest the composed workspace runs on.
   *
   * A standalone template — every template today — takes none of this: its
   * acquired snapshot is already the tree, and round-tripping its manifest
   * through a merge would only risk changing it.
   */
  private async composeDeclaredLayers(
    pin: WorkspaceTemplatePin,
    root: ExactGitSnapshot
  ): Promise<ExactGitSnapshot> {
    const composed = await composeDeclaredTemplateLayers({
      pin,
      root,
      expectedSystemEpoch: this.deps.expectedSystemEpoch,
      acquire: (layerPin) => this.deps.acquire(layerPin),
      ...(this.deps.resolveTrack ? { resolveTrack: this.deps.resolveTrack } : {}),
    });
    this.acquiredLayers = composed.layers;
    return composed.snapshot;
  }
  private async acquireInitialization(
    pin: WorkspaceTemplatePin
  ): Promise<PreparedRootTemplateInitialization> {
    const acquired = await this.deps.acquire(pin);
    if (acquired.commit !== pin.commit) {
      throw new Error(
        `Root template acquisition returned coordinates different from the creation descriptor`
      );
    }
    const snapshot = await this.composeDeclaredLayers(pin, acquired);
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
    validateRootTemplateSource({
      workspaceId: this.deps.workspaceId,
      expectedSystemEpoch: this.deps.expectedSystemEpoch,
      readFile: (filePath) => snapshot.readFile(filePath),
      snapshotPaths: snapshot.files.map((file) => file.path),
      repositories,
    });
    await publishRepositoryContentTrees(repositories, this.deps.sink);
    this.acquiredSnapshot = snapshot;
    return {
      pin,
      repositories,
    };
  }

  private validateMaterializedSource(pin: WorkspaceTemplatePin): boolean {
    const receiptPath = path.join(this.deps.statePath, MATERIALIZATION_RECEIPT_PATH);
    if (!fs.existsSync(receiptPath)) return false;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as unknown;
    const recorded = recordedLayers(receipt);
    // The template being installed is the last layer, and it is the only one
    // the creation descriptor names. Its dependencies were resolved once and
    // recorded here; taking them from the receipt rather than resolving again
    // is what keeps a restart from picking up a newer dependency and replacing
    // a source the user has been editing.
    if (recorded.at(-1)?.commit !== pin.commit) {
      throw new Error("Workspace root materialization receipt does not match its exact pin");
    }
    this.acquiredLayers = [...recorded];
    const manifestPath = path.join(this.deps.sourcePath, WORKSPACE_MANIFEST_PATH);
    if (!fs.existsSync(manifestPath)) {
      throw new Error("Workspace root materialization receipt exists but its source is missing");
    }
    parseWorkspaceConfigContentWithId(fs.readFileSync(manifestPath, "utf8"), this.deps.workspaceId);
    return true;
  }

  private materializeExactSource(snapshot: ExactGitSnapshot): void {
    const receiptPath = path.join(this.deps.statePath, MATERIALIZATION_RECEIPT_PATH);
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
    this.writeMaterializationReceipt(receiptPath);
  }

  private writeMaterializationReceipt(receiptPath: string): void {
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify(materializationReceipt(this.acquiredLayers), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    fs.renameSync(temporary, receiptPath);
  }

  /**
   * Record which units this template shipped, from the tree just laid down.
   *
   * Written once beside the creation descriptor rather than recomputed, because
   * a restart deliberately does not reacquire the template — the materialized
   * source is the receipt, and the original remote need not still be reachable.
   */
  private recordHostBuildUnits(initialization: PreparedRootTemplateInitialization): void {
    const inventoryPath = hostBuildUnitInventoryPath(this.deps.statePath);
    const designation = this.deps.designation?.(initialization.pin);
    if (!designation) {
      // Nothing here ships with Vibestudio, so leave nothing behind that a
      // later read could mistake for an answer.
      fs.rmSync(inventoryPath, { force: true });
      return;
    }
    const inventory = buildHostBuildUnitInventory({
      root: this.deps.sourcePath,
      unitRepoPaths: initialization.repositories.map((repository) => repository.repoPath),
      templateUrl: initialization.pin.url,
      commit: initialization.pin.commit,
      ...(designation.vouchesWholeTree ? { vouchesWholeTree: true } : {}),
    });
    fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
    const temporary = `${inventoryPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(inventory, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, inventoryPath);
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
