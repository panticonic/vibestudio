import { logVerbose } from "@vibestudio/dev-log";
import { forEachOwnedConcurrent } from "../../scripts/lib/owned-concurrency.mjs";
import { intrinsicContentDescriptor, type ContentDescriptor } from "@vibestudio/content-addressing";
import type { PreparedWorkspaceTemplate } from "./preparedWorkspaceTemplate.js";
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
  templateManifestDocument,
  templateRepositories,
  readTemplateManifest,
  type ParsedTemplateManifest,
} from "@vibestudio/workspace/templateManifest";
import {
  TEMPLATE_SOURCE_MANIFEST_PATH,
  normalizeTemplateGitUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { composeTemplateLayers } from "@vibestudio/workspace/templateComposition";
import {
  mergeTemplateManifests,
  templateRepositoryOwners,
} from "@vibestudio/workspace/templateManifestMerge";
import {
  resolveTemplateDependencies,
  type ResolvedTemplateDependency,
} from "@vibestudio/workspace/templateDependencies";
import { WorkspaceCreationDescriptorSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import type {
  WorkspaceCreationDescriptor,
  WorkspaceTemplatePin,
  WorkspaceTemplateInstallation,
} from "@vibestudio/workspace-contracts/types";
import {
  buildHostBuildUnitInventory,
  hostBuildUnitInventoryPath,
} from "@vibestudio/shared/hostBuildUnits";
import { discoverRepos } from "@vibestudio/shared/runtime/repoDiscovery";

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
  /** Exact pins composing the default host release; custom roots retain their declared tracks. */
  releaseTemplates?: readonly WorkspaceTemplatePin[];
  pin: WorkspaceTemplatePin;
  purpose?: "use" | "author";
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

/** An exact admitted Git tree can resolve composition from its manifest and
 * path inventory without loading every source blob. Full snapshots implement
 * this same boundary; indexed Git trees may read the manifest asynchronously. */
export interface TemplateLayerMetadata {
  readonly commit: string;
  readonly files: readonly { readonly path: string }[];
  readFile(filePath: string): Uint8Array | null | Promise<Uint8Array | null>;
}

export interface ResolvedTemplateLayerPlan {
  readonly pin: WorkspaceTemplatePin;
  readonly purpose: "use" | "author";
  readonly expectedSystemEpoch: number;
  /** Exact dependency-first order, with the requested root last. */
  readonly layers: readonly {
    readonly pin: WorkspaceTemplatePin;
    readonly manifestText: string;
    readonly repositories: readonly string[];
    readonly dependencies: ParsedTemplateManifest["dependencies"];
  }[];
  readonly dependencies: readonly ResolvedTemplateDependency[];
  readonly document: Record<string, unknown>;
  readonly repositoryOwners: readonly { readonly repoPath: string; readonly source: string }[];
}

export interface ResolveDeclaredTemplateLayerPlanInput extends Omit<
  ComposeDeclaredTemplateLayersInput,
  "root" | "acquire"
> {
  root: TemplateLayerMetadata;
  acquire(pin: WorkspaceTemplatePin): Promise<TemplateLayerMetadata>;
}

/**
 * Lay any templates one template is built on underneath it, and merge what they
 * declare into the one manifest the composed workspace runs on.
 *
 * Every installed tree records the exact source pins used to compose it.
 * This supplies the baseline for subsequent three-way template updates.
 *
 * This is the composition a workspace install performs, exposed on its own so
 * that anything reasoning about what a template actually runs — including
 * product trust decisions about its units — resolves the same tree rather than
 * a bare snapshot whose dependency closure is missing.
 */
export async function resolveDeclaredTemplateLayerPlan(
  input: ResolveDeclaredTemplateLayerPlanInput
): Promise<ResolvedTemplateLayerPlan> {
  const { pin, root, purpose = "use" } = input;
  const readLayer = async (layerPin: WorkspaceTemplatePin, metadata: TemplateLayerMetadata) => {
    if (metadata.commit !== layerPin.commit)
      throw new Error(`Template ${layerPin.url} acquired a different commit`);
    const bytes = await metadata.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
    const manifest = readTemplateManifest({
      readFile: (filePath) => (filePath === TEMPLATE_SOURCE_MANIFEST_PATH ? bytes : null),
      expectedSystemEpoch: input.expectedSystemEpoch,
    });
    if (!bytes) throw new Error(`Template ${layerPin.url} has no manifest bytes`);
    return {
      pin: layerPin,
      manifest,
      manifestText: new TextDecoder().decode(bytes),
      repositories: templateRepositories(metadata.files.map((file) => file.path)),
    };
  };
  const rootLayer = await readLayer(pin, root);
  const resolveTrack =
    input.resolveTrack ??
    (async () => {
      throw new Error(
        `Root template ${pin.url} declares dependencies, but this host cannot resolve their tracks`
      );
    });
  const acquired = new Map<string, Awaited<ReturnType<typeof readLayer>>>();
  const acquireLayer = async (layer: ResolvedTemplateDependency) => {
    const existing = acquired.get(layer.url);
    if (existing) return existing;
    const layerPin = {
      url: layer.url,
      ref: layer.ref,
      commit: layer.commit,
      ...(layer.credential ? { credential: layer.credential } : {}),
    } as WorkspaceTemplatePin;
    const entry = await readLayer(layerPin, await input.acquire(layerPin));
    acquired.set(layer.url, entry);
    return entry;
  };
  const resolved = await resolveTemplateDependencies({
    root: { label: pin.url, dependencies: rootLayer.manifest.dependencies },
    sourcePins:
      purpose === "use" &&
      input.releaseTemplates?.some((source) => sameWorkspaceTemplatePin(source, pin))
        ? input.releaseTemplates
        : undefined,
    resolveTrack,
    readDependencies: async (layer) => (await acquireLayer(layer)).manifest.dependencies,
  });
  // Dependency-first, with this template last: it is the one being installed.
  const stack = [
    ...resolved.layers.map((layer) => {
      const entry = acquired.get(layer.url);
      if (!entry) throw new Error(`Resolved template ${layer.url} has no metadata`);
      return entry;
    }),
    rootLayer,
  ];
  const sourceLayers = stack.map((entry) => ({
    label: entry.pin.url,
    manifest: entry.manifest,
    repositories: entry.repositories,
  }));
  // Validate overrides before selecting whole-unit trees, including deleted files.
  const merged = mergeTemplateManifests(sourceLayers);
  const owners = templateRepositoryOwners(sourceLayers);
  const document = {
    ...merged.document,
    template:
      purpose === "use"
        ? {
            dependencies: [
              { url: pin.url, ...(pin.credential ? { credential: pin.credential } : {}) },
            ],
          }
        : templateManifestDocument(rootLayer.manifest)["template"],
  };
  return {
    pin,
    purpose,
    expectedSystemEpoch: input.expectedSystemEpoch,
    layers: stack.map(({ pin, manifestText, repositories, manifest }) => ({
      pin,
      manifestText,
      repositories,
      dependencies: manifest.dependencies,
    })),
    dependencies: resolved.layers,
    document,
    repositoryOwners: [...owners].map(([repoPath, owner]) => ({ repoPath, source: owner.label })),
  };
}

/** Hydrate the already-resolved exact plan. No floating track is consulted
 * here, so cache lookup and source production refer to one captured closure. */
export async function composeResolvedTemplateLayerPlan(input: {
  plan: ResolvedTemplateLayerPlan;
  acquire(pin: WorkspaceTemplatePin): Promise<ExactGitSnapshot>;
}): Promise<{
  snapshot: ExactGitSnapshot;
  layers: ComposedTemplateLayer[];
  installation: WorkspaceTemplateInstallation;
}> {
  const { plan } = input;
  const { pin, purpose } = plan;
  const stack: Array<ResolvedTemplateLayerPlan["layers"][number] & { snapshot: ExactGitSnapshot }> =
    [];
  // Exact layers are independent immutable inputs. Bound full-snapshot
  // hydration to four layers because each retains all admitted source bytes.
  await forEachOwnedConcurrent(
    plan.layers.map((layer, index) => ({ layer, index })),
    4,
    async ({ layer, index }) => {
      const snapshot = await input.acquire(layer.pin);
      const manifestBytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
      if (
        snapshot.commit !== layer.pin.commit ||
        !manifestBytes ||
        new TextDecoder().decode(manifestBytes) !== layer.manifestText ||
        JSON.stringify(templateRepositories(snapshot.files.map((file) => file.path))) !==
          JSON.stringify(layer.repositories)
      )
        throw new Error(`Template ${layer.pin.url} does not match its resolved layer plan`);
      stack[index] = { ...layer, snapshot };
    }
  );
  const layers = stack.map((entry) => ({ ...entry.pin }));
  const installation: WorkspaceTemplateInstallation = {
    sources: stack.map((entry) => ({
      pin: entry.pin,
      manifest: entry.manifestText,
    })),
    ...(purpose === "use" ? {} : { upstream: pin }),
  };
  const manifestBytes = new TextEncoder().encode(canonicalTemplateYaml(plan.document));
  const composed = composeTemplateLayers({
    layers: stack.map((entry) => ({
      label: entry.pin.url,
      files: entry.snapshot.files.filter((file) => {
        if (file.path.startsWith("meta/")) return purpose !== "use" && entry.pin.url === pin.url;
        return plan.repositoryOwners.some(
          ({ repoPath, source }) => source === entry.pin.url && file.path.startsWith(`${repoPath}/`)
        );
      }),
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
  return { snapshot, layers, installation };
}

/** Full-snapshot callers use the same metadata resolution, retaining each
 * acquisition for hydration rather than fetching or resolving it twice. */
export async function composeDeclaredTemplateLayers(
  input: ComposeDeclaredTemplateLayersInput
): ReturnType<typeof composeResolvedTemplateLayerPlan> {
  const snapshots = new Map<string, ExactGitSnapshot>();
  const key = (pin: WorkspaceTemplatePin) => `${pin.url}\0${pin.commit}`;
  snapshots.set(key(input.pin), input.root);
  const plan = await resolveDeclaredTemplateLayerPlan({
    ...input,
    acquire: async (pin) => {
      const snapshot = await input.acquire(pin);
      snapshots.set(key(pin), snapshot);
      return snapshot;
    },
  });
  return composeResolvedTemplateLayerPlan({
    plan,
    acquire: async (pin) => {
      const snapshot = snapshots.get(key(pin));
      if (!snapshot) throw new Error(`Resolved template ${pin.url} has no acquired snapshot`);
      return snapshot;
    },
  });
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
function materializationReceipt(
  layers: readonly MaterializedLayer[],
  purpose: "use" | "author"
): {
  version: number;
  purpose: "use" | "author";
  layers: readonly MaterializedLayer[];
} {
  return { version: 3, purpose, layers };
}

const CREATION_DESCRIPTOR_PATH = "workspace-creation/v1.json";
const MATERIALIZATION_RECEIPT_PATH = "workspace-creation/materialization-v1.json";
const WORKSPACE_MANIFEST_PATH = "meta/vibestudio.yml";

export interface RootTemplateRepository {
  repoPath: string;
  subdir: string;
  snapshot: CanonicalSnapshotDigest;
  contentRoot: `state:${string}`;
  files: (ExactSnapshotFile & ContentDescriptor)[];
}

export interface PreparedRootTemplateInitialization {
  installation: WorkspaceTemplateInstallation;
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
  preparedTemplate?(
    pin: WorkspaceTemplatePin,
    purpose: "use" | "author"
  ): Promise<{
    record: PreparedWorkspaceTemplate;
    readFile(filePath: string): Uint8Array | null;
  } | null>;
  /**
   * Whether the host build designates this template as its own, and whether it
   * designated a local checkout rather than a fetched pin. Only a designated
   * template records host-build units, so a third-party template cannot claim
   * any of its units ship with Vibestudio.
   */
  releaseTemplates?: readonly WorkspaceTemplatePin[];
  /** Captured metadata closure owned by this preparation operation. */
  layerPlan?: ResolvedTemplateLayerPlan;
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
      .map((file) => {
        const bytes = snapshot.readFile(file.path);
        if (!bytes) throw new Error(`Root template source is missing ${file.path}`);
        return {
          ...file,
          ...intrinsicContentDescriptor(bytes),
          path: file.path.slice(prefix.length),
        };
      })
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
  private acquiredInstallation: WorkspaceTemplateInstallation | null = null;
  private preparedStateHash: string | null = null;
  private installedPackage: PreparedWorkspaceTemplate | null = null;

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
      logVerbose("Perf", "root template preparation", {
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

  /** Publish the already acquired byte identities once, without rescanning the
   * mutable source projection. Existing workspaces recover protected main. */
  async prepareBootstrapState(): Promise<string> {
    await this.prepareInitialization();
    if (this.preparedStateHash) return this.preparedStateHash;
    const snapshot = this.acquiredSnapshot;
    if (!snapshot) throw new Error("Root template acquisition produced no source snapshot");
    const encoded = repositoryContentTree(snapshot.files);
    for (const node of encoded.nodes) {
      const stored = await this.deps.sink.put(new TextEncoder().encode(node.canonicalText));
      const expected = node.treeHash;
      if (stored.digest !== treeHashDigest(expected)) {
        throw new Error("Content sink changed the bootstrap publication identity");
      }
    }
    const state = await this.deps.sink.put(
      new TextEncoder().encode(encoded.stateNode.canonicalText)
    );
    if (state.digest !== treeHashDigest(encoded.stateHash)) {
      throw new Error("Content sink changed the bootstrap publication identity");
    }
    this.preparedStateHash = encoded.stateHash;
    return encoded.stateHash;
  }

  /** Export the immutable install input, never a workspace database or grants. */
  preparedRecord(
    blobs: Array<{ digest: string; size: number }>,
    builds: PreparedWorkspaceTemplate["builds"]
  ): PreparedWorkspaceTemplate {
    const snapshot = this.acquiredSnapshot;
    const initialization = this.preparedInitialization;
    if (!snapshot || !initialization || !this.preparedStateHash)
      throw new Error("Template source preparation is incomplete");
    return {
      format: "vibestudio-prepared-workspace/1",
      purpose: this.readDescriptor().purpose ?? "use",
      pin: initialization.pin,
      layers: this.acquiredLayers,
      installation: initialization.installation,
      snapshot: snapshot.snapshot,
      files: snapshot.files,
      repositories: initialization.repositories,
      stateHash: this.preparedStateHash,
      blobs,
      builds,
    };
  }

  preparedBuildForContent(
    stateHash: string,
    unitPath: string
  ): { buildKey: string; effectiveVersion: string } | null {
    if (this.installedPackage?.stateHash !== stateHash) return null;
    return this.installedPackage.builds.find((build) => build.source === unitPath) ?? null;
  }

  /**
   * Lay any templates this one is built on underneath it, and merge what they
   * declare into the one manifest the composed workspace runs on.
   *
   * Composition records exact source provenance even without dependencies.
   */
  private async composeDeclaredLayers(
    pin: WorkspaceTemplatePin,
    root?: ExactGitSnapshot
  ): Promise<ExactGitSnapshot> {
    const composed = this.deps.layerPlan
      ? await composeResolvedTemplateLayerPlan({
          plan: this.deps.layerPlan,
          acquire: (layerPin) => this.deps.acquire(layerPin),
        })
      : await composeDeclaredTemplateLayers({
          pin,
          root:
            root ??
            (() => {
              throw new Error("Root template acquisition produced no snapshot");
            })(),
          purpose: this.readDescriptor().purpose ?? "use",
          releaseTemplates: this.deps.releaseTemplates,
          expectedSystemEpoch: this.deps.expectedSystemEpoch,
          acquire: (layerPin) => this.deps.acquire(layerPin),
          resolveTrack: async (address) => {
            const recorded = this.acquiredLayers.find(
              (layer) => normalizeTemplateGitUrl(layer.url) === normalizeTemplateGitUrl(address.url)
            );
            if (recorded) return { ref: recorded.ref, commit: recorded.commit };
            if (!this.deps.resolveTrack)
              throw new Error(
                `Root template ${pin.url} declares dependencies, but this host cannot resolve their tracks (${address.url})`
              );
            return this.deps.resolveTrack(address);
          },
        });
    this.acquiredLayers = composed.layers;
    this.acquiredInstallation = composed.installation;
    return composed.snapshot;
  }
  private async acquireInitialization(
    pin: WorkspaceTemplatePin
  ): Promise<PreparedRootTemplateInitialization> {
    const prepared = await this.deps.preparedTemplate?.(
      pin,
      this.readDescriptor().purpose ?? "use"
    );
    const plan = this.deps.layerPlan;
    if (
      plan &&
      (!sameWorkspaceTemplatePin(plan.pin, pin) ||
        plan.purpose !== (this.readDescriptor().purpose ?? "use") ||
        plan.expectedSystemEpoch !== this.deps.expectedSystemEpoch)
    )
      throw new Error("Resolved template layer plan does not match the creation coordinate");
    if (prepared) {
      const record = prepared.record;
      if (
        plan &&
        (record.layers.length !== plan.layers.length ||
          record.layers.some((layer, index) => {
            const expected = plan.layers[index];
            return !expected || !sameWorkspaceTemplatePin(layer, expected.pin);
          }))
      )
        throw new Error("Prepared template does not match its resolved layer plan");
      this.installedPackage = record;
      this.acquiredSnapshot = {
        commit: pin.commit,
        snapshot: record.snapshot as CanonicalSnapshotDigest,
        files: record.files,
        readFile: prepared.readFile,
      };
      this.acquiredLayers = record.layers;
      this.acquiredInstallation = record.installation;
      this.preparedStateHash = record.stateHash;
      return {
        pin,
        installation: record.installation,
        repositories: record.repositories.map((repository) => ({
          ...repository,
          snapshot: repository.snapshot as CanonicalSnapshotDigest,
          contentRoot: repository.contentRoot as `state:${string}`,
        })),
      };
    }
    const acquired = plan ? undefined : await this.deps.acquire(pin);
    if (acquired && acquired.commit !== pin.commit) {
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
    const manifestBytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
    if (!manifestBytes) throw new Error("Composed template has no manifest bytes");
    const manifestBlob = await this.deps.sink.put(manifestBytes);
    if (manifestBlob.digest !== sha256Hex(manifestBytes)) {
      throw new Error("Content sink changed the composed manifest identity");
    }
    await publishRepositoryContentTrees(repositories, this.deps.sink);
    this.acquiredSnapshot = snapshot;
    if (!this.acquiredInstallation)
      throw new Error("Root acquisition lost its installation baseline");
    return {
      installation: this.acquiredInstallation,
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
    if (
      recorded.at(-1)?.commit !== pin.commit ||
      recorded.at(-1)?.url !== pin.url ||
      (receipt as { purpose?: string }).purpose !== (this.readDescriptor().purpose ?? "use")
    ) {
      throw new Error("Workspace root materialization receipt does not match its exact pin");
    }
    this.acquiredLayers = [...recorded];
    const manifestPath = path.join(this.deps.sourcePath, WORKSPACE_MANIFEST_PATH);
    if (!fs.existsSync(manifestPath)) {
      throw new Error("Workspace root materialization receipt exists but its source is missing");
    }
    parseWorkspaceConfigContentWithId(
      fs.readFileSync(manifestPath, "utf8"),
      this.deps.workspaceId,
      (source) => fs.readFileSync(path.join(this.deps.sourcePath, source, "package.json"), "utf8")
    );
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
      this.deps.workspaceId,
      (source) => fs.readFileSync(path.join(staging, source, "package.json"), "utf8")
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
      `${JSON.stringify(materializationReceipt(this.acquiredLayers, this.readDescriptor().purpose ?? "use"), null, 2)}\n`,
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
